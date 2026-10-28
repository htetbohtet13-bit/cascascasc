import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, mock, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { MAX_MONEY, addMoney, money, subtractMoney } from "../server/money.mjs";
import { signedSkmResponse, verifySkmRequest } from "../server/skm-api.mjs";

// Every database and gateway operation in this suite is local or mocked.
const db = new PGlite();
let activeUserId;
let limitError = null;
let phoneSequence = 100000000;
let queryLog = [];
function clientFor(connection) {
  return { async query(sql, params) {
    queryLog.push(sql);
    const result = await connection.query(sql, params);
    return { rows: result.rows, rowCount: /^\s*select/i.test(sql) ? result.rows.length : result.affectedRows };
  } };
}
mock.module("../server/neon.mjs", { namedExports: {
  getPool: () => clientFor(db), withTransaction: (fn) => db.transaction((tx) => fn(clientFor(tx))),
} });
mock.module("../server/auth.mjs", { namedExports: { currentSession: async () => ({ user: { id: activeUserId } }) } });
mock.module("../server/rate-limit.mjs", { namedExports: { consumeRateLimit: async () => limitError } });
const { applyVerifiedDeposit, reserveWithdraw, releaseWithdraw, recordWithdrawTransfer, completeWithdraw } = await import("../server/wallet.mjs");
const { createSkmGameSession, processSkmWalletCallback } = await import("../server/skm-wallet.mjs");
const { handleWalletProxy } = await import("../server/wallet-proxy.mjs");

async function migration(name) {
  await db.exec((await readFile(new URL(`../neon/${name}`, import.meta.url), "utf8")).replace("create extension if not exists pgcrypto;", ""));
}
before(async () => {
  for (const name of ["001_app_schema.sql", "005_skm_seamless_wallet.sql", "008_deposit_wagering.sql", "010_money_constraints.sql"]) await migration(name);
});
beforeEach(async () => {
  await db.exec("truncate public.wallet_wagering_events, public.skm_wallet_transactions, public.skm_game_sessions, public.deposits, public.withdrawals, public.profiles restart identity cascade");
  limitError = null;
  queryLog = [];
});
after(async () => { await db.close(); });

async function player(balance = 0) {
  activeUserId = randomUUID();
  await db.query("insert into public.profiles (id,phone,balance) values ($1,$2,$3)", [activeUserId, `+959${phoneSequence++}`, String(balance)]);
  return { userId: activeUserId, ...await createSkmGameSession(activeUserId) };
}
async function balance(user) { return (await db.query("select balance::text from public.profiles where id=$1", [user.userId])).rows[0].balance; }
function deposit(user, amount, id = randomUUID()) { return applyVerifiedDeposit({ userId: user.userId, amount, orderId: id, transactionId: id, providerTransactionId: id, depositToken: "", serviceType: "kbzpay" }); }
function reserve(user, amount, orderId = randomUUID()) { return reserveWithdraw({ userId: user.userId, amount, orderId, serviceType: "kbzpay", phone: "09123456789" }); }
function event(user, amount = 100) { return { player_id: user.player_id, token: user.token, currency: "MMK", round_id: randomUUID(), transaction_id: randomUUID(), game_code: "goldencentury", reason: "BET_HOLD", amount }; }
const callback = (route, payload) => processSkmWalletCallback(route, payload, JSON.stringify(payload));
const credit = (debit, amount) => ({ ...debit, transaction_id: randomUUID(), debit_transaction_id: debit.transaction_id, amount, reason: "BET_SETTLE", round_closed: true });
const rollback = (debit) => ({ ...debit, transaction_id: randomUUID(), debit_transaction_id: debit.transaction_id });
const req = () => ({ method: "POST", headers: { origin: "https://www.j777ml.com", "content-type": "application/json" }, socket: { remoteAddress: "127.0.0.1" } });
function paymentEnv(t) {
  for (const [key, value] of Object.entries({ payment_secret: "test-key", kbzreceiver: "09123456789", wavereceiver: "09123456789", gameapibaseurl: "https://provider.invalid", operatorcode: "test-operator", gameproviderkey: "test-provider-secret" })) {
    const old = process.env[key]; process.env[key] = value;
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
  }
}
function withdrawPayload(overrides = {}) { return { service_type: "kbzpay", amount: 100, phone: "09123456789", request_id: randomUUID(), ...overrides }; }
const proxyWithdraw = (payload) => handleWalletProxy({ req: req(), functionName: "wallet-withdraw", payload });
function verified(overrides = {}) { return { success: true, message: "verified", data: { mode: "direct", provider: "kbzpay", account: "09123456789", transaction_id: "0100123456789", amount: 100, currency: "MMK", ...overrides } }; }
const proxyDeposit = (amount = 100) => handleWalletProxy({ req: req(), functionName: "wallet-deposit", payload: { service_type: "kbzpay", amount, transaction_id: "456789" } });

