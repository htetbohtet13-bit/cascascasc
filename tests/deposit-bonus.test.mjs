import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, mock, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { depositBonusEligibility } from "../server/deposit-bonus.mjs";
import { remainingWagering, wageringTracker } from "../server/wagering.mjs";
import { readAdminOverview, overviewWindow } from "../server/admin-overview.mjs";
import { MAX_MONEY } from "../server/money.mjs";

// Real transactional SQL, isolated from production accounts and bank/provider APIs.
const db = new PGlite();
let phoneSequence = 100000000;
let activeUser;
let queryFault;
const queries = [];
const clientFor = (connection) => ({ async query(sql, params) {
  queries.push(sql);
  queryFault?.(sql);
  const result = await connection.query(sql, params);
  return { rows: result.rows, rowCount: /^\s*select/i.test(sql) ? result.rows.length : result.affectedRows };
} });
const pool = clientFor(db);
mock.module("../server/neon.mjs", { namedExports: { getPool: () => pool, withTransaction: (fn) => db.transaction((tx) => fn(clientFor(tx))) } });
mock.module("../server/auth.mjs", { namedExports: { currentSession: async () => activeUser ? { user: { id: activeUser } } : null } });
mock.module("../server/rate-limit.mjs", { namedExports: { consumeRateLimit: async () => null } });
mock.module("../server/skm-api.mjs", { namedExports: { listProviderGames: async () => [] } });
const { applyVerifiedDeposit, reserveWithdraw, walletHistory } = await import("../server/wallet.mjs");
const { createSkmGameSession, processSkmWalletCallback } = await import("../server/skm-wallet.mjs");
const { handleWalletProxy } = await import("../server/wallet-proxy.mjs");
const { handleAdminApi } = await import("../server/admin-api.mjs");
const envKeys = ["admin_secret", "ADMIN_MFA_REQUIRED", "ADMIN_TOTP_SECRET", "WITHDRAWALS_ENABLED", "WITHDRAW_MAX_AMOUNT_MMK", "WITHDRAW_MAX_PER_DAY"];
const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
async function migration(name) {
  await db.exec((await readFile(new URL(`../neon/${name}`, import.meta.url), "utf8")).replace("create extension if not exists pgcrypto;", ""));
}
before(async () => {
  for (const name of ["001_app_schema.sql", "002_phone_auth.sql", "005_skm_seamless_wallet.sql", "006_game_display_settings.sql", "008_deposit_wagering.sql", "009_auth_security.sql", "010_money_constraints.sql", "012_game_minor_units.sql", "013_first_deposit_bonus.sql"]) await migration(name);
  for (const key of envKeys) delete process.env[key];
  process.env.admin_secret = "test-bonus-admin";
  process.env.ADMIN_MFA_REQUIRED = "false";
});
beforeEach(async () => {
  queryFault = undefined; activeUser = undefined; queries.length = 0;
  await db.exec("truncate public.profiles cascade; insert into public.deposit_bonus_campaign(singleton,starts_at) values(true,'2020-01-01T00:00:00Z') on conflict(singleton) do update set starts_at=excluded.starts_at");
});
after(async () => {
  for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await db.close();
});
async function player(balance = 0, minor = 0) {
  const userId = randomUUID();
  await db.query("insert into public.profiles(id,phone,balance,balance_minor) values($1,$2,$3,$4)", [userId, `+959${phoneSequence++}`, String(balance), minor]);
  return { userId, ...await createSkmGameSession(userId) };
}
const deposit = (user, amount = 5000, id = randomUUID(), receipt = id) => applyVerifiedDeposit({ userId: user.userId, orderId: id, serviceType: "kbzpay", amount, transactionId: receipt, providerTransactionId: receipt, depositToken: "" });
const remaining = async (user) => (await wageringTracker(pool, user.userId)).remaining();
const balance = async (user) => (await db.query("select balance::text, balance_minor from public.profiles where id=$1", [user.userId])).rows[0];
const eligible = async (user) => (await depositBonusEligibility(pool, user.userId)).eligible;
const reserve = (user, amount = 1000) => reserveWithdraw({ userId: user.userId, orderId: randomUUID(), serviceType: "kbzpay", amount, phone: "09123456789" });
const call = (route, payload) => processSkmWalletCallback(route, payload, JSON.stringify(payload));
const bet = (user, amount, extra = {}) => ({ player_id: user.player_id, token: user.token, currency: "MMK", transaction_id: randomUUID(), round_id: randomUUID(), game_code: "goldencentury", reason: "BET_HOLD", amount, ...extra });
const credit = (debit, amount) => ({ ...debit, transaction_id: randomUUID(), debit_transaction_id: debit.transaction_id, reason: debit.reason === "BANK_DEPOSIT" ? "BANK_RETURN" : "BET_SETTLE", amount, round_closed: true });
async function settled(user, amount, returned = amount, extra = {}) {
  const debit = bet(user, amount, extra);
  assert.equal((await call("debit", debit)).status, "OK");
  assert.equal((await call("credit", credit(debit, returned))).status, "OK");
  return debit;
}
async function oldDeposit(user, status = "verified", completed = "2019-12-31T23:59:59Z") {
  await db.query("insert into public.deposits(user_id,service_type,order_id,amount,status,created_at,completed_at) values($1,'kbzpay',$2,1000,$3,'2019-01-01T00:00:00Z',$4)", [user.userId, randomUUID(), status, completed]);
}

