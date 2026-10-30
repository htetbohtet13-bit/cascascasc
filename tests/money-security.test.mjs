import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, mock, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { Readable } from "node:stream";
import { MAX_MONEY, addMoney, money, subtractMoney } from "../server/money.mjs";
import { signedSkmResponse, verifySkmRequest } from "../server/skm-api.mjs";

// Every database and gateway operation in this suite is local or mocked.
const db = new PGlite();
let activeUserId;
let limitError = null;
let phoneSequence = 100000000;
let queryLog = [];
let queryFault;
const payoutKeys = ["WITHDRAWALS_ENABLED", "WITHDRAW_MAX_AMOUNT_MMK", "WITHDRAW_MAX_PER_DAY"];
const savedPayoutEnv = Object.fromEntries(payoutKeys.map((key) => [key, process.env[key]]));
function clientFor(connection) {
  return { async query(sql, params) {
    queryLog.push(sql);
    if (queryFault) queryFault(sql);
    const result = await connection.query(sql, params);
    return { rows: result.rows, rowCount: /^\s*select/i.test(sql) ? result.rows.length : result.affectedRows };
  } };
}
mock.module("../server/neon.mjs", { namedExports: {
  getPool: () => clientFor(db), withTransaction: (fn) => db.transaction((tx) => fn(clientFor(tx))),
} });
mock.module("../server/auth.mjs", { namedExports: { currentSession: async () => activeUserId ? ({ user: { id: activeUserId } }) : null } });
mock.module("../server/rate-limit.mjs", { namedExports: { consumeRateLimit: async () => limitError } });
const { applyVerifiedDeposit, reserveWithdraw, releaseWithdraw, recordWithdrawTransfer, completeWithdraw } = await import("../server/wallet.mjs");
const { createSkmGameSession, processSkmWalletCallback } = await import("../server/skm-wallet.mjs");
const { handleWalletProxy } = await import("../server/wallet-proxy.mjs");
const { default: withdrawHandler } = await import("../api/wallet/withdraw.js");
const { default: depositHandler, config: depositHandlerConfig } = await import("../api/wallet/deposit.js");
const { handleSkmWallet } = await import("../api/_skm-wallet.js");