test("bounded arithmetic rejects malformed values and never rounds an overflow", () => {
  assert.equal(addMoney(MAX_MONEY - 2n, 2), Number(MAX_MONEY));
  assert.equal(subtractMoney(MAX_MONEY, MAX_MONEY - 1n), 1);
  for (const value of [true, null, "1e3", "01", "1.5", -1, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => money(value));
  assert.throws(() => addMoney(MAX_MONEY, 1));
  assert.throws(() => subtractMoney(0, 1));
});

test("deposit overflow leaves the wallet, receipt and wagering event unchanged", async () => {
  const user = await player(MAX_MONEY - 2n);
  assert.equal((await deposit(user, 2)).balance, Number(MAX_MONEY));
  await assert.rejects(() => deposit(user, 1), /range/);
  assert.equal(await balance(user), String(MAX_MONEY));
  assert.equal((await db.query("select count(*)::int as n from public.deposits")).rows[0].n, 1);
  assert.equal((await db.query("select count(*)::int as n from public.wallet_wagering_events where kind='DEPOSIT'")).rows[0].n, 1);
});

test("one verified receipt can credit only one order and one player", async () => {
  const first = await player(); const second = await player();
  const receipt = randomUUID();
  const claim = (user, orderId) => applyVerifiedDeposit({ userId: user.userId, amount: 100,
    orderId, transactionId: receipt, providerTransactionId: receipt, depositToken: "", serviceType: "kbzpay" });
  const orderId = randomUUID();
  assert.equal((await claim(first, orderId)).ok, true);
  assert.equal((await claim(first, orderId)).ok, true);
  assert.equal((await claim(first, randomUUID())).ok, false);
  assert.equal((await claim(second, randomUUID())).ok, false);
  assert.equal(await balance(first), "100"); assert.equal(await balance(second), "0");
  assert.equal((await db.query("select count(*)::int as n from public.deposits")).rows[0].n, 1);
});

test("simultaneous withdrawal requests reserve once and reject changed replay details", async () => {
  const user = await player(1000); const orderId = randomUUID();
  const results = await Promise.all([reserve(user, 100, orderId), reserve(user, 100, orderId), reserve(user, 200)]);
  assert.equal(results.filter((r) => r.state === "reserved").length, 1);
  assert.equal(results.filter((r) => r.state === "pending").length, 2);
  assert.equal((await reserve(user, 200, orderId)).ok, false);
  assert.equal(await balance(user), "900");
  assert.equal((await db.query("select count(*)::int as n from public.withdrawals")).rows[0].n, 1);
});

test("withdrawal and refund preserve the maximum supported balance exactly", async () => {
  const user = await player(MAX_MONEY);
  const orderId = randomUUID();
  assert.equal((await reserve(user, Number(MAX_MONEY - 1n), orderId)).balance, 1);
  assert.equal((await releaseWithdraw({ userId: user.userId, orderId, message: "rejected" })).balance, Number(MAX_MONEY));
  assert.equal(await balance(user), String(MAX_MONEY));
  assert.equal((await releaseWithdraw({ userId: user.userId, orderId, message: "repeated" })).balance, Number(MAX_MONEY));
});

test("an overflowing refund stays reserved rather than corrupting money", async () => {
  const user = await player(MAX_MONEY);
  const orderId = randomUUID();
  await reserve(user, 100, orderId);
  await deposit(user, 100);
  await assert.rejects(() => releaseWithdraw({ userId: user.userId, orderId, message: "rejected" }), /range/);
  assert.equal(await balance(user), String(MAX_MONEY));
  assert.equal((await db.query("select status from public.withdrawals where order_id=$1", [orderId])).rows[0].status, "pending");
});

test("acknowledged transfers cannot be refunded or replaced with different evidence", async () => {
  const user = await player(1000);
  const orderId = randomUUID(); await reserve(user, 100, orderId);
  assert.equal(await recordWithdrawTransfer({ userId: user.userId, orderId, providerTransactionId: "provider-1" }), true);
  assert.equal((await releaseWithdraw({ userId: user.userId, orderId, message: "rejected" })).state, "pending");
  assert.equal(await recordWithdrawTransfer({ userId: user.userId, orderId, providerTransactionId: "provider-2" }), false);
  assert.equal((await completeWithdraw({ userId: user.userId, orderId, providerTransactionId: "provider-2" })).ok, false);
  assert.equal((await completeWithdraw({ userId: user.userId, orderId, providerTransactionId: "provider-1" })).state, "paid");
  assert.equal((await releaseWithdraw({ userId: user.userId, orderId, message: "again" })).state, "paid");
  assert.equal(await balance(user), "900");
});

test("all wallet mutators acquire the player's profile before any ledger row lock", async () => {
  const user = await player(1000);
  const orderId = randomUUID();
  for (const action of [() => deposit(user, 1), () => reserve(user, 100, orderId),
    () => releaseWithdraw({ userId: user.userId, orderId, message: "rejected" }),
    () => recordWithdrawTransfer({ userId: user.userId, orderId, providerTransactionId: "id" }),
    () => completeWithdraw({ userId: user.userId, orderId, providerTransactionId: "id" })]) {
    queryLog = []; await action();
    assert.match(queryLog.find((sql) => /for update/i.test(sql)), /from public\.profiles/i);
  }
});

test("captured signed rollback replayed to debit cannot debit or suppress the refund", async (t) => {
  paymentEnv(t);
  const user = await player(1000); const debit = event(user);
  assert.equal((await callback("debit", debit)).status, "OK");
  const refund = rollback(debit);
  const signed = signedSkmResponse(refund);
  const headers = Object.fromEntries(Object.entries(signed.headers).map(([k,v]) => [k.toLowerCase(),v]));
  assert.equal(verifySkmRequest({ headers, rawBody: Buffer.from(signed.rawBody) }).ok, true);
  assert.equal((await processSkmWalletCallback("debit", refund, signed.rawBody)).status, "ERROR");
  assert.equal(await balance(user), "900");
  assert.equal((await processSkmWalletCallback("rollback", refund, signed.rawBody)).status, "OK");
  assert.equal((await processSkmWalletCallback("debit", refund, signed.rawBody)).status, "ERROR");
  assert.equal((await processSkmWalletCallback("rollback", refund, signed.rawBody)).status, "DUPLICATE");
  assert.equal(await balance(user), "1000");
});

test("an identical payload recorded under another kind is never a successful duplicate", async () => {
  const user = await player(1000); const debit = event(user);
  await callback("debit", debit);
  await db.query("update public.skm_wallet_transactions set kind='ROLLBACK',status='TOMBSTONE' where transaction_id=$1", [debit.transaction_id]);
  assert.equal((await callback("debit", debit)).status, "ERROR");
  assert.equal(await balance(user), "900");
});

test("settlements cannot close another round, game, reason or player", async () => {
  const user = await player(1000); const debit = event(user); await callback("debit", debit);
  for (const change of [{ round_id: "wrong" }, { game_code: "abcd" }, { reason: "BANK_RETURN" }, { currency: "USD" }]) {
    assert.equal((await callback("credit", { ...credit(debit, 100), ...change })).status, "ERROR");
    assert.equal(await balance(user), "900");
  }
  const other = await player(1000);
  assert.equal((await callback("credit", { ...credit(debit, 100), player_id: other.player_id, token: other.token })).status, "ERROR");
  assert.equal(await balance(other), "1000");
  assert.equal((await callback("credit", credit(debit, 100))).status, "OK");
  assert.equal(await balance(user), "1000");
});

test("rollback details must match the original debit before funds return", async () => {
  const user = await player(1000); const debit = event(user); await callback("debit", debit);
  for (const change of [{ round_id: "wrong" }, { game_code: "abcd" }, { reason: "BANK_DEPOSIT" }, { amount: 200 }]) {
    assert.equal((await callback("rollback", { ...rollback(debit), ...change })).status, "ERROR");
  }
  assert.equal(await balance(user), "900");
  assert.equal((await callback("rollback", rollback(debit))).status, "OK");
});

test("overflowing game credit stays open and can be reconciled without a partial credit", async () => {
  const user = await player(MAX_MONEY); const debit = event(user); await callback("debit", debit);
  assert.equal((await callback("credit", credit(debit, 101))).status, "ERROR");
  assert.equal(await balance(user), String(MAX_MONEY - 100n));
  assert.equal((await db.query("select status from public.skm_wallet_transactions where transaction_id=$1", [debit.transaction_id])).rows[0].status, "APPLIED");
  assert.equal((await callback("credit", credit(debit, 100))).status, "OK");
});

test("gateway verification metadata and amount mismatch never credit or disclose receipt amount", async (t) => {
  paymentEnv(t); const user = await player();
  let result = verified();
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(result), { status: 200 }));
  for (const changes of [{ provider: "wave" }, { account: "09999999999" }, { currency: "USD" }, { mode: "queue" }, { transaction_id: "different" }, { amount: "100" }]) {
    result = verified(changes); assert.equal((await proxyDeposit()).status, 502);
  }
  result = verified({ amount: 123456 });
  const mismatch = await proxyDeposit(1);
  assert.equal(mismatch.status, 400); assert.doesNotMatch(JSON.stringify(mismatch.body), /123456/);
  assert.equal(await balance(user), "0");
  result = verified(); assert.equal((await proxyDeposit()).status, 200);
  assert.equal(await balance(user), "100");
});

