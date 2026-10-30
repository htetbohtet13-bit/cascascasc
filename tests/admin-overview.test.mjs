import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { overviewWindow, readAdminOverview } from "../server/admin-overview.mjs";

const db = new PGlite();
const pool = { query: (sql, params) => db.query(sql, params) };
const NOW = new Date("2026-10-30T14:00:00Z");
const times = { today: "2026-10-29T17:30:00Z", yesterday: "2026-10-29T17:29:59.999Z", week: "2026-10-25T17:30:00Z", month: "2026-09-30T17:30:00Z", old: "2026-09-01T00:00:00Z", nextDay: "2026-10-30T17:30:00Z" };
let owner;
async function migration(name) {
  await db.exec((await readFile(new URL(`../neon/${name}`, import.meta.url), "utf8")).replace("create extension if not exists pgcrypto;", ""));
}
before(async () => {
  for (const name of ["001_app_schema.sql", "005_skm_seamless_wallet.sql", "008_deposit_wagering.sql", "010_money_constraints.sql", "012_game_minor_units.sql", "013_first_deposit_bonus.sql"]) await migration(name);
});
beforeEach(async () => {
  await db.exec("truncate public.profiles cascade");
  for (const [index, stamp] of Object.values(times).entries()) {
    const user = await db.query("insert into public.profiles(phone,balance,balance_minor,created_at) values($1,100,$2,$3) returning id", [`+959${123456780 + index}`, index === 4 ? 75 : 0, stamp]);
    if (index === 4) owner = user.rows[0].id;
  }
  const deposit = (amount, completed, status = "verified", created = completed) => db.query("insert into public.deposits(user_id,service_type,order_id,amount,status,created_at,completed_at) values($1,'kbzpay',$2,$3,$4,$5,$6)", [owner, randomUUID(), amount, status, created, completed]);
  await deposit(1000, times.today);
  await deposit(200, times.today, "verified", times.yesterday);
  await deposit(300, times.nextDay);
  await deposit(400, times.yesterday);
  await deposit(500, times.week);
  await deposit(600, times.month);
  await deposit(700, times.old);
  await deposit(800, times.today, "pending");
  await deposit(900, times.today, "failed");
  for (const [amount, completed, status, created] of [
    [900, times.today, "paid", times.yesterday], [100, times.yesterday, "paid", times.yesterday],
    [200, times.week, "paid", times.week], [300, times.month, "paid", times.month], [400, times.old, "paid", times.old],
    [800, null, "pending", times.today], [700, times.today, "failed", times.today],
  ]) await db.query("insert into public.withdrawals(user_id,service_type,order_id,amount,status,payout_phone,created_at,completed_at) values($1,'kbzpay',$2,$3,$4,'09123456789',$5,$6)", [owner, randomUUID(), amount, status, created, completed]);
  for (const [index, stamp] of [times.today, times.yesterday, times.nextDay].entries()) {
    await db.query("insert into public.slot_bets(user_id,uid,bet_uid,bet,win,changemoney,balance_after,created_at) values($1,'test',$2,100,50,-50,100,$3)", [owner, `test-bet-${index}`, stamp]);
  }
});
after(() => db.close());

test("calendar ranges use Myanmar midnight, Monday weeks and exclusive end boundaries", () => {
  assert.deepEqual(overviewWindow("today", NOW), { id: "today", start: "2026-10-29T17:30:00.000Z", end: "2026-10-30T17:30:00.000Z", timeZone: "Asia/Rangoon" });
  assert.equal(overviewWindow("yesterday", NOW).end, overviewWindow("today", NOW).start);
  assert.equal(overviewWindow("week", NOW).start, "2026-10-25T17:30:00.000Z");
  assert.equal(overviewWindow("week", NOW).end, "2026-11-01T17:30:00.000Z");
  assert.equal(overviewWindow("month", NOW).start, "2026-09-30T17:30:00.000Z");
  assert.equal(overviewWindow("month", NOW).end, "2026-10-31T17:30:00.000Z");
  const yearBoundary = overviewWindow("yesterday", new Date("2025-12-31T17:30:00Z"));
  assert.equal(yearBoundary.start, "2025-12-30T17:30:00.000Z");
  assert.equal(overviewWindow("month", new Date("2024-02-15T00:00:00Z")).end, "2024-02-29T17:30:00.000Z");
  assert.equal(overviewWindow("week", new Date("2026-11-01T17:30:00Z")).start, "2026-11-01T17:30:00.000Z");
  assert.equal(overviewWindow("all", NOW).start, null);
  for (const invalid of ["custom", "__proto__", "today'; drop table profiles; --"]) assert.equal(overviewWindow(invalid, NOW), null);
});

test("each range totals successful deposits and paid withdrawals at completion time", async () => {
  for (const [range, deposits, withdrawals, net, users] of [
    ["today", 1200, 900, 300, 1], ["yesterday", 400, 100, 300, 1],
    ["week", 2400, 1200, 1200, 4], ["month", 3000, 1500, 1500, 5], ["all", 3700, 1900, 1800, 6],
  ]) {
    const { summary } = await readAdminOverview(pool, overviewWindow(range, NOW));
    assert.equal(Number(summary.deposit_total), deposits, range);
    assert.equal(Number(summary.withdrawal_total), withdrawals, range);
    assert.equal(Number(summary.net_cash_flow), net, range);
    assert.equal(Number(summary.new_users), users, range);
    assert.equal(Number(summary.users), 6);
    assert.equal(Number(summary.total_balance), 600.75);
  }
});

test("activity lists and pending counts follow the selected range without double-counting midnight", async () => {
  const today = await readAdminOverview(pool, overviewWindow("today", NOW));
  assert.equal(Number(today.summary.bet_count), 1);
  assert.equal(Number(today.summary.bet_total), 100);
  assert.equal(Number(today.summary.pending_withdrawals), 1);
  assert.equal(Number(today.summary.failed_withdrawals), 1);
  assert.equal(today.latestBets.length, 1);
  assert.equal(today.latestWithdrawals.length, 3);
  const yesterday = await readAdminOverview(pool, overviewWindow("yesterday", NOW));
  assert.equal(yesterday.latestBets.length, 1);
  assert.equal(yesterday.latestWithdrawals.length, 1);
  assert.equal(Number(yesterday.summary.pending_withdrawals), 0);
});

test("cash flow remains signed and exact for large totals and excludes unpaid requests", async () => {
  await db.query("insert into public.withdrawals(user_id,service_type,order_id,amount,status,payout_phone,created_at,completed_at) values($1,'kbzpay',$2,9007199254740991,'paid','09123456789',$3,$3)", [owner, randomUUID(), times.today]);
  const result = await readAdminOverview(pool, overviewWindow("today", NOW));
  assert.equal(String(result.summary.net_cash_flow), String(300n - 9007199254740991n));
});

test("empty periods return zero figures while wallet balances remain live totals", async () => {
  const { summary, latestBets, latestWithdrawals } = await readAdminOverview(pool, overviewWindow("today", new Date("2020-01-01T12:00:00Z")));
  for (const key of ["deposit_total", "withdrawal_total", "net_cash_flow", "new_users", "bet_count", "pending_withdrawals"]) assert.equal(Number(summary[key]), 0);
  assert.equal(Number(summary.total_balance), 600.75);
  assert.equal(latestBets.length, 0); assert.equal(latestWithdrawals.length, 0);
});