async function migration(name) {
  await db.exec((await readFile(new URL(`../neon/${name}`, import.meta.url), "utf8")).replace("create extension if not exists pgcrypto;", ""));
}
before(async () => {
  mock.method(console, "info", () => {});
  for (const name of ["001_app_schema.sql", "005_skm_seamless_wallet.sql", "008_deposit_wagering.sql", "010_money_constraints.sql", "012_game_minor_units.sql"]) await migration(name);
});
beforeEach(async () => {
  await db.exec("truncate public.wallet_wagering_events, public.skm_wallet_transactions, public.skm_game_sessions, public.deposits, public.withdrawals, public.profiles restart identity cascade");
  limitError = null;
  queryLog = [];
  queryFault = undefined;
  activeUserId = undefined;
  for (const key of payoutKeys) delete process.env[key];
});
after(async () => {
  for (const [key, value] of Object.entries(savedPayoutEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await db.close();
});

async function player(balance = 0) {
  activeUserId = randomUUID();
  await db.query("insert into public.profiles (id,phone,balance) values ($1,$2,$3)", [activeUserId, `+959${phoneSequence++}`, String(balance)]);
  return { userId: activeUserId, ...await createSkmGameSession(activeUserId) };
}
async function balance(user) { return (await db.query("select balance::text from public.profiles where id=$1", [user.userId])).rows[0].balance; }
function deposit(user, amount, id = randomUUID()) { return applyVerifiedDeposit({ userId: user.userId, amount, orderId: id, transactionId: id, providerTransactionId: id, depositToken: "", serviceType: "kbzpay" }); }
function reserve(user, amount, orderId = randomUUID()) { return reserveWithdraw({ userId: user.userId, amount, orderId, serviceType: "kbzpay", phone: "09123456789" }); }
function event(user, amount = 100) { return { player_id: user.player_id, token: user.token, currency: "MMK", round_id: randomUUID(), transaction_id: randomUUID(), game_code: "goldencentury", reason: "BET_HOLD", amount }; }
// Existing business fixtures are in app kyat; wire fixtures use minor units.
const providerPayload = (payload) => ({ ...payload,
  ...(typeof payload.amount === "number" ? { amount: payload.amount * 100 } : {}),
  ...(typeof payload.stake === "number" ? { stake: payload.stake * 100 } : {}),
});
const callback = (route, payload) => {
  const wire = providerPayload(payload);
  return processSkmWalletCallback(route, wire, JSON.stringify(wire));
};
const credit = (debit, amount) => ({ ...debit, transaction_id: randomUUID(), debit_transaction_id: debit.transaction_id, amount, reason: "BET_SETTLE", round_closed: true });
const rollback = (debit) => ({ ...debit, transaction_id: randomUUID(), debit_transaction_id: debit.transaction_id });
const req = () => ({ method: "POST", headers: { origin: "https://www.j777ml.com", "content-type": "application/json" }, socket: { remoteAddress: "127.0.0.1" } });
function paymentEnv(t) {
  for (const [key, value] of Object.entries({ payment_secret: "test-key", kbzreceiver: "09123456789", wavereceiver: "09123456789", gameapibaseurl: "https://provider.invalid", operatorcode: "test-operator", gameproviderkey: "test-provider-secret" })) {
    const old = process.env[key]; process.env[key] = value;
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
  }
}
function payoutEnv(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const original = process.env[key]; process.env[key] = value;
    t.after(() => { if (original === undefined) delete process.env[key]; else process.env[key] = original; });
  }
}
function response() {
  return { headers: {}, setHeader(name, value) { this.headers[name.toLowerCase()] = value; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, end(raw) { this.body = JSON.parse(String(raw)); return this; } };
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

test("withdrawal and refund preserve the maximum supported balance exactly", async (t) => {
  payoutEnv(t, { WITHDRAW_MAX_AMOUNT_MMK: String(MAX_MONEY) });
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
  const refund = providerPayload(rollback(debit));
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
  const maxGameKyat = MAX_MONEY / 100n;
  const user = await player(maxGameKyat); const debit = event(user); await callback("debit", debit);
  assert.equal((await callback("credit", credit(debit, 101))).status, "ERROR");
  assert.equal(await balance(user), String(maxGameKyat - 100n));
  assert.equal((await db.query("select status from public.skm_wallet_transactions where transaction_id=$1", [debit.transaction_id])).rows[0].status, "APPLIED");
  assert.equal((await callback("credit", credit(debit, 100))).status, "OK");
});

test("gateway verification metadata and amount mismatch never credit or disclose receipt amount", async (t) => {
  paymentEnv(t); const user = await player();
  let result = verified();
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(result), { status: 200 }));
  for (const changes of [{ provider: "wave" }, { account: "09999999999" }, { currency: "USD" }, { mode: "queue" }, { transaction_id: "different" }, { amount: "100" }]) {
    result = verified({ currency: "Ks", ...changes }); assert.equal((await proxyDeposit()).status, 502);
  }
  result = verified({ currency: "Ks", amount: 123456 });
  const mismatch = await proxyDeposit(1);
  assert.equal(mismatch.status, 400); assert.doesNotMatch(JSON.stringify(mismatch.body), /123456/);
  assert.equal(await balance(user), "0");
  result = verified(); assert.equal((await proxyDeposit()).status, 200);
  assert.equal(await balance(user), "100");
});

test("verified deposit tolerates equivalent provider label casing while recording one trace through wallet credit", async (t) => {
  paymentEnv(t); const user = await player();
  const logs = [];
  t.mock.method(console, "info", (...args) => logs.push(args));
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    success: true, message: " Verified ", data: { ...verified().data, transaction_id: "01000000000000456789", provider: "KBZPay", mode: "Direct", currency: "mmk", sender: "private-test-sender" },
  })));
  const res = response();
  await depositHandler({ ...req(), body: { service_type: "kbzpay", amount: 100, transaction_id: "456789" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(await balance(user), "100");
  assert.equal((await db.query("select transaction_id from public.deposits")).rows[0].transaction_id, "01000000000000456789");
  assert.match(res.headers["x-deposit-trace-id"], /^[0-9a-f-]{36}$/);
  const trace = res.headers["x-deposit-trace-id"];
  assert.ok(logs.every((entry) => entry[1].trace_id === trace));
  assert.deepEqual(logs.filter((entry) => entry[0] === "Deposit processing").map((entry) => entry[1].event),
    ["verification_started", "verification_response", "wallet_credit_started", "wallet_credit_completed"]);
  const logged = JSON.stringify(logs);
  for (const privateValue of ["test-key", "09123456789", "01000000000000456789", "private-test-sender", user.userId]) assert.ok(!logged.includes(privateValue));
});

test("MMK and MyanPay Ks deposits tolerate display marks and never credit the same receipt twice", async (t) => {
  paymentEnv(t);
  let result;
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(result)));
  for (const currency of ["MMK", "Ks", " ks ", "\u200EKs\u200F", " mmk ", "\u200BMMK\u200B", "\u200EMMK\u200F", "\u2066MMK\u2069", "\uFEFFMMK", "M\u200BMK"]) {
    const user = await player();
    result = verified({ currency, transaction_id: `${randomUUID()}456789` });
    assert.equal((await proxyDeposit()).status, 200);
    assert.equal(await balance(user), "100");
    assert.equal((await proxyDeposit()).status, 400);
    assert.equal(await balance(user), "100");
  }
});