test("payment limits fail closed before invoking verification", async (t) => {
  paymentEnv(t); await player();
  const payment = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not call payment"); });
  for (const status of [429,503]) {
    limitError = { status, headers: { "Retry-After": "60" }, body: { error: "Limited" } };
    assert.deepEqual(await proxyDeposit(), limitError);
  }
  assert.equal(payment.mock.callCount(), 0);
});

test("only exact documented rejection codes and statuses return reserved funds", async (t) => {
  paymentEnv(t);
  let reply; let status;
  const payment = t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(reply), { status }));
  for (const entry of [
    { status: 400, code: "bad_phone", state: "failed" },
    { status: 400, code: "bad_amount", state: "failed" },
    { status: 400, code: "no_pin", state: "failed" },
    { status: 400, code: "pin_failed", state: "failed" },
    { status: 409, code: "account_not_connected", state: "failed" },
    { status: 500, code: "bad_phone", state: "pending" },
    { status: 400, code: "already_processed_bad_phone", state: "pending" },
    { status: 400, code: "bad_phone", message: "Transfer already processed", state: "pending" },
    { status: 400, code: "bad_phone", data: { transaction_id: "sent-txn" }, state: "pending" },
  ]) {
    const user = await player(1000); status = entry.status; reply = { success: false, message: entry.message ?? "Rejected", code: entry.code, data: entry.data };
    const payload = withdrawPayload(); const result = await proxyWithdraw(payload);
    assert.equal(result.body.state, entry.state, JSON.stringify(entry));
    assert.equal(await balance(user), entry.state === "failed" ? "1000" : "900");
    const before = payment.mock.callCount(); const repeated = await proxyWithdraw(payload);
    assert.equal(repeated.status, entry.state === "failed" ? 400 : 202);
    if (entry.state === "pending") assert.equal(repeated.body.state, "pending");
    assert.equal(payment.mock.callCount(), before);
  }
});