test("5,000 credits 10,000 with 300,000 wagering; 10,000 credits 15,000 with 450,000 wagering", async () => {
  for (const [amount, total, requirement] of [[5000, 10000, 300000n], [10000, 15000, 450000n], [50000000, 50005000, 1500150000n]]) {
    const user = await player(); const result = await deposit(user, amount);
    assert.equal(result.ok, true); assert.equal(result.balance, total);
    assert.equal(result.depositAmount, amount); assert.equal(result.bonusAmount, 5000);
    assert.equal(result.creditedAmount, total); assert.equal(result.wageringRequired, String(requirement));
    assert.equal(await remaining(user), requirement);
    const events = (await db.query("select amount,wagering_multiplier from public.wallet_wagering_events where user_id=$1 and kind='DEPOSIT'", [user.userId])).rows;
    assert.equal(events.length, 1); assert.equal(Number(events[0].amount), total); assert.equal(events[0].wagering_multiplier, 30);
  }
});

test("all pre-launch successful depositors are excluded, including missing historical completion dates", async () => {
  for (const completion of ["2019-12-31T23:59:59Z", null]) {
    const user = await player(1000); await oldDeposit(user, "verified", completion);
    assert.equal(await eligible(user), false);
    assert.equal((await deposit(user)).bonusAmount, 0);
    assert.equal(await remaining(user), 5000n);
  }
});

test("an existing account without successful deposits is eligible; failed or pending deposits do not exclude it", async () => {
  for (const status of ["pending", "failed"]) {
    const user = await player(); await oldDeposit(user, status);
    await db.query("update public.profiles set created_at='2019-01-01' where id=$1", [user.userId]);
    assert.equal(await eligible(user), true); assert.equal((await deposit(user)).bonusAmount, 5000);
  }
});

test("sub-5,000 deposits retain eligibility and prior turnover; subsequent deposits use only 1x", async () => {
  const user = await player();
  assert.equal((await deposit(user, 1000)).bonusAmount, 0); assert.equal(await eligible(user), true);
  assert.equal((await deposit(user, 4000)).bonusAmount, 0); assert.equal(await eligible(user), true);
  assert.equal((await deposit(user)).bonusAmount, 5000); assert.equal(await remaining(user), 305000n);
  assert.equal(await eligible(user), false);
  assert.equal((await deposit(user, 10000)).bonusAmount, 0);
  assert.equal(await remaining(user), 315000n);
  assert.deepEqual(await balance(user), { balance: "25000", balance_minor: 0 });
});