test("unknown, missing and malformed deposit currencies stay rejected with bounded currency diagnostics", async (t) => {
  paymentEnv(t); const user = await player();
  let result;
  const logs = [];
  t.mock.method(console, "info", (...args) => logs.push(args));
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(result)));
  for (const currency of [undefined, null, "", "USD", "\u200BUSD\u200B", "MMKUSD", "KsUSD", "K s", "Ks\u0000", "M MK", "MMK\u0000", "ＭＭＫ", "MMK" + "\u200B".repeat(33)]) {
    result = verified({ currency });
    assert.equal((await proxyDeposit()).status, 502);
    assert.equal(await balance(user), "0");
  }
  const rejected = logs.filter((entry) => entry[1].event === "verification_fields_rejected");
  assert.ok(rejected.every((entry) => entry[1].invalid_fields.includes("currency")));
  assert.ok(rejected.every((entry) => !entry[1].currency_code_points || entry[1].currency_code_points.length <= 16));
  assert.ok(rejected.some((entry) => JSON.stringify(entry[1].currency_code_points) === JSON.stringify(["U+0055", "U+0053", "U+0044"])));
  assert.equal(rejected.at(-1)[1].currency_truncated, true);
  assert.ok(!JSON.stringify(logs).includes("test-key"));
  assert.ok(!JSON.stringify(logs).includes("0100123456789"));
});

test("a bank check slower than the old deadline retains a response budget and time to commit the deposit", async (t) => {
  paymentEnv(t); const user = await player();
  let budget;
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  t.mock.method(AbortSignal, "timeout", (milliseconds) => { budget = milliseconds; return new AbortController().signal; });
  t.mock.method(globalThis, "fetch", async () => {
    // Simulate a 45-second bank lookup without making the test wait or call a bank.
    clock += 45000;
    if (budget <= 45000) throw new DOMException("Simulated bank check timeout", "TimeoutError");
    return new Response(JSON.stringify(verified()));
  });
  assert.equal((await proxyDeposit()).status, 200);
  assert.equal(await balance(user), "100");
  assert.ok(depositHandlerConfig.maxDuration * 1000 >= budget + 20000);
  const deployed = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.equal(deployed.functions["api/wallet/deposit.js"].maxDuration, depositHandlerConfig.maxDuration);
});

