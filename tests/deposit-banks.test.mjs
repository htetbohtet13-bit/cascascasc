import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, mock, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
let userId;
let queryFault;
let phone = 111111100;
const clientFor = (connection) => ({ async query(sql, params) {
  queryFault?.(sql);
  const result = await connection.query(sql, params);
  return { rows: result.rows, rowCount: /^\s*select/i.test(sql) ? result.rows.length : result.affectedRows };
} });
const pool = clientFor(db);
mock.module("../server/neon.mjs", { namedExports: { getPool: () => pool, withTransaction: (fn) => db.transaction(tx => fn(clientFor(tx))) } });
mock.module("../server/auth.mjs", { namedExports: { currentSession: async () => userId ? { user: { id: userId } } : null } });
mock.module("../server/rate-limit.mjs", { namedExports: { consumeRateLimit: async () => null } });
const { handleAdminApi } = await import("../server/admin-api.mjs");
const { handleWalletProxy } = await import("../server/wallet-proxy.mjs");
const { readDepositBanks } = await import("../server/deposit-banks.mjs");
const { reserveWithdraw } = await import("../server/wallet.mjs");
const env = { admin_secret: "test-bank-switch-admin-secret", ADMIN_MFA_REQUIRED: "false", payment_secret: "test-payment-key", PAYMENT_API_URL: "https://payment.example.test", kbzreceiver: "09123456789", kbzname: "Test KBZ", wavereceiver: "09987654321", wavename: "Test Wave" };
const saved = Object.fromEntries([...Object.keys(env), "ADMIN_TOTP_SECRET"].map(k => [k, process.env[k]]));
async function migration(name) { await db.exec((await readFile(new URL(`../neon/${name}`, import.meta.url), "utf8")).replaceAll("create extension if not exists pgcrypto;", "")); }
before(async () => {
  for (const file of ["001_app_schema.sql", "002_phone_auth.sql", "005_skm_seamless_wallet.sql", "008_deposit_wagering.sql", "009_auth_security.sql", "010_money_constraints.sql", "012_game_minor_units.sql", "013_first_deposit_bonus.sql", "015_withdrawal_resolution.sql", "016_deposit_bank_settings.sql", "017_withdrawal_approval.sql"]) await migration(file);
  Object.assign(process.env, env); delete process.env.ADMIN_TOTP_SECRET;
});
beforeEach(async () => {
  queryFault = undefined; userId = undefined;
  await db.exec("truncate public.profiles cascade; delete from public.auth_admin_sessions; update public.deposit_bank_settings set is_enabled=true");
});
after(async () => { for (const [k,v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } await db.close(); });
const request = (body, cookie = "", method = "POST", origin = "https://www.j777ml.com") => ({ method, url: "/api/admin?view=deposit_banks", headers: { origin, "content-type": "application/json", cookie }, body });
async function login() {
  const result = await handleAdminApi(request({ action: "login", password: env.admin_secret }));
  assert.equal(result.status, 200); return result.headers["Set-Cookie"].split(";")[0];
}
const set = (cookie, service_type, enabled) => handleAdminApi(request({ action: "set_deposit_bank", service_type, enabled }, cookie));
async function player(balance = 0) { userId = randomUUID(); await db.query("insert into public.profiles(id,phone,balance) values($1,$2,$3)", [userId, `+959${phone++}`, balance]); return userId; }
const proxy = (functionName, payload = {}) => handleWalletProxy({ req: request({}), functionName, payload });
const deposit = (extra = {}) => proxy("wallet-deposit", { service_type: "kbzpay", amount: 1000, transaction_id: "123456", bonus_terms_version: 1, ...extra });
const verified = () => new Response(JSON.stringify({ success: true, message: "verified", data: { mode: "direct", provider: "kbzpay", account: env.kbzreceiver, transaction_id: "01000000123456", amount: 1000, currency: "MMK" } }));
const withdrawal = (amount, service_type = "kbzpay") => ({ amount, service_type, phone: "09123456789", request_id: randomUUID() });
const decisionBody = (orderId, amount, decision) => ({
  action: "resolve_withdrawal", order_id: orderId, decision, request_id: randomUUID(),
  expected_amount: String(amount), confirmation_amount: String(amount), password: env.admin_secret,
});
const decide = (cookie, body) => handleAdminApi(request(body, cookie));

test("exactly 400000 pays automatically; above it only an admin approval can send the original reserved payout once", async (t) => {
  await player(1500000);
  const cookie = await login();
  let startPayout;
  let finishPayout;
  const payoutStarted = new Promise(resolve => { startPayout = resolve; });
  const fetch = t.mock.method(globalThis, "fetch", async (_url, options) => {
    const { amount, phone, provider } = JSON.parse(options.body);
    if (amount === 1000000) {
      startPayout();
      await new Promise(resolve => { finishPayout = resolve; });
    }
    return new Response(JSON.stringify({ success: true, message: "transfer_success", data: { transaction_id: randomUUID(), amount, recipient: phone, provider } }));
  });
  assert.equal((await proxy("wallet-withdraw", withdrawal(400000))).body.state, "paid");
  const large = withdrawal(1000000, "wavepay");
  const held = await proxy("wallet-withdraw", { ...large, decision: "approve" });
  assert.equal(held.body.state, "awaiting_approval");
  assert.equal(held.body.balance, 100000);
  assert.equal((await proxy("wallet-withdraw", large)).body.state, "awaiting_approval");
  const list = await handleAdminApi({ ...request(null, cookie, "GET"), url: "/api/admin?view=withdrawals&status=awaiting_approval" });
  assert.equal(list.body.total, 1);
  assert.equal(list.body.withdrawals[0].order_id, held.body.orderId);
  const decision = decisionBody(held.body.orderId, large.amount, "approve");
  assert.equal((await decide("", decision)).status, 401);
  assert.equal((await decide(cookie, { ...decision, confirmation_amount: "1" })).status, 400);
  await set(cookie, "wavepay", false);
  assert.equal((await decide(cookie, decision)).body.code, "BANK_UNAVAILABLE");
  assert.equal(fetch.mock.callCount(), 1);
  await set(cookie, "wavepay", true);
  const approving = decide(cookie, decision);
  await Promise.race([payoutStarted, approving.then(result => { assert.fail(`Approval stopped before payout with status ${result.status}`); })]);
  const attempts = await Promise.all([decide(cookie, decision), decide(cookie, { ...decision, decision: "decline" })]);
  finishPayout();
  assert.ok(attempts.every(result => result.status === 409));
  assert.equal((await approving).body.withdrawal.status, "paid");
  const finished = (await proxy("wallet-withdraw", large)).body;
  assert.equal(finished.state, "paid");
  assert.equal(finished.balance, 100000);
  assert.equal(fetch.mock.callCount(), 2);
  assert.deepEqual(JSON.parse(fetch.mock.calls[1].arguments[1].body), { cmd: "transfer", provider: "wave", account: env.wavereceiver, phone: large.phone, amount: large.amount, note: "payment" });
});

test("decline refunds exactly once, is visible in player history and sends no payment", async (t) => {
  const id = await player(700000);
  await db.query("update public.profiles set balance_minor = 60 where id=$1", [id]);
  const cookie = await login();
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("No payout expected"); });
  const payout = withdrawal(400001);
  const held = (await proxy("wallet-withdraw", payout)).body;
  assert.equal((await proxy("wallet-history")).body.history[0].status, "awaiting_approval");
  await migration("017_withdrawal_approval.sql");
  assert.equal((await proxy("wallet-withdraw", payout)).body.state, "awaiting_approval");
  const decision = decisionBody(held.orderId, payout.amount, "decline");
  const attempts = await Promise.all([decide(cookie, decision), decide(cookie, decision)]);
  assert.equal(attempts.filter(result => result.status === 200).length, 1);
  assert.equal((await decide(cookie, { ...decision, decision: "approve" })).status, 409);
  assert.equal((await proxy("wallet-history")).body.history[0].status, "declined");
  assert.equal((await proxy("wallet-withdraw", payout)).body.state, "declined");
  assert.deepEqual((await db.query("select balance::text, balance_minor from public.profiles where id=$1", [id])).rows[0], { balance: "700000", balance_minor: 60 });
  assert.equal(fetch.mock.callCount(), 0);
});

