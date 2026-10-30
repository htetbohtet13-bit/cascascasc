import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, mock, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { MAX_MONEY } from "../server/money.mjs";
import { gameBalance, splitGameBalance } from "../server/game-money.mjs";
import { remainingWagering, wageringTracker } from "../server/wagering.mjs";

// Exercise the real wallet SQL with raw provider minor-unit fixtures.
// No live provider, bank, Neon connection or real account is used.
const db = new PGlite();
const clientFor = (connection) => ({ async query(sql, params) {
  const result = await connection.query(sql, params);
  return { rows: result.rows, rowCount: /^\s*select/i.test(sql) ? result.rows.length : result.affectedRows };
} });
mock.module("../server/neon.mjs", { namedExports: {
  getPool: () => clientFor(db), withTransaction: (fn) => db.transaction((tx) => fn(clientFor(tx))),
} });
const { createSkmGameSession, processSkmWalletCallback } = await import("../server/skm-wallet.mjs");
const { applyVerifiedDeposit, reserveWithdraw, releaseWithdraw, getProfile } = await import("../server/wallet.mjs");
async function migration(name) {
  await db.exec((await readFile(new URL(`../neon/${name}`, import.meta.url), "utf8")).replace("create extension if not exists pgcrypto;", ""));
}
before(async () => {
  for (const name of ["001_app_schema.sql", "005_skm_seamless_wallet.sql", "008_deposit_wagering.sql", "010_money_constraints.sql", "012_game_minor_units.sql", "013_first_deposit_bonus.sql"]) await migration(name);
});
beforeEach(async () => {
  await db.exec("insert into public.deposit_bonus_campaign(singleton,starts_at) values(true,'infinity') on conflict(singleton) do update set starts_at=excluded.starts_at");
  await db.exec("truncate public.wallet_wagering_events, public.skm_wallet_transactions, public.skm_game_sessions, public.deposits, public.withdrawals, public.profiles restart identity cascade");
});
after(() => db.close());
async function player(kyat = 1000, fraction = 0) {
  const userId = randomUUID();
  await db.query("insert into public.profiles(id,phone,balance,balance_minor) values($1,'+959123456789',$2,$3)", [userId, String(kyat), fraction]);
  return { userId, ...await createSkmGameSession(userId) };
}
const call = (route, payload) => processSkmWalletCallback(route, payload, JSON.stringify(payload));
const balanceCall = (user) => call("balance", { player_id: user.player_id, token: user.token, currency: "MMK" });
const debit = (user, amount, extra = {}) => ({ player_id: user.player_id, token: user.token, currency: "MMK", round_id: randomUUID(), transaction_id: randomUUID(), game_code: "goldencentury", reason: "BET_HOLD", amount, ...extra });
const credit = (bet, amount) => ({ ...bet, transaction_id: randomUUID(), debit_transaction_id: bet.transaction_id, reason: bet.reason === "BANK_DEPOSIT" ? "BANK_RETURN" : "BET_SETTLE", amount, round_closed: true });
const rollback = (bet) => ({ ...bet, transaction_id: randomUUID(), debit_transaction_id: bet.transaction_id });
async function stored(user) {
  return (await db.query("select balance::text, balance_minor from public.profiles where id=$1", [user.userId])).rows[0];
}
const tracker = (user) => wageringTracker(clientFor(db), user.userId);
const deposit = (user, amount) => {
  const id = randomUUID();
  return applyVerifiedDeposit({ userId: user.userId, orderId: id, transactionId: id, providerTransactionId: id, serviceType: "kbzpay", amount, depositToken: "" });
};

test("1000 app kyat is reported as 100000 game minor units without rewriting the balance", async () => {
  const user = await player();
  assert.deepEqual(await balanceCall(user), { status: "OK", balance: 100000, currency: "MMK" });
  assert.deepEqual(await stored(user), { balance: "1000", balance_minor: 0 });
  const profile = await getProfile(user.userId);
  assert.equal(profile.balance, 1000); assert.equal(profile.balance_minor, 0);
});