test("incomplete verification logs rejected field names and types without crediting or disclosing values", async (t) => {
  paymentEnv(t); const user = await player();
  const logs = [];
  t.mock.method(console, "info", (...args) => logs.push(args));
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(verified({ amount: "100", account: undefined }))));
  const result = await proxyDeposit();
  assert.equal(result.status, 502);
  assert.equal(result.body.code, "PAYMENT_VERIFICATION_INCOMPLETE");
  const rejected = logs.find((entry) => entry[1].event === "verification_fields_rejected")[1];
  assert.deepEqual(rejected.invalid_fields, ["amount_type_or_range", "account"]);
  assert.equal(rejected.field_types.amount, "string");
  assert.equal(rejected.field_types.account, "undefined");
  assert.ok(!JSON.stringify(logs).includes("0100123456789"));
  assert.ok(!JSON.stringify(logs).includes("test-key"));
  assert.equal(await balance(user), "0");
});

test("HTML or invalid gateway replies and network failures are traceable without inventing a verified deposit", async (t) => {
  paymentEnv(t); const user = await player();
  let reply = "<!DOCTYPE html><html>upstream failure</html>";
  let network = false;
  const logs = [];
  t.mock.method(console, "info", (...args) => logs.push(args));
  t.mock.method(globalThis, "fetch", async () => {
    if (network) throw Object.assign(new Error("private-upstream-text"), { cause: { code: "private-key-value" } });
    return new Response(reply, { status: 502 });
  });
  for (reply of ["<!DOCTYPE html><html>upstream failure</html>", "null", "[]"]) {
    const result = await proxyDeposit();
    assert.equal(result.status, 502);
    assert.equal(result.body.code, "PAYMENT_REPLY_INVALID");
  }
  network = true;
  assert.equal((await proxyDeposit()).body.code, "PAYMENT_SERVICE_UNREACHABLE");
  const logged = JSON.stringify(logs);
  assert.ok(!logged.includes("private-upstream-text"));
  assert.ok(!logged.includes("private-key-value"));
  assert.equal(await balance(user), "0");
});

test("database credit failure after verification is logged and rolled back with an unconfirmed result", async (t) => {
  paymentEnv(t); const user = await player();
  const logs = [];
  t.mock.method(console, "info", (...args) => logs.push(args));
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(verified())));
  queryFault = (sql) => { if (sql.includes("insert into public.deposits")) throw Object.assign(new Error("private-db-details"), { code: "42501" }); };
  const result = await proxyDeposit();
  assert.equal(result.status, 500);
  assert.equal(result.body.code, "DEPOSIT_CREDIT_FAILED");
  assert.ok(logs.some((entry) => entry[1].event === "wallet_credit_failed" && entry[1].database_code === "42501"));
  assert.ok(!JSON.stringify(logs).includes("private-db-details"));
  queryFault = undefined;
  assert.equal(await balance(user), "0");
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

test("the withdrawal endpoint ignores a forged balance, victim ID and payment success fields", async (t) => {
  paymentEnv(t);
  const victim = await player(1000000); const attacker = await player();
  const payment = t.mock.method(globalThis, "fetch", async () => { throw new Error("Must not pay an unfunded account"); });
  const res = response();
  await withdrawHandler({ ...req(), body: withdrawPayload({ user_id: victim.userId, userId: victim.userId, balance: 999999999,
    status: "paid", success: true, verified: true, amount: 1000000 }) }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(await balance(victim), "1000000"); assert.equal(await balance(attacker), "0");
  activeUserId = undefined;
  const unauthenticated = response();
  await withdrawHandler({ ...req(), body: withdrawPayload({ user_id: victim.userId }) }, unauthenticated);
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(payment.mock.callCount(), 0);
});

test("negative, fractional, unsafe and string payout amounts cannot create money or invoke the gateway", async (t) => {
  paymentEnv(t); const user = await player(2000000);
  const payment = t.mock.method(globalThis, "fetch", async () => { throw new Error("Invalid amount must not reach gateway"); });
  for (const amount of [-100, 0, 0.5, "100", null, true, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await proxyWithdraw(withdrawPayload({ amount }))).status, 400);
  }
  assert.equal(await balance(user), "2000000");
  assert.equal(payment.mock.callCount(), 0);
  assert.equal((await db.query("select count(*)::int as n from public.withdrawals")).rows[0].n, 0);
});

