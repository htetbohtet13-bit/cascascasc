import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, mock, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { remainingWagering, wageredStake, wageringTracker } from "../server/wagering.mjs";

// Real Postgres SQL and constraints in memory; no live account or payment service.
const db = new PGlite();
let activeUserId;
function clientFor(connection) {
  return {
    async query(sql, params) {
      const result = await connection.query(sql, params);
      return { rows: result.rows, rowCount: /^\s*select/i.test(sql) ? result.rows.length : result.affectedRows };
    },
  };
}
mock.module("../server/neon.mjs", {
  namedExports: {
    getPool: () => clientFor(db),
    withTransaction: (callback) => db.transaction((tx) => callback(clientFor(tx))),
  },
});
mock.module("../server/auth.mjs", {
  namedExports: { currentSession: async () => ({ user: { id: activeUserId } }) },
});
const { applyVerifiedDeposit, reserveWithdraw } = await import("../server/wallet.mjs");
const { createSkmGameSession, processSkmWalletCallback } = await import("../server/skm-wallet.mjs");
const { handleWalletProxy } = await import("../server/wallet-proxy.mjs");

async function migration(name) {
  const sql = await readFile(new URL(`../neon/${name}`, import.meta.url), "utf8");
  // gen_random_uuid() is built into Postgres; the optional pgcrypto extension
  // requested by the legacy bootstrap is not bundled into this test engine.
  await db.exec(sql.replace("create extension if not exists pgcrypto;", ""));
}

before(async () => {
  await migration("001_app_schema.sql");
  await migration("005_skm_seamless_wallet.sql");
  await migration("008_deposit_wagering.sql");
  await migration("012_game_minor_units.sql");
  await migration("013_first_deposit_bonus.sql");
});
beforeEach(async () => {
  await db.exec("insert into public.deposit_bonus_campaign(singleton,starts_at) values(true,'infinity') on conflict(singleton) do update set starts_at=excluded.starts_at");
  await db.exec("truncate public.wallet_wagering_events, public.skm_wallet_transactions, public.skm_game_sessions, public.deposits, public.withdrawals, public.profiles restart identity cascade");
});
after(async () => { await db.close(); });

async function player(balance = 0) {
  const userId = randomUUID();
  activeUserId = userId;
  await db.query("insert into public.profiles (id, phone, balance) values ($1::uuid, '+959123456789', $2)", [userId, balance]);
  return { userId, ...await createSkmGameSession(userId) };
}
function deposit(user, amount, id = randomUUID()) {
  return applyVerifiedDeposit({ userId: user.userId, orderId: id, transactionId: id, providerTransactionId: id, depositToken: "", serviceType: "kbzpay", amount });
}
async function callback(route, payload) {
  // Business fixtures below use app kyat; the provider sends minor units.
  const wire = { ...payload,
    ...(typeof payload.amount === "number" ? { amount: payload.amount * 100 } : {}),
    ...(typeof payload.stake === "number" ? { stake: payload.stake * 100 } : {}),
  };
  return processSkmWalletCallback(route, wire, JSON.stringify(wire));
}
async function bet(user, amount, { gameCode = "goldencentury", stake = amount, reason = "BET_HOLD" } = {}) {
  const payload = { player_id: user.player_id, token: user.token, currency: "MMK", round_id: randomUUID(), transaction_id: randomUUID(), game_code: gameCode, reason, amount, stake };
  assert.equal((await callback("debit", payload)).status, "OK");
  return payload;
}
function settlement(debit, amount) {
  return { ...debit, transaction_id: randomUUID(), debit_transaction_id: debit.transaction_id, reason: debit.reason === "BANK_DEPOSIT" ? "BANK_RETURN" : "BET_SETTLE", amount, round_closed: true };
}
function rollback(debit) {
  return { ...debit, transaction_id: randomUUID(), debit_transaction_id: debit.transaction_id };
}
async function remaining(user) {
  return (await wageringTracker(clientFor(db), user.userId)).remaining();
}
async function balance(user) {
  const result = await db.query("select balance from public.profiles where id = $1::uuid", [user.userId]);
  return Number(result.rows[0].balance);
}
function withdraw(user, amount, id = randomUUID()) {
  return reserveWithdraw({ userId: user.userId, orderId: id, serviceType: "kbzpay", phone: "09123456789", amount });
}