test("contradictory transfer statuses never release funds despite an exact rejection code", async (t) => {
  paymentEnv(t); let transferStatus;
  const payment = t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    success: false, code: "bad_phone", message: "Rejected", data: { status: transferStatus },
  }), { status: 400 }));
  // The gateway does not document any data.status value as proof that an error
  // was unsent, including an unexpected failure-looking status.
  for (transferStatus of ["pending", "unknown", "processing", "paid", "success", "failed"]) {
    const user = await player(1000); const payload = withdrawPayload();
    assert.equal((await proxyWithdraw(payload)).body.state, "pending", transferStatus);
    assert.equal(await balance(user), "900");
    const calls = payment.mock.callCount();
    assert.equal((await proxyWithdraw(payload)).body.state, "pending");
    assert.equal((await proxyWithdraw(withdrawPayload())).body.state, "pending");
    assert.equal(payment.mock.callCount(), calls);
  }
});

test("transfer success accepts matching evidence, preserves ambiguous or contradictory replies", async (t) => {
  paymentEnv(t); let reply; let status = 200;
  const payment = t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(reply), { status }));
  for (const entry of [
    { data: { transaction_id: randomUUID(), amount: 100, recipient: "959123456789", provider: "kbzpay", currency: "MMK", status: "success" }, state: "paid" },
    { data: { transaction_id: randomUUID() }, state: "paid" },
    { data: { transaction_id: randomUUID(), amount: 200 }, state: "pending" },
    { data: { transaction_id: randomUUID(), recipient: "09999999999" }, state: "pending" },
    { data: { transaction_id: randomUUID(), provider: "wave" }, state: "pending" },
    { data: { transaction_id: randomUUID(), currency: "USD" }, state: "pending" },
    { data: { transaction_id: randomUUID(), status: "pending" }, state: "pending" },
    { data: { transaction_id: randomUUID() }, code: "bad_phone", state: "pending" },
    { data: { transaction_id: randomUUID() }, status: 502, state: "pending" },
    { data: {}, state: "pending" },
  ]) {
    const user = await player(1000); status = entry.status ?? 200; reply = { success: true, message: "transfer_success", code: entry.code, data: entry.data };
    const payload = withdrawPayload(); const result = await proxyWithdraw(payload);
    assert.equal(result.body.state, entry.state, JSON.stringify(entry)); assert.equal(await balance(user), "900");
    if (entry.state === "pending" && status === 200 && entry.data.transaction_id) {
      assert.equal((await releaseWithdraw({ userId: user.userId, orderId: `WD${payload.request_id.replaceAll("-", "")}`, message: "must not refund" })).state, "pending");
      assert.equal(await balance(user), "900");
    }
    const before = payment.mock.callCount(); const repeated = await proxyWithdraw(payload);
    assert.equal(repeated.body.state, entry.state);
    assert.equal(payment.mock.callCount(), before);
    if (entry.state === "pending") { await proxyWithdraw(withdrawPayload()); assert.equal(payment.mock.callCount(), before); }
  }
});