test("minor-unit bets and winnings debit and credit the matching kyat amounts", async () => {
  const user = await player(); const bet = debit(user, 10000);
  assert.equal((await call("debit", bet)).balance, 90000);
  assert.deepEqual(await stored(user), { balance: "900", balance_minor: 0 });
  const result = await call("credit", credit(bet, 19500));
  assert.equal(result.status, "OK"); assert.equal(result.balance, 109500);
  assert.deepEqual(await stored(user), { balance: "1095", balance_minor: 0 });
  const rows = (await db.query("select amount::text,balance_after::text,unit_scale from public.skm_wallet_transactions order by created_at")).rows;
  assert.deepEqual(rows, [{ amount: "10000", balance_after: "90000", unit_scale: 100 }, { amount: "19500", balance_after: "109500", unit_scale: 100 }]);
});

test("hundredths survive settlement, duplicate callbacks and the profile display response", async () => {
  const user = await player(); const bet = debit(user, 1);
  assert.equal((await call("debit", bet)).balance, 99999);
  assert.deepEqual(await stored(user), { balance: "999", balance_minor: 99 });
  const payout = credit(bet, 196);
  const results = await Promise.all([call("credit", payout), call("credit", payout)]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["DUPLICATE", "OK"]);
  assert.ok(results.every((result) => result.balance === 100195));
  assert.deepEqual(await stored(user), { balance: "1001", balance_minor: 95 });
  const profile = await getProfile(user.userId);
  assert.equal(profile.balance + profile.balance_minor / 100, 1001.95);
});

test("rollback returns the exact minor amount once, including the final hundredth", async () => {
  const user = await player(1); const bet = debit(user, 99);
  assert.equal((await call("debit", bet)).balance, 1);
  const refund = rollback(bet);
  assert.equal((await call("rollback", refund)).balance, 100);
  assert.equal((await call("rollback", refund)).status, "DUPLICATE");
  assert.deepEqual(await stored(user), { balance: "1", balance_minor: 0 });
  const early = debit(user, 100);
  assert.equal((await call("rollback", rollback(early))).balance, 100);
  assert.equal((await call("debit", early)).status, "ERROR");
  assert.equal((await balanceCall(user)).balance, 100);
});

test("insufficient-funds replies use minor units and never borrow or invent a remainder", async () => {
  const user = await player(1, 1);
  const result = await call("debit", debit(user, 102));
  assert.equal(result.status, "INSUFFICIENT_FUNDS"); assert.equal(result.balance, 101);
  assert.deepEqual(await stored(user), { balance: "1", balance_minor: 1 });
  assert.equal((await call("debit", debit(user, 101))).balance, 0);
  assert.deepEqual(await stored(user), { balance: "0", balance_minor: 0 });
});

test("expired sessions still settle in minor units but cannot start a new bet", async () => {
  const user = await player(); const bet = debit(user, 10000);
  await call("debit", bet);
  await db.query("update public.skm_game_sessions set expires_at=now()-interval '1 minute' where user_id=$1", [user.userId]);
  const expired = await balanceCall(user);
  assert.equal(expired.status, "TOKEN_EXPIRED"); assert.equal(expired.balance, 90000);
  assert.equal((await call("debit", debit(user, 1))).status, "TOKEN_EXPIRED");
  assert.equal((await call("credit", credit(bet, 24999))).balance, 114999);
  assert.deepEqual(await stored(user), { balance: "1149", balance_minor: 99 });
});

test("deposit, whole-kyat withdrawal and failed-payout refund preserve fractional game winnings", async () => {
  const user = await player(0);
  await deposit(user, 1000);
  const bet = debit(user, 100000); await call("debit", bet);
  await call("credit", credit(bet, 100195));
  assert.equal(await (await tracker(user)).remaining(), 0n);
  const id = randomUUID();
  assert.equal((await reserveWithdraw({ userId: user.userId, orderId: id, serviceType: "kbzpay", amount: 1000, phone: "09123456789" })).state, "reserved");
  assert.equal((await balanceCall(user)).balance, 195);
  await releaseWithdraw({ userId: user.userId, orderId: id, message: "Confirmed unsent test failure" });
  assert.equal((await balanceCall(user)).balance, 100195);
  await deposit(user, 1000);
  assert.equal((await balanceCall(user)).balance, 200195);
});

test("turnover compares kyat deposits and minor-unit bets without a 100-fold waiver", async () => {
  const user = await player(0); await deposit(user, 1000);
  const card = debit(user, 50000, { game_code: "shankoemee", stake: 10000 });
  await call("debit", card); await call("credit", credit(card, 50000));
  assert.equal(await (await tracker(user)).remaining(), 900n);
  const fractional = debit(user, 1); await call("debit", fractional);
  await call("credit", credit(fractional, 1));
  assert.equal(await (await tracker(user)).remaining(), 900n);
  assert.equal(remainingWagering([{ kind: "DEPOSIT", amount: 1 }, { kind: "BET", state: "SETTLED", amount: 99, amount_scale: 100 }]), 1n);
  assert.equal(remainingWagering([{ kind: "DEPOSIT", amount: 1 }, { kind: "BET", state: "SETTLED", amount: 100, amount_scale: 100 }]), 0n);
});