test("an uncertain approved payout cannot be sent again or immediately refunded even for an old request", async (t) => {
  await player(600000);
  const cookie = await login();
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("Uncertain payment outcome"); });
  const payout = withdrawal(500000);
  const held = (await proxy("wallet-withdraw", payout)).body;
  await db.query("update public.withdrawals set created_at = now() - interval '1 day' where order_id=$1", [held.orderId]);
  const decision = decisionBody(held.orderId, payout.amount, "approve");
  const refund = { ...decision, decision: "refund", checked_provider: true, reason: "Test manual reconciliation" };
  assert.equal((await decide(cookie, refund)).body.code, "APPROVAL_REQUIRED");
  const result = await decide(cookie, decision);
  assert.equal(result.status, 200);
  assert.equal(result.body.withdrawal.status, "pending");
  assert.equal(result.body.canRefund, false);
  assert.equal((await decide(cookie, refund)).body.code, "STILL_PROCESSING");
  assert.equal((await decide(cookie, decision)).status, 409);
  assert.equal((await proxy("wallet-withdraw", payout)).body.state, "pending");
  assert.equal(fetch.mock.callCount(), 1);
});

test("bank settings require a current admin session and trusted origin; rejected changes leave both banks enabled", async () => {
  assert.equal((await set("", "kbzpay", false)).status, 401);
  assert.equal((await handleAdminApi(request(null, "", "GET"))).status, 401);
  const cookie = await login();
  assert.equal((await handleAdminApi(request({ action: "set_deposit_bank", service_type: "kbzpay", enabled: false }, cookie, "POST", "https://evil.invalid"))).status, 403);
  await db.exec("delete from public.auth_admin_sessions");
  assert.equal((await set(cookie, "kbzpay", false)).status, 401);
  assert.equal((await readDepositBanks()).kbzpay.enabled, true);
});