test("a blocked withdrawal reports the remaining amount in Burmese and never sends a payment", async (t) => {
  const user = await player();
  await deposit(user, 1000);
  for (const [key, value] of Object.entries({ payment_secret: "test-key", kbzreceiver: "09123456789" })) {
    const original = process.env[key];
    process.env[key] = value;
    t.after(() => { if (original === undefined) delete process.env[key]; else process.env[key] = original; });
  }
  const payment = t.mock.method(globalThis, "fetch", async () => { throw new Error("Payment must not be called"); });
  const result = await handleWalletProxy({ req: { method: "POST", headers: { origin: "https://www.j777ml.com", "content-type": "application/json" } }, functionName: "wallet-withdraw", payload: { service_type: "kbzpay", amount: 500, phone: "09123456789", request_id: randomUUID() } });
  assert.equal(result.status, 403);
  assert.equal(result.body.code, "WAGERING_REQUIRED");
  assert.equal(result.body.remaining_wagering, "1000");
  assert.match(result.body.error, /၁,၀၀၀ ကျပ်/);
  assert.equal(payment.mock.callCount(), 0);
  assert.equal(await balance(user), 1000);
  assert.equal((await db.query("select count(*)::int as count from public.withdrawals")).rows[0].count, 0);
});

test("5x card holds count the actual stake only after settlement, and duplicate credits count once", async () => {
  const user = await player(4000);
  await deposit(user, 1000);
  const debit = await bet(user, 5000, { gameCode: "shankoemee", stake: 1000 });
  assert.equal((await callback("debit", debit)).status, "DUPLICATE");
  assert.equal(await balance(user), 0);
  assert.equal(await remaining(user), 1000n);
  const credit = settlement(debit, 5000);
  assert.equal((await callback("credit", credit)).status, "OK");
  assert.equal((await callback("credit", credit)).status, "DUPLICATE");
  assert.equal(await remaining(user), 0n);
  assert.equal(await balance(user), 5000);
  assert.equal((await withdraw(user, 5000)).state, "reserved");
});

test("partial wagering and additional deposits accumulate without resetting progress", async () => {
  const user = await player();
  const id = randomUUID();
  await deposit(user, 1000, id);
  await deposit(user, 1000, id);
  const debit = await bet(user, 400);
  await callback("credit", settlement(debit, 400));
  assert.equal(await remaining(user), 600n);
  await deposit(user, 500);
  assert.equal(await remaining(user), 1100n);
});

test("late settlements are replayed in bet order and an earlier bet cannot cover a later deposit", async () => {
  const user = await player(1000);
  const oldBet = await bet(user, 1000);
  await deposit(user, 1000);
  await callback("credit", settlement(oldBet, 1000));
  assert.equal(await remaining(user), 1000n);
  const first = await bet(user, 700);
  await deposit(user, 500);
  const second = await bet(user, 800);
  await callback("credit", settlement(second, 800));
  assert.equal(await remaining(user), 700n);
  await callback("credit", settlement(first, 700));
  assert.equal(await remaining(user), 0n);
});

test("excess old wagering is discarded before a new deposit", async () => {
  const user = await player(2000);
  await deposit(user, 1000);
  const debit = await bet(user, 3000);
  await callback("credit", settlement(debit, 3000));
  assert.equal(await remaining(user), 0n);
  await deposit(user, 500);
  assert.equal(await remaining(user), 500n);
});

test("cancelled bets and banker holds do not count", async () => {
  const user = await player();
  await deposit(user, 1000);
  const cancelled = await bet(user, 400);
  const refund = rollback(cancelled);
  assert.equal((await callback("rollback", refund)).status, "OK");
  assert.equal((await callback("rollback", refund)).status, "DUPLICATE");
  assert.equal(await remaining(user), 1000n);
  const bank = await bet(user, 1000, { gameCode: "shankoemee", reason: "BANK_DEPOSIT" });
  await callback("credit", settlement(bank, 1000));
  assert.equal(await remaining(user), 1000n);
});