test("a fractional balance prevents the zero-balance turnover reset", async () => {
  const user = await player(0, 99); await deposit(user, 500);
  const bet = debit(user, 50000, { game_code: "shankoemee", stake: 10000 });
  await call("debit", bet); await call("credit", credit(bet, 0));
  assert.deepEqual(await stored(user), { balance: "0", balance_minor: 99 });
  assert.equal(await (await tracker(user)).remaining(), 400n);
  await deposit(user, 1000);
  assert.equal(await (await tracker(user)).remaining(), 1400n);
  assert.equal((await balanceCall(user)).balance, 100099);
});

test("game conversion fails closed at the JSON safe-integer boundary without rounding or partial credit", async () => {
  assert.equal(gameBalance(MAX_MONEY / 100n, MAX_MONEY % 100n), Number(MAX_MONEY));
  assert.deepEqual(splitGameBalance(MAX_MONEY), { balance: Number(MAX_MONEY / 100n), balance_minor: 91 });
  for (const bad of [-1, 100, "01", 0.5]) assert.throws(() => gameBalance(1, bad));
  assert.throws(() => gameBalance(MAX_MONEY / 100n + 1n));
  const user = await player(MAX_MONEY / 100n, 91); const bet = debit(user, 1);
  assert.equal((await call("debit", bet)).balance, Number(MAX_MONEY - 1n));
  assert.equal((await call("credit", credit(bet, 2))).status, "ERROR");
  assert.equal((await balanceCall(user)).balance, Number(MAX_MONEY - 1n));
  assert.equal((await call("credit", credit(bet, 1))).balance, Number(MAX_MONEY));
});

test("non-integer wire amounts cannot change either balance component", async () => {
  const user = await player();
  for (const amount of [-1, 0, 0.01, "100", null, true, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await call("debit", debit(user, amount))).status, "ERROR");
    assert.deepEqual(await stored(user), { balance: "1000", balance_minor: 0 });
  }
});

test("migration reruns preserve balances and corrected ledger units; constraints block legacy writers", async () => {
  const user = await player(1000, 95); const bet = debit(user, 100);
  await call("debit", bet);
  await migration("012_game_minor_units.sql"); await migration("012_game_minor_units.sql");
  assert.deepEqual(await stored(user), { balance: "999", balance_minor: 95 });
  const digest = createHash("sha256").update("legacy-test").digest("hex");
  await assert.rejects(() => db.transaction(async (tx) => {
    await tx.query("update public.profiles set balance=0 where id=$1", [user.userId]);
    await tx.query(`insert into public.skm_wallet_transactions
      (transaction_id,user_id,player_id,currency,kind,reason,amount,round_id,game_code,payload_hash,status,balance_after)
      values($1,$2::uuid,$2::text,'MMK','DEBIT','BET_HOLD',100,'legacy-round','goldencentury',$3,'APPLIED',0)`, [randomUUID(), user.userId, digest]);
  }), /skm_new_debits_minor_units/);
  assert.deepEqual(await stored(user), { balance: "999", balance_minor: 95 });
});

test("migration refuses an unsettled legacy debit instead of rescaling live money", async () => {
  const user = await player(); const bet = debit(user, 10000); await call("debit", bet);
  await db.exec("alter table public.skm_wallet_transactions drop constraint skm_new_debits_minor_units");
  await db.query("update public.skm_wallet_transactions set unit_scale=1 where transaction_id=$1", [bet.transaction_id]);
  try {
    await assert.rejects(() => migration("012_game_minor_units.sql"), /Unsettled legacy game debits/);
    await db.exec("rollback");
    assert.deepEqual(await stored(user), { balance: "900", balance_minor: 0 });
    assert.equal((await call("credit", credit(bet, 10000))).status, "ERROR");
  } finally {
    await db.query("update public.skm_wallet_transactions set unit_scale=100 where transaction_id=$1", [bet.transaction_id]);
    await migration("012_game_minor_units.sql");
  }
});