test("admin can explicitly pause and reopen either bank; replaying a state never toggles it back", async () => {
  const cookie = await login();
  for (const bank of ["kbzpay", "wavepay"]) {
    const paused = await set(cookie, bank, false);
    assert.equal(paused.status, 200); assert.equal(paused.body.banks[bank].enabled, false);
    assert.equal((await set(cookie, bank, false)).body.banks[bank].enabled, false);
    const read = await handleAdminApi(request(null, cookie, "GET"));
    assert.equal(read.body.banks[bank].enabled, false);
    assert.equal((await set(cookie, bank, true)).body.banks[bank].enabled, true);
  }
  for (const [bank, value] of [["other", false], ["kbzpay", "false"], ["wavepay", 0], ["kbzpay' OR true --", true]]) assert.equal((await set(cookie, bank, value)).status, 400);
});

test("public deposit config marks paused banks unavailable and hides their receiver details", async () => {
  await player(); const cookie = await login(); await set(cookie, "kbzpay", false);
  const result = await proxy("wallet-config");
  assert.equal(result.status, 200); assert.equal(result.body.kbzpay.enabled, false);
  assert.equal(result.body.kbzpay.receiver, ""); assert.equal(result.body.kbzpay.name, "");
  assert.equal(result.body.wavepay.enabled, true); assert.equal(result.body.wavepay.receiver, env.wavereceiver);
});

test("paused bank rejects stale forms and forged enabled flags before invoking payment verification", async (t) => {
  await player(); const cookie = await login(); await set(cookie, "kbzpay", false);
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("Paused bank must not call payment"); });
  const result = await deposit({ enabled: true, bank_enabled: true });
  assert.equal(result.status, 409); assert.equal(result.body.code, "BANK_UNAVAILABLE");
  assert.match(result.body.error, /ယာယီ/); assert.equal(fetch.mock.callCount(), 0);
  assert.equal((await db.query("select count(*)::int as n from public.deposits")).rows[0].n, 0);
  assert.equal((await db.query("select balance::text from public.profiles where id=$1", [userId])).rows[0].balance, "0");
});

test("an enabled bank still verifies and credits normally; a pause during verification does not lose that credit", async (t) => {
  await player(); const cookie = await login();
  let enter; let finish;
  const entered = new Promise(resolve => { enter = resolve; });
  const fetch = t.mock.method(globalThis, "fetch", () => { enter(); return new Promise(resolve => { finish = resolve; }); });
  const pending = deposit(); await entered;
  await set(cookie, "kbzpay", false); finish(verified());
  const result = await pending;
  assert.equal(result.status, 200); assert.equal(result.body.balance, 1000);
  assert.equal((await deposit()).body.code, "BANK_UNAVAILABLE"); assert.equal(fetch.mock.callCount(), 1);
  await set(cookie, "kbzpay", true);
  t.mock.method(globalThis, "fetch", async () => verified());
  assert.equal((await deposit()).status, 400); // Original receipt cannot credit twice.
  assert.equal((await db.query("select balance::text from public.profiles where id=$1", [userId])).rows[0].balance, "1000");
});