test("only a complete unsent OTP challenge releases funds; network uncertainty stays held", async (t) => {
  paymentEnv(t); let reply = { success: true, message: "otp_required", data: { otp_required: true, tx_id: "challenge-1" } };
  let shouldThrow = false;
  t.mock.method(globalThis, "fetch", async () => { if (shouldThrow) throw new Error("network uncertain"); return new Response(JSON.stringify(reply), { status: 200 }); });
  let user = await player(1000); assert.equal((await proxyWithdraw(withdrawPayload())).body.state, "failed"); assert.equal(await balance(user), "1000");
  user = await player(1000); reply = { ...reply, data: { ...reply.data, transaction_id: "already-sent" } };
  assert.equal((await proxyWithdraw(withdrawPayload())).body.state, "pending"); assert.equal(await balance(user), "900");
  user = await player(1000); shouldThrow = true;
  assert.equal((await proxyWithdraw(withdrawPayload())).body.state, "pending"); assert.equal(await balance(user), "900");
});

test("safe-money migration is repeatable and refuses unsafe existing balances without rewriting them", async () => {
  await migration("010_money_constraints.sql");
  const user = await player();
  await db.exec("alter table public.profiles drop constraint profiles_balance_safe_integer");
  await db.query("update public.profiles set balance=$2 where id=$1", [user.userId, String(MAX_MONEY + 2n)]);
  await assert.rejects(() => reserve(user, 1), /range/);
  await assert.rejects(() => migration("010_money_constraints.sql"));
  await db.exec("rollback");
  assert.equal(await balance(user), String(MAX_MONEY + 2n));
  await db.query("update public.profiles set balance=0 where id=$1", [user.userId]);
  await migration("010_money_constraints.sql");
  await assert.rejects(() => db.query("update public.profiles set balance=$2 where id=$1", [user.userId, String(MAX_MONEY + 1n)]));
});