test("a player's game token alone or a modified signed win cannot mint spendable balance", async (t) => {
  paymentEnv(t); const user = await player(1000); const debit = event(user); await callback("debit", debit);
  const honest = Buffer.from(JSON.stringify(credit(debit, 100)));
  const signed = signedSkmResponse(JSON.parse(String(honest)));
  const headers = Object.fromEntries(Object.entries(signed.headers).map(([k,v]) => [k.toLowerCase(),v]));
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(String(honest)), amount: 1000000 }));
  for (const candidateHeaders of [{ authorization: `Bearer ${user.token}` }, headers]) {
    const request = Readable.from([forged]); request.method = "POST"; request.headers = candidateHeaders;
    const res = response(); await handleSkmWallet(request, res, "credit");
    assert.equal(res.statusCode, 401);
  }
  assert.equal(await balance(user), "900");
  assert.equal((await callback("credit", JSON.parse(String(honest)))).status, "OK");
  assert.equal(await balance(user), "1000");
});

test("a fabricated deposit verification in the browser cannot replace gateway verification", async (t) => {
  paymentEnv(t); const user = await player();
  const payment = t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ success: false, code: "not_found" }), { status: 400 }));
  const result = await handleWalletProxy({ req: req(), functionName: "wallet-deposit", payload: {
    service_type: "kbzpay", amount: 1000000, transaction_id: "456789", ...verified(), balance: 1000000,
  } });
  assert.equal(result.status, 400); assert.equal(await balance(user), "0");
  assert.equal(payment.mock.callCount(), 1);
});

test("default limits allow exactly 1000000 Ks and three paid withdrawals per Myanmar day", async (t) => {
  paymentEnv(t); const user = await player(5000000);
  const payment = t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ success: true, message: "transfer_success", data: { transaction_id: randomUUID() } })));
  assert.equal((await proxyWithdraw(withdrawPayload({ amount: 1000001 }))).body.code, "WITHDRAW_LIMIT");
  assert.equal(payment.mock.callCount(), 0); assert.equal(await balance(user), "5000000");
  let last;
  for (let index = 0; index < 3; index++) {
    last = withdrawPayload({ amount: 1000000 });
    assert.equal((await proxyWithdraw(last)).body.state, "paid");
  }
  assert.equal((await proxyWithdraw(last)).body.state, "paid");
  const blocked = await proxyWithdraw(withdrawPayload({ max_per_day: 9999, withdraw_count: 0 }));
  assert.equal(blocked.status, 403); assert.equal(blocked.body.code, "WITHDRAW_DAILY_LIMIT");
  assert.match(blocked.body.error, /[\u1000-\u109f]/);
  assert.equal(payment.mock.callCount(), 3); assert.equal(await balance(user), "2000000");
});

test("many concurrent payout requests and changed IDs produce one transfer while its outcome is pending", async (t) => {
  paymentEnv(t); const user = await player(1000);
  let release; let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const payment = t.mock.method(globalThis, "fetch", async () => { entered(); return new Promise((resolve) => { release = resolve; }); });
  const payload = withdrawPayload(); const first = proxyWithdraw(payload); await started;
  const others = await Promise.all(Array.from({ length: 30 }, (_, index) => proxyWithdraw(index % 2 ? payload : withdrawPayload())));
  assert.ok(others.every((result) => result.body.state === "pending"));
  assert.equal(payment.mock.callCount(), 1); assert.equal(await balance(user), "900");
  release(new Response(JSON.stringify({ success: true, message: "transfer_success", data: { transaction_id: randomUUID() } })));
  assert.equal((await first).body.state, "paid");
});

test("a lost database update after money was sent never refunds or sends the payout again", async (t) => {
  paymentEnv(t); const user = await player(1000);
  const payment = t.mock.method(globalThis, "fetch", async () => {
    queryFault = (sql) => { if (sql.includes("Provider confirmed transfer")) { queryFault = undefined; throw new Error("Simulated database outage after send"); } };
    return new Response(JSON.stringify({ success: true, message: "transfer_success", data: { transaction_id: "already-paid-at-gateway" } }));
  });
  const payload = withdrawPayload(); assert.equal((await proxyWithdraw(payload)).body.state, "pending");
  assert.equal((await proxyWithdraw(payload)).body.state, "pending");
  assert.equal((await proxyWithdraw(withdrawPayload())).body.state, "pending");
  assert.equal(await balance(user), "900"); assert.equal(payment.mock.callCount(), 1);
});