test("zero balance resets unfinished turnover only after every game hold settles", async () => {
  const user = await player();
  await deposit(user, 1000);
  const first = await bet(user, 500, { gameCode: "shankoemee", stake: 100 });
  const second = await bet(user, 500, { gameCode: "shankoemee", stake: 100 });
  assert.equal(await balance(user), 0);
  assert.equal(await remaining(user), 1000n);
  await callback("credit", settlement(first, 0));
  assert.equal(await remaining(user), 900n);
  await callback("credit", settlement(second, 0));
  assert.equal(await remaining(user), 0n);
  await deposit(user, 600);
  assert.equal(await remaining(user), 600n);
});

test("pending withdrawal funds prevent a zero-balance reset", async () => {
  const user = await player();
  await deposit(user, 1000);
  await db.query("update public.profiles set balance = 0 where id = $1::uuid", [user.userId]);
  await db.query("insert into public.withdrawals (user_id,service_type,order_id,amount,payout_phone,status) values ($1::uuid,'kbzpay','pending',1000,'09123456789','pending')", [user.userId]);
  const tracker = await wageringTracker(clientFor(db), user.userId);
  await tracker.resetIfEmpty(0, "zero-with-pending-withdrawal");
  assert.equal(await tracker.remaining(), 1000n);
});

test("simultaneous duplicate settlements cannot credit the wallet or wagering twice", async () => {
  const user = await player();
  await deposit(user, 1000);
  const debit = await bet(user, 400);
  const credit = settlement(debit, 400);
  const results = await Promise.all([callback("credit", credit), callback("credit", credit)]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["DUPLICATE", "OK"]);
  assert.equal(await balance(user), 1000);
  assert.equal(await remaining(user), 600n);
});

test("migration is repeatable and historical balances are not retroactively locked", async () => {
  const user = await player(1000);
  await db.exec("drop table public.wallet_wagering_events");
  try {
    await assert.rejects(() => remaining(user), /security storage/);
    await assert.rejects(() => deposit(user, 1000), /security storage/);
    await assert.rejects(() => withdraw(user, 1000), /security storage/);
    assert.equal(await balance(user), 1000);
    await migration("008_deposit_wagering.sql");
    await migration("008_deposit_wagering.sql");
    await migration("012_game_minor_units.sql");
    await migration("013_first_deposit_bonus.sql");
    assert.equal(await remaining(user), 0n);
    assert.equal((await withdraw(user, 1000)).state, "reserved");
  } finally {
    await migration("008_deposit_wagering.sql");
    await migration("012_game_minor_units.sql");
    await migration("013_first_deposit_bonus.sql");
  }
});

test("a turnover-record failure rolls back the entire deposit credit", async () => {
  const user = await player();
  await assert.rejects(() => deposit(user, 1000, "x".repeat(241)));
  assert.equal(await balance(user), 0);
  assert.equal((await db.query("select count(*)::int as count from public.deposits")).rows[0].count, 0);
  assert.equal(await remaining(user), 0n);
});

test("stake calculation distinguishes card collateral from paid slot feature purchases", () => {
  assert.equal(wageredStake({ reason: "BET_HOLD", game_code: "shankoemee", amount: 5000, stake: 1000 }), 1000);
  assert.equal(wageredStake({ reason: "BET_HOLD", game_code: "abcd", amount: 5000 }), 1000);
  assert.equal(wageredStake({ reason: "BET_HOLD", game_code: "africanbuffaloplus", amount: 5000, stake: 100 }), 5000);
  assert.equal(wageredStake({ reason: "BANK_DEPOSIT", amount: 5000 }), 0);
  assert.throws(() => wageredStake({ reason: "BET_HOLD", game_code: "abcd", amount: 5000, stake: 5000 }));
});

test("wagering arithmetic retains precision beyond JavaScript's safe integer total", () => {
  const max = Number.MAX_SAFE_INTEGER;
  assert.equal(remainingWagering([{ kind: "DEPOSIT", amount: max }, { kind: "DEPOSIT", amount: max }, { kind: "BET", amount: 1, state: "SETTLED" }]), 2n * BigInt(max) - 1n);
});