test("bank lookup failures and missing configuration rows fail closed without contacting payment", async (t) => {
  await player(); const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("No verification allowed"); });
  queryFault = sql => { if (sql.includes("from public.deposit_bank_settings")) throw new Error("Test outage"); };
  assert.equal((await deposit()).body.code, "BANK_STATUS_UNAVAILABLE");
  assert.equal((await proxy("wallet-withdraw", { service_type: "kbzpay", amount: 1000, phone: "09123456789", request_id: randomUUID() })).status, 500);
  queryFault = undefined;
  await db.query("delete from public.deposit_bank_settings where service_type='wavepay'");
  assert.equal((await deposit()).body.code, "BANK_STATUS_UNAVAILABLE");
  assert.equal((await proxy("wallet-withdraw", { service_type: "wavepay", amount: 1000, phone: "09123456789", request_id: randomUUID() })).status, 500);
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal((await db.query("select count(*)::int as n from public.withdrawals")).rows[0].n, 0);
  await migration("016_deposit_bank_settings.sql");
});

test("migration reruns preserve paused settings and money; paused banks block new withdrawal reservations", async () => {
  const id = await player(10000); const cookie = await login(); await set(cookie, "kbzpay", false);
  await migration("016_deposit_bank_settings.sql");
  assert.equal((await readDepositBanks()).kbzpay.enabled, false);
  assert.equal((await db.query("select balance::text from public.profiles where id=$1", [id])).rows[0].balance, "10000");
  const result = await reserveWithdraw({ userId: id, amount: 1000, serviceType: "kbzpay", phone: "09123456789", orderId: randomUUID() });
  assert.equal(result.ok, false); assert.equal(result.code, "BANK_UNAVAILABLE");
  assert.equal((await db.query("select balance::text from public.profiles where id=$1", [id])).rows[0].balance, "10000");
  assert.equal((await db.query("select count(*)::int as n from public.withdrawals")).rows[0].n, 0);
  await set(cookie, "kbzpay", true);
  assert.equal((await reserveWithdraw({ userId: id, amount: 1000, serviceType: "kbzpay", phone: "09123456789", orderId: randomUUID() })).state, "reserved");
});

test("both bank switches block deposit and withdrawal APIs before deductions or gateway calls", async (t) => {
  const id = await player(10000); const cookie = await login();
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("No gateway call for a paused bank"); });
  for (const service_type of ["kbzpay", "wavepay"]) {
    await set(cookie, service_type, false);
    assert.equal((await deposit({ service_type })).body.code, "BANK_UNAVAILABLE");
    const result = await proxy("wallet-withdraw", { service_type, amount: 1000, phone: "09123456789", request_id: randomUUID(), enabled: true });
    assert.equal(result.status, 409); assert.equal(result.body.code, "BANK_UNAVAILABLE"); assert.match(result.body.error, /ယာယီ/);
  }
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal((await db.query("select balance::text from public.profiles where id=$1", [id])).rows[0].balance, "10000");
  assert.equal((await db.query("select count(*)::int as n from public.withdrawals")).rows[0].n, 0);
});

test("a payout accepted before a bank pause finishes once; paid replays still return success while paused", async (t) => {
  await player(10000); const cookie = await login(); let enter; let finish;
  const entered = new Promise(resolve => { enter=resolve; });
  const fetch = t.mock.method(globalThis, "fetch", () => { enter(); return new Promise(resolve => { finish=resolve; }); });
  const payload = { service_type: "kbzpay", amount: 1000, phone: "09123456789", request_id: randomUUID() };
  const pending = proxy("wallet-withdraw", payload); await entered;
  await set(cookie, "kbzpay", false);
  finish(new Response(JSON.stringify({ success: true, message: "transfer_success", data: { transaction_id: "test-switch-payout", amount: 1000, recipient: payload.phone, provider: "kbzpay", currency: "MMK", status: "success" } })));
  const paid = await pending; assert.equal(paid.body.state, "paid"); assert.equal(paid.body.balance, 9000);
  assert.equal((await proxy("wallet-withdraw", payload)).body.state, "paid");
  assert.equal((await proxy("wallet-withdraw", { ...payload, request_id: randomUUID() })).body.code, "BANK_UNAVAILABLE");
  assert.equal(fetch.mock.callCount(), 1);
});
