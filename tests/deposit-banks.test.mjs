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
  for (const file of ["001_app_schema.sql", "002_phone_auth.sql", "005_skm_seamless_wallet.sql", "008_deposit_wagering.sql", "009_auth_security.sql", "010_money_constraints.sql", "012_game_minor_units.sql", "013_first_deposit_bonus.sql", "016_deposit_bank_settings.sql"]) await migration(file);
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