test("duplicate confirmations and competing qualifying deposits produce exactly one lifetime bonus", async () => {
  const user = await player(); const order = randomUUID();
  const results = await Promise.all([deposit(user, 5000, order), deposit(user, 5000, order), deposit(user, 10000)]);
  assert.ok(results.every((result) => result.ok));
  assert.deepEqual(await balance(user), { balance: "20000", balance_minor: 0 });
  assert.equal(await remaining(user), 310000n);
  const records = (await db.query("select count(*)::int as deposits, count(*) filter(where bonus_amount>0)::int as awards from public.deposits where user_id=$1", [user.userId])).rows[0];
  assert.deepEqual(records, { deposits: 2, awards: 1 });
  const replay = await deposit(user, 5000, order);
  assert.equal(replay.bonusAmount, 5000); assert.equal(replay.creditedAmount, 10000);
  assert.equal((await deposit(user, 5000, randomUUID(), order)).ok, false);
  const second = await player(); assert.equal((await deposit(second, 5000, randomUUID(), order)).ok, false);
  assert.equal(await eligible(second), true);
});

test("unique claim constraint blocks another bonus even if an application writer forgets the eligibility check", async () => {
  const user = await player(); await deposit(user);
  await assert.rejects(() => db.query("insert into public.deposits(user_id,service_type,order_id,amount,bonus_amount,status) values($1,'kbzpay',$2,5000,5000,'verified')", [user.userId, randomUUID()]), (error) => error.code === "23505");
});

test("any failure writing wagering rolls back cash, bonus and the lifetime claim together", async () => {
  const user = await player(1000);
  queryFault = (sql) => { if (/insert into public.wallet_wagering_events/.test(sql)) throw new Error("Injected ledger failure"); };
  await assert.rejects(() => deposit(user), /Injected/);
  queryFault = undefined;
  assert.deepEqual(await balance(user), { balance: "1000", balance_minor: 0 });
  assert.equal((await db.query("select count(*)::int as count from public.deposits")).rows[0].count, 0);
  assert.equal(await eligible(user), true);
  assert.equal((await deposit(user)).bonusAmount, 5000);
  const last = queries.findLastIndex((sql) => sql.includes("for update"));
  assert.match(queries[last - 1], /profiles.*for update/);
});

test("bonus credit preserves existing fractional kyat without counting it as a new deposit", async () => {
  const user = await player(1000, 95); await deposit(user);
  assert.deepEqual(await balance(user), { balance: "11000", balance_minor: 95 });
  assert.equal(await remaining(user), 300000n);
});

test("pending and cancelled bets cannot unlock bonus money; only settled actual stakes count", async () => {
  const user = await player(); await deposit(user);
  const debit = bet(user, 100000); assert.equal((await call("debit", debit)).status, "OK");
  assert.equal(await remaining(user), 300000n);
  assert.equal((await call("rollback", { ...debit, debit_transaction_id: debit.transaction_id, transaction_id: randomUUID() })).status, "OK");
  assert.equal(await remaining(user), 300000n);
  await settled(user, 100000, 100000, { game_code: "shankoemee", stake: 20000 });
  assert.equal(await remaining(user), 299800n);
  await settled(user, 100000, 100000, { game_code: "africanbuffaloplus", stake: 20000 });
  assert.equal(await remaining(user), 298800n);
  await settled(user, 100000, 100000, { reason: "BANK_DEPOSIT", game_code: "shankoemee" });
  assert.equal(await remaining(user), 298800n);
});

test("withdrawal stays blocked with a Burmese remaining-wager error until all 30x is settled", async () => {
  const user = await player(); await deposit(user);
  const blocked = await reserve(user); assert.equal(blocked.code, "WAGERING_REQUIRED");
  assert.match(blocked.message, /[\u1000-\u109f]/); assert.equal(blocked.remainingWagering, "300000");
  for (let i = 0; i < 30; i++) await settled(user, 1000000);
  assert.equal(await remaining(user), 0n); assert.equal((await reserve(user)).state, "reserved");
});

test("exhausting the balance clears outstanding wagering without renewing the bonus entitlement", async () => {
  const user = await player(); await deposit(user);
  await settled(user, 1000000, 0);
  assert.deepEqual(await balance(user), { balance: "0", balance_minor: 0 });
  assert.equal(await remaining(user), 0n); assert.equal(await eligible(user), false);
  assert.equal((await deposit(user)).bonusAmount, 0); assert.equal(await remaining(user), 5000n);
});