test("an error reply reporting a transfer ID durably blocks a later refund", async (t) => {
  paymentEnv(t); const user = await player(1000);
  const payment = t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    success: false, code: "bad_phone", message: "Unexpected failure", data: { transaction_id: "transfer-evidence-in-error" },
  }), { status: 400 }));
  const payload = withdrawPayload();
  assert.equal((await proxyWithdraw(payload)).body.state, "pending");
  assert.equal((await releaseWithdraw({ userId: user.userId, orderId: `WD${payload.request_id.replaceAll("-", "")}`, message: "Must reconcile first" })).state, "pending");
  assert.equal((await proxyWithdraw(payload)).body.state, "pending");
  assert.equal(await balance(user), "900"); assert.equal(payment.mock.callCount(), 1);
});

test("daily limits exclude yesterday and confirmed failures, and are separate for each player", async (t) => {
  paymentEnv(t); const user = await player(1000);
  // Use the DB's Myanmar midnight so this remains valid at any UTC time.
  for (let index = 0; index < 3; index++) {
    await db.query(`insert into public.withdrawals (user_id,service_type,order_id,amount,payout_phone,status,created_at)
      values ($1,'kbzpay',$2,100,'09123456789','paid',
        (date_trunc('day', statement_timestamp() at time zone 'Asia/Rangoon') at time zone 'Asia/Rangoon') - interval '1 second')`, [user.userId, randomUUID()]);
  }
  const failedId = randomUUID(); await reserve(user, 100, failedId);
  await releaseWithdraw({ userId: user.userId, orderId: failedId, message: "Definite rejection" });
  const payment = t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ success: true, message: "transfer_success", data: { transaction_id: randomUUID() } })));
  for (let index = 0; index < 3; index++) assert.equal((await proxyWithdraw(withdrawPayload())).body.state, "paid");
  assert.equal((await proxyWithdraw(withdrawPayload())).body.code, "WITHDRAW_DAILY_LIMIT");
  const other = await player(1000);
  assert.equal((await proxyWithdraw(withdrawPayload())).body.state, "paid");
  assert.equal(await balance(user), "700"); assert.equal(await balance(other), "900"); assert.equal(payment.mock.callCount(), 4);
});

test("emergency pause and invalid security settings prevent any reservation or transfer", async (t) => {
  paymentEnv(t); const user = await player(1000);
  const payment = t.mock.method(globalThis, "fetch", async () => { throw new Error("Paused payouts must never reach gateway"); });
  payoutEnv(t, { WITHDRAWALS_ENABLED: "false" });
  assert.equal((await proxyWithdraw(withdrawPayload())).body.code, "WITHDRAWALS_PAUSED");
  process.env.WITHDRAWALS_ENABLED = "true"; process.env.WITHDRAW_MAX_PER_DAY = "invalid";
  t.after(() => delete process.env.WITHDRAW_MAX_PER_DAY);
  t.mock.method(console, "error", () => {});
  assert.equal((await proxyWithdraw(withdrawPayload())).status, 500);
  assert.equal(await balance(user), "1000"); assert.equal(payment.mock.callCount(), 0);
  assert.equal((await db.query("select count(*)::int as n from public.withdrawals")).rows[0].n, 0);
});

test("payment requests forbid redirect resends and reject plaintext destinations before moving money", async (t) => {
  paymentEnv(t); const user = await player(1000);
  const payment = t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal(options.redirect, "error");
    throw new TypeError("A redirect or network failure leaves the outcome unknown");
  });
  assert.equal((await proxyWithdraw(withdrawPayload())).body.state, "pending");
  assert.equal((await proxyDeposit()).status, 502);
  payoutEnv(t, { PAYMENT_API_URL: "http://insecure.example" });
  const calls = payment.mock.callCount();
  t.mock.method(console, "error", () => {});
  assert.equal((await proxyWithdraw(withdrawPayload())).status, 500);
  assert.equal((await proxyDeposit()).status, 500);
  assert.equal(await balance(user), "900"); assert.equal(payment.mock.callCount(), calls);
});
