import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { after, before, beforeEach, mock, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import ts from "typescript";
import { adminGameHistory, playerGameHistory } from "../server/game-history.mjs";
import { overviewWindow, readAdminOverview } from "../server/admin-overview.mjs";

// Real callback writes and reporting queries, in an isolated Postgres engine.
// No bank, provider or production database is contacted.
const db = new PGlite();
let currentUser;
let phoneSequence = 100000000;
const clientFor = (connection) => ({ async query(sql, params) {
  const result = await connection.query(sql, params);
  return { rows: result.rows, rowCount: /^\s*select/i.test(sql) ? result.rows.length : result.affectedRows };
} });
const pool = clientFor(db);
mock.module("../server/neon.mjs", { namedExports: { getPool: () => pool, withTransaction: (fn) => db.transaction((tx) => fn(clientFor(tx))) } });
mock.module("../server/auth.mjs", { namedExports: { currentSession: async () => currentUser ? { user: { id: currentUser } } : null } });
mock.module("../server/rate-limit.mjs", { namedExports: { consumeRateLimit: async () => null } });
mock.module("../server/skm-api.mjs", { namedExports: { listProviderGames: async () => [] } });
const { createSkmGameSession, processSkmWalletCallback } = await import("../server/skm-wallet.mjs");
const { default: playerHandler } = await import("../api/profile/bets.js");
const { handleAdminApi } = await import("../server/admin-api.mjs");
const envKeys = ["admin_secret", "ADMIN_TOTP_SECRET", "ADMIN_MFA_REQUIRED"];
const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
before(async () => {
  for (const name of ["001_app_schema.sql", "002_phone_auth.sql", "005_skm_seamless_wallet.sql", "006_game_display_settings.sql", "008_deposit_wagering.sql", "009_auth_security.sql", "010_money_constraints.sql", "012_game_minor_units.sql"]) {
    await db.exec((await readFile(new URL(`../neon/${name}`, import.meta.url), "utf8")).replace("create extension if not exists pgcrypto;", ""));
  }
  process.env.admin_secret = "test-history-admin-secret";
  delete process.env.ADMIN_TOTP_SECRET; process.env.ADMIN_MFA_REQUIRED = "false";
});
beforeEach(async () => { await db.exec("truncate public.profiles cascade"); currentUser = undefined; });
after(async () => {
  for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await db.close();
});
async function player(balance = 10000) {
  const id = randomUUID();
  await db.query("insert into public.profiles(id,phone,balance) values($1,$2,$3)", [id, `+959${phoneSequence++}`, balance]);
  return { userId: id, ...await createSkmGameSession(id) };
}
const bet = (user, amount = 10000, extra = {}) => ({ player_id: user.player_id, token: user.token, currency: "MMK", transaction_id: randomUUID(), round_id: randomUUID(), game_code: "goldencentury", reason: "BET_HOLD", amount, ...extra });
const credit = (debit, amount) => ({ ...debit, transaction_id: randomUUID(), debit_transaction_id: debit.transaction_id, reason: debit.reason === "BANK_DEPOSIT" ? "BANK_RETURN" : "BET_SETTLE", amount, round_closed: true });
const refund = (debit) => ({ ...debit, transaction_id: randomUUID(), debit_transaction_id: debit.transaction_id });
const call = (route, payload) => processSkmWalletCallback(route, payload, JSON.stringify(payload));
async function play(user, debit, amount) {
  assert.equal((await call("debit", debit)).status, "OK");
  const payout = credit(debit, amount); assert.equal((await call("credit", payout)).status, "OK");
  return payout;
}
const overview = (range = overviewWindow("all")) => readAdminOverview(pool, range);
const history = (user) => playerGameHistory(pool, user.userId, 100);
const adminHistory = (search = "", page = 1, limit = 50) => adminGameHistory(pool, { search, page, limit, offset: (page - 1) * limit });
const response = () => ({ headers: {}, setHeader(key, value) { this.headers[key.toLowerCase()] = value; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
async function financialSnapshot() {
  const result = await db.query(`select
    (select jsonb_agg(to_jsonb(p) order by id) from public.profiles p) as profiles,
    (select jsonb_agg(to_jsonb(t) order by id) from public.skm_wallet_transactions t) as ledger,
    (select jsonb_agg(to_jsonb(w) order by id) from public.wallet_wagering_events w) as wagering`);
  return result.rows[0];
}

test("new slot bets reach player history and overview exactly once after repeated callbacks", async () => {
  const user = await player(); const debit = bet(user);
  const payout = await play(user, debit, 19500);
  assert.equal((await call("credit", payout)).status, "DUPLICATE");
  const rows = await history(user); assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "skm"); assert.equal(rows[0].game_code, "goldencentury");
  assert.equal(Number(rows[0].bet), 100); assert.equal(Number(rows[0].win), 195); assert.equal(Number(rows[0].changemoney), 95);
  const result = await overview();
  assert.equal(Number(result.summary.bet_count), 1); assert.equal(Number(result.summary.bet_total), 100); assert.equal(Number(result.summary.win_total), 195);
  assert.equal(result.latestBets[0].transaction_id, debit.transaction_id);
});

test("card reporting uses the actual stake and removes unused collateral from winnings", async () => {
  const user = await player(); const debit = bet(user, 500000, { game_code: "shankoemee", stake: 100000 });
  await play(user, debit, 595000);
  const [row] = await history(user);
  assert.equal(Number(row.held_amount), 5000); assert.equal(Number(row.bet), 1000);
  assert.equal(Number(row.returned_amount), 5950); assert.equal(Number(row.win), 1950); assert.equal(Number(row.changemoney), 950);
  assert.equal(Number((await overview()).summary.bet_total), 1000);
});

test("full multiplier losses keep negative reported wins and the full wallet loss", async () => {
  const user = await player(); const debit = bet(user, 500000, { game_code: "abcd", stake: 100000 });
  await play(user, debit, 0);
  const [row] = await history(user);
  assert.equal(Number(row.win), -4000); assert.equal(Number(row.changemoney), -5000); assert.equal(row.status, "settled");
  assert.equal(Number((await overview()).summary.win_total), -4000);
});

test("separate chips in the same round remain separate bets with stable pagination", async () => {
  const user = await player(); const round_id = randomUUID();
  for (let index = 0; index < 4; index++) {
    const debit = bet(user, 50000, { game_code: "abcd", stake: 10000, round_id }); await play(user, debit, 50000);
  }
  assert.equal((await history(user)).length, 4);
  const first = await adminHistory("", 1, 2); const second = await adminHistory("", 2, 2);
  assert.equal(first.total, 4); assert.equal(second.total, 4);
  assert.equal(new Set([...first.bets, ...second.bets].map((row) => row.bet_uid)).size, 4);
  assert.equal(Number((await overview()).summary.bet_total), 400);
});

test("slot feature purchases count the actual full purchase rather than the smaller base stake", async () => {
  const user = await player(); await play(user, bet(user, 500000, { game_code: "africanbuffaloplus", stake: 10000 }), 0);
  const [row] = await history(user); assert.equal(Number(row.bet), 5000); assert.equal(Number(row.changemoney), -5000);
});

test("pending and cancelled bets are visible without inventing wins or inflating settled totals", async () => {
  const user = await player(); const pending = bet(user); const cancelled = bet(user);
  await call("debit", pending); await call("debit", cancelled);
  const rollback = refund(cancelled); await call("rollback", rollback); await call("rollback", rollback);
  const rows = await history(user);
  const open = rows.find((row) => row.transaction_id === pending.transaction_id);
  assert.equal(open.status, "pending"); assert.equal(open.win, null); assert.equal(open.changemoney, null); assert.equal(open.settled_at, null);
  const closed = rows.find((row) => row.transaction_id === cancelled.transaction_id);
  assert.equal(closed.status, "cancelled"); assert.equal(closed.win, null); assert.equal(Number(closed.changemoney), 0);
  const { summary } = await overview();
  assert.equal(Number(summary.bet_count), 2); assert.equal(Number(summary.pending_bet_count), 1); assert.equal(Number(summary.cancelled_bet_count), 1);
  assert.equal(Number(summary.bet_total), 0); assert.equal(Number(summary.win_total), 0);
});

test("rollback tombstones without an accepted debit never appear as played games", async () => {
  const user = await player(); const debit = bet(user);
  await call("rollback", refund(debit)); assert.equal((await call("debit", debit)).status, "ERROR");
  assert.equal((await history(user)).length, 0); assert.equal(Number((await overview()).summary.bet_count), 0);
});

test("banker reserves and returns are separate from wager volume and reported wins", async () => {
  const user = await player(); const debit = bet(user, 500000, { game_code: "shankoemee", reason: "BANK_DEPOSIT" });
  await play(user, debit, 650000);
  const [row] = await history(user); assert.equal(row.activity_type, "banker"); assert.equal(Number(row.held_amount), 5000);
  assert.equal(Number(row.bet), 0); assert.equal(row.win, null); assert.equal(Number(row.changemoney), 1500);
  const { summary } = await overview();
  assert.equal(Number(summary.bet_count), 0); assert.equal(Number(summary.bet_total), 0); assert.equal(Number(summary.win_total), 0);
  assert.equal(Number(summary.banker_count), 1); assert.equal(Number(summary.banker_result), 1500);
});

test("minor-unit fractions survive history, while old wallet-unit rows remain unchanged", async () => {
  const user = await player(); const debit = bet(user, 1); await play(user, debit, 96);
  const [row] = await history(user); assert.equal(Number(row.bet), 0.01); assert.equal(Number(row.win), 0.96); assert.equal(Number(row.changemoney), 0.95);
  // A settled pre-fix ledger used app kyat. The reporting scale must preserve it.
  await db.query("update public.skm_wallet_transactions set unit_scale=1 where user_id=$1", [user.userId]);
  await db.query("update public.wallet_wagering_events set amount_scale=1 where user_id=$1", [user.userId]);
  const [old] = await history(user); assert.equal(Number(old.bet), 1); assert.equal(Number(old.win), 96); assert.equal(Number(old.changemoney), 95);
});

test("legacy records remain visible without identifier collisions or double counting", async () => {
  const user = await player(); const debit = bet(user); await play(user, debit, 20000);
  await db.query("insert into public.slot_bets(user_id,uid,bet_uid,bet,win,changemoney,balance_after) values($1,'legacy',$2,25,50,25,100)", [user.userId, debit.transaction_id]);
  const rows = await history(user); assert.equal(rows.length, 2); assert.equal(new Set(rows.map((row) => row.bet_uid)).size, 2);
  assert.deepEqual(rows.map((row) => row.source).sort(), ["legacy", "skm"]);
  const { summary } = await overview(); assert.equal(Number(summary.bet_total), 125); assert.equal(Number(summary.win_total), 250);
});

test("settlements are reported in the period they close, using Myanmar time", async () => {
  const user = await player(); const debit = bet(user); const payout = await play(user, debit, 19500);
  await db.query("update public.skm_wallet_transactions set created_at=$2 where transaction_id=$1", [debit.transaction_id, "2026-10-29T17:29:59Z"]);
  await db.query("update public.skm_wallet_transactions set created_at=$2 where transaction_id=$1", [payout.transaction_id, "2026-10-29T17:30:00Z"]);
  const today = await overview(overviewWindow("today", new Date("2026-10-30T12:00:00Z")));
  const yesterday = await overview(overviewWindow("yesterday", new Date("2026-10-30T12:00:00Z")));
  assert.equal(Number(today.summary.bet_total), 100); assert.equal(Number(today.summary.win_total), 195);
  assert.equal(Number(yesterday.summary.bet_total), 0); assert.equal(today.latestBets.length, 1); assert.equal(yesterday.latestBets.length, 0);
});

test("the player endpoint ignores a forged user ID and exposes neither other players nor session tokens", async () => {
  const user = await player(); const other = await player();
  await play(user, bet(user), 10000); await play(other, bet(other), 10000);
  currentUser = user.userId;
  const res = response(); await playerHandler({ method: "GET", url: `/api/profile/bets?user_id=${other.userId}` }, res);
  assert.equal(res.statusCode, 200); assert.equal(res.headers["cache-control"], "private, no-store"); assert.equal(res.body.length, 1);
  const own = (await history(user))[0].transaction_id; assert.equal(res.body[0].transaction_id, own);
  for (const secret of [user.token, other.token, other.userId]) assert.ok(!JSON.stringify(res.body).includes(secret));
  currentUser = undefined; const anonymous = response(); await playerHandler({ method: "GET" }, anonymous); assert.equal(anonymous.statusCode, 401);
  const post = response(); await playerHandler({ method: "POST" }, post); assert.equal(post.statusCode, 405);
});

test("admin search, overview and individual history use the same ledger behind the existing session gate", async () => {
  const user = await player(); const debit = bet(user); await play(user, debit, 19500);
  const req = (url, cookie) => ({ method: "GET", url, headers: { cookie } });
  assert.equal((await handleAdminApi(req("/api/admin?view=bets"))).status, 401);
  const login = await handleAdminApi({ method: "POST", url: "/api/admin", headers: { origin: "https://www.j777ml.com", "content-type": "application/json" }, body: { action: "login", password: process.env.admin_secret } });
  assert.equal(login.status, 200); const cookie = login.headers["Set-Cookie"].split(";", 1)[0];
  for (const search of [debit.transaction_id, debit.round_id, "goldencentury", user.userId]) {
    const result = await handleAdminApi(req(`/api/admin?view=bets&search=${encodeURIComponent(search)}`, cookie));
    assert.equal(result.status, 200); assert.equal(result.body.total, 1); assert.equal(Number(result.body.bets[0].win), 195);
  }
  assert.equal((await adminHistory("'; drop table profiles; --")).total, 0);
  const detail = await handleAdminApi(req(`/api/admin?view=user&user_id=${user.userId}`, cookie));
  assert.equal(detail.status, 200); assert.equal(detail.body.bets.length, 1);
  const report = await handleAdminApi(req("/api/admin?view=overview&range=all", cookie));
  assert.equal(report.status, 200); assert.equal(Number(report.body.summary.bet_total), 100);
});

test("history and overview queries never change balances, wagering or wallet transactions", async () => {
  const user = await player(); await play(user, bet(user), 19500);
  const snapshot = await financialSnapshot();
  await history(user); await adminHistory(); await overview();
  assert.deepEqual(await financialSnapshot(), snapshot);
});

const compile = async (path) => ts.transpileModule(await readFile(new URL(path, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const formatExports = {}; runInNewContext(await compile("../src/lib/format-money.ts"), { exports: formatExports });
const historyExports = {};
const jsx = (type, props) => ({ type, props });
runInNewContext(await compile("../src/GameHistory.tsx"), { exports: historyExports, require: (name) => name === "./lib/format-money" ? formatExports : { jsx, jsxs: jsx } });
function text(tree) {
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  if (Array.isArray(tree)) return tree.map(text).join("");
  return tree && typeof tree === "object" ? text(tree.props?.children) : "";
}

test("history displays exact amounts, game names and Burmese pending/cancelled/banker states", () => {
  const props = { games: [{ game_code: "goldencentury", name: "Golden Century" }], icon: "game", bets: [{ bet_uid: "test", game_code: "goldencentury", game_id: null, created_at: "2026-10-30T10:00:00Z", bet: "1000.0000", held_amount: "5000", win: "1950", changemoney: "950.010000", status: "settled", activity_type: "bet" }] };
  const settled = text(historyExports.default(props));
  assert.ok(settled.includes("Golden Century")); assert.ok(settled.includes("လောင်းကြေး 1,000 ကျပ်")); assert.ok(settled.includes("+950.01 ကျပ်")); assert.ok(!settled.includes("+1,950"));
  props.bets[0] = { ...props.bets[0], status: "pending", win: null, changemoney: null };
  const pending = text(historyExports.default(props)); assert.ok(pending.includes("စစ်ဆေးဆဲ")); assert.ok(!pending.includes("+0"));
  props.bets[0].status = "cancelled"; assert.ok(text(historyExports.default(props)).includes("ပယ်ဖျက်ပြီး"));
  props.bets[0].activity_type = "banker"; assert.ok(text(historyExports.default(props)).includes("သီးသန့်ငွေ 5,000 ကျပ်"));
  assert.equal(formatExports.formatMoney("9007199254740991.950000"), "9,007,199,254,740,991.95");
  assert.equal(formatExports.formatMoney("-4000.00", true), "−4,000");
  assert.equal(formatExports.formatMoney(null), "—");
});