test("fractional balances, open game reserves and pending withdrawals cannot erase the requirement", async () => {
  const user = await player(); await deposit(user);
  const debit = bet(user, 1000000); assert.equal((await call("debit", debit)).status, "OK");
  await deposit(user, 1000); assert.equal(await remaining(user), 301000n);
  // Return a single minor unit: a zero whole-kyat balance alone must not reset.
  assert.equal((await call("credit", credit(debit, 1))).status, "OK");
  await db.query("update public.profiles set balance=0 where id=$1", [user.userId]);
  await deposit(user, 1000); assert.equal(await remaining(user), 292000n);
  const held = await player(); await deposit(held);
  await db.query("update public.profiles set balance=0 where id=$1", [held.userId]);
  await db.query("insert into public.withdrawals(user_id,service_type,order_id,amount,payout_phone,status) values($1,'kbzpay',$2,1000,'09123456789','pending')", [held.userId, randomUUID()]);
  await deposit(held, 1000); assert.equal(await remaining(held), 301000n);
});

test("minor-unit stakes retain exact arithmetic and bonus requirements never overflow JavaScript numbers", async () => {
  const user = await player(); await deposit(user);
  await settled(user, 1); assert.equal(await remaining(user), 300000n);
  await settled(user, 99); assert.equal(await remaining(user), 299999n);
  const huge = await player(); const amount = MAX_MONEY - 5000n;
  const result = await deposit(huge, Number(amount));
  assert.equal(result.balance, Number(MAX_MONEY));
  assert.equal(result.wageringRequired, (MAX_MONEY * 30n).toString());
  assert.equal(await remaining(huge), MAX_MONEY * 30n);
  assert.equal(remainingWagering([{ kind: "DEPOSIT", amount: MAX_MONEY.toString(), wagering_multiplier: 30 }]), MAX_MONEY * 30n);
});

test("unsupported balance overflow never partly credits or consumes the bonus", async () => {
  const user = await player(MAX_MONEY - 9999n);
  await assert.rejects(() => deposit(user), /range/);
  assert.deepEqual(await balance(user), { balance: (MAX_MONEY - 9999n).toString(), balance_minor: 0 });
  assert.equal(await eligible(user), true); assert.equal(await remaining(user), 0n);
});

test("campaign is not active before its configured launch; missing storage stops credits safely", async () => {
  const user = await player(); await db.exec("update public.deposit_bonus_campaign set starts_at='infinity'");
  assert.equal(await eligible(user), false); assert.equal((await deposit(user)).bonusAmount, 0);
  queryFault = (sql) => { if (/from public.deposit_bonus_campaign/.test(sql)) throw new Error("Missing promotion storage"); };
  await assert.rejects(() => deposit(user), /Missing promotion storage/);
  queryFault = undefined;
  assert.deepEqual(await balance(user), { balance: "5000", balance_minor: 0 });
});

test("preparing the migration does not launch the offer; simultaneous first lookups establish one durable cutoff", async () => {
  const old = await player(); await oldDeposit(old); const fresh = await player();
  await db.exec("delete from public.deposit_bonus_campaign");
  await migration("013_first_deposit_bonus.sql");
  assert.equal((await db.query("select count(*)::int as count from public.deposit_bonus_campaign")).rows[0].count, 0);
  const results = await Promise.all([eligible(old), eligible(fresh)]);
  assert.deepEqual(results, [false, true]);
  const started = (await db.query("select starts_at from public.deposit_bonus_campaign")).rows[0].starts_at.toISOString();
  await eligible(fresh); await migration("013_first_deposit_bonus.sql");
  assert.equal((await db.query("select starts_at from public.deposit_bonus_campaign")).rows[0].starts_at.toISOString(), started);
  assert.equal((await deposit(fresh)).bonusAmount, 5000);
});

test("a small deposit that starts the promotion itself retains eligibility at the exact launch boundary", async () => {
  const user = await player(); await db.exec("delete from public.deposit_bonus_campaign");
  assert.equal((await deposit(user, 1000)).bonusAmount, 0);
  assert.equal(await eligible(user), true);
  assert.equal((await deposit(user)).bonusAmount, 5000);
  assert.equal(await remaining(user), 301000n);
});

test("outdated forms must refresh to see the 30x terms before payment verification is sent", async (t) => {
  const user = await player(); activeUser = user.userId;
  const keys = { payment_secret: "test-key", kbzreceiver: "09123456789" };
  for (const [key, value] of Object.entries(keys)) {
    const old = process.env[key]; process.env[key] = value;
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
  }
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("Must not verify undisclosed bonus"); });
  const req = { method: "POST", headers: { origin: "https://www.j777ml.com", "content-type": "application/json" } };
  const result = await handleWalletProxy({ req, functionName: "wallet-deposit", payload: { service_type: "kbzpay", amount: 5000, transaction_id: "123456" } });
  assert.equal(result.status, 409); assert.equal(result.body.code, "BONUS_TERMS_REFRESH");
  assert.match(result.body.error, /[\u1000-\u109f]/); assert.equal(fetch.mock.callCount(), 0);
  assert.equal(await eligible(user), true); assert.deepEqual(await balance(user), { balance: "0", balance_minor: 0 });
});

test("migration reruns preserve the original launch date, balances, award and wagering", async () => {
  const user = await player(); await deposit(user);
  await migration("013_first_deposit_bonus.sql"); await migration("013_first_deposit_bonus.sql");
  assert.equal((await db.query("select starts_at from public.deposit_bonus_campaign")).rows[0].starts_at.toISOString(), "2020-01-01T00:00:00.000Z");
  assert.equal(await eligible(user), false); assert.equal(await remaining(user), 300000n);
  assert.deepEqual(await balance(user), { balance: "10000", balance_minor: 0 });
});

test("wallet configuration is scoped to the signed-in player; forged bonus flags and IDs are ignored", async () => {
  const user = await player(); const other = await player(); await deposit(other);
  const req = { method: "GET", headers: {} };
  assert.equal((await handleWalletProxy({ req, functionName: "wallet-config" })).status, 401);
  activeUser = user.userId;
  const config = await handleWalletProxy({ req, functionName: "wallet-config", payload: { user_id: other.userId, bonus: 999999 } });
  assert.equal(config.body.promotion.eligible, true); assert.equal(config.body.promotion.bonus, 5000);
  activeUser = other.userId;
  assert.equal((await handleWalletProxy({ req, functionName: "wallet-config" })).body.promotion.eligible, false);
  assert.equal((await walletHistory(user.userId)).length, 0);
  const own = await walletHistory(other.userId); assert.equal(Number(own[0].amount), 5000); assert.equal(Number(own[0].bonus_amount), 5000);
});

test("admin audit shows lifetime bonus outside recent deposits; cash reporting excludes bonus credit", async () => {
  const user = await player(); const order = randomUUID(); await deposit(user, 5000, order);
  for (let i = 0; i < 26; i++) await deposit(user, 1000);
  const login = await handleAdminApi({ method: "POST", url: "/api/admin", headers: { origin: "https://www.j777ml.com", "content-type": "application/json" }, body: { action: "login", password: process.env.admin_secret } });
  assert.equal(login.status, 200);
  const headers = { cookie: login.headers["Set-Cookie"].split(";", 1)[0] };
  const detail = await handleAdminApi({ method: "GET", url: `/api/admin?view=user&user_id=${user.userId}`, headers });
  assert.equal(detail.status, 200); assert.equal(detail.body.bonus.order_id, order);
  assert.equal(Number(detail.body.bonus.wagering_required), 300000); assert.equal(detail.body.deposits.length, 25);
  const list = await handleAdminApi({ method: "GET", url: "/api/admin?view=deposits", headers });
  assert.equal(list.status, 200); assert.equal(list.body.deposits.filter((row) => Number(row.bonus_amount) > 0).length, 1);
  const { summary } = await readAdminOverview(pool, overviewWindow("all"));
  assert.equal(Number(summary.deposit_total), 31000); assert.equal(Number(summary.bonus_total), 5000);
  assert.equal(Number(summary.bonus_count), 1); assert.equal(Number(summary.net_cash_flow), 31000);
  assert.equal(Number(summary.total_balance), 36000);
});
