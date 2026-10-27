import { currentSession } from "./auth.mjs";
import { getPool } from "./neon.mjs";
import { normalizePhone } from "./phone.mjs";

const PAGE_SIZE = 50;
const MAX_PAGE = 1_000_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function adminPhones() {
  return new Set(
    String(process.env.ADMIN_PHONES ?? "")
      .split(",")
      .map((phone) => normalizePhone(phone))
      .filter(Boolean),
  );
}

async function authorize(req) {
  const allowedPhones = adminPhones();
  if (!allowedPhones.size) return { status: 503, body: { error: "Admin access is not configured" } };
  const session = await currentSession(req);
  if (!session?.user) return { status: 401, body: { error: "Sign in with your admin account to continue" } };
  if (!allowedPhones.has(session.user.name)) return { status: 403, body: { error: "This account is not approved for admin access" } };
  return { session };
}

function pageParams(url) {
  const page = Math.min(MAX_PAGE, Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1));
  return { page, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE };
}

async function overview(pool) {
  const result = await pool.query(
    `select
       (select count(*) from public.profiles) as users,
       (select count(*) from public.profiles where created_at >= date_trunc('day', now())) as new_users_today,
       (select coalesce(sum(balance), 0) from public.profiles) as total_balance,
       (select count(*) from public.slot_bets) as bet_count,
       (select coalesce(sum(bet), 0) from public.slot_bets) as bet_total,
       (select coalesce(sum(win), 0) from public.slot_bets) as win_total,
       (select count(*) from public.deposits) as deposit_count,
       (select coalesce(sum(amount), 0) from public.deposits where status = 'verified') as deposit_total,
       (select count(*) from public.withdrawals) as withdrawal_count,
       (select count(*) from public.withdrawals where status = 'pending') as pending_withdrawals,
       (select coalesce(sum(amount), 0) from public.withdrawals where status = 'paid') as withdrawal_total,
       (select count(*) from public.withdrawals where status = 'failed') as failed_withdrawals`,
  );
  const [latestWithdrawals, latestBets] = await Promise.all([
    pool.query(
      `select w.order_id, w.user_id, p.phone, w.service_type, w.amount, w.status, w.created_at
         from public.withdrawals w join public.profiles p on p.id = w.user_id
        order by w.created_at desc limit 8`,
    ),
    pool.query(
      `select b.bet_uid, b.round_id, b.bet, b.win, b.created_at, p.id as user_id, p.phone
         from public.slot_bets b join public.profiles p on p.id = b.user_id
        order by b.created_at desc limit 8`,
    ),
  ]);
  return { summary: result.rows[0], latestWithdrawals: latestWithdrawals.rows, latestBets: latestBets.rows };
}

async function users(pool, url) {
  const { page, limit, offset } = pageParams(url);
  const search = (url.searchParams.get("search") || "").trim().slice(0, 100);
  const pattern = `%${search}%`;
  const [list, count] = await Promise.all([
    pool.query(
      `select id, phone, balance, game_uid, created_at
         from public.profiles
        where $1 = '' or phone ilike $2 or game_uid ilike $2 or id::text ilike $2
        order by created_at desc limit $3 offset $4`,
      [search, pattern, limit, offset],
    ),
    pool.query(
      `select count(*) as total from public.profiles
        where $1 = '' or phone ilike $2 or game_uid ilike $2 or id::text ilike $2`,
      [search, pattern],
    ),
  ]);
  return { users: list.rows, total: Number(count.rows[0]?.total ?? 0), page, pageSize: limit };
}

async function bets(pool, url) {
  const { page, limit, offset } = pageParams(url);
  const search = (url.searchParams.get("search") || "").trim().slice(0, 100);
  const pattern = `%${search}%`;
  const [list, count] = await Promise.all([
    pool.query(
      `select b.bet_uid, b.round_id, b.bet, b.win, b.changemoney, b.balance_after,
              b.game_id, b.room_id, b.created_at, p.id as user_id, p.phone, p.game_uid
         from public.slot_bets b join public.profiles p on p.id = b.user_id
        where $1 = '' or p.phone ilike $2 or p.game_uid ilike $2 or b.bet_uid ilike $2 or b.round_id ilike $2
        order by b.created_at desc limit $3 offset $4`,
      [search, pattern, limit, offset],
    ),
    pool.query(
      `select count(*) as total
         from public.slot_bets b join public.profiles p on p.id = b.user_id
        where $1 = '' or p.phone ilike $2 or p.game_uid ilike $2 or b.bet_uid ilike $2 or b.round_id ilike $2`,
      [search, pattern],
    ),
  ]);
  return { bets: list.rows, total: Number(count.rows[0]?.total ?? 0), page, pageSize: limit };
}

async function walletList(pool, url, kind) {
  const table = kind === "deposit" ? "deposits" : "withdrawals";
  const { page, limit, offset } = pageParams(url);
  const search = (url.searchParams.get("search") || "").trim().slice(0, 100);
  const status = (url.searchParams.get("status") || "").trim().slice(0, 20);
  const pattern = `%${search}%`;
  const params = [search, pattern, status, limit, offset];
  const [list, count] = await Promise.all([
    pool.query(
      `select w.order_id, w.user_id, p.phone, p.game_uid, w.service_type, w.amount, w.status,
              w.message, w.created_at, w.completed_at, w.provider_txn_id,
              ${kind === "deposit" ? "w.transaction_id" : "w.payout_phone"} as reference
         from public.${table} w join public.profiles p on p.id = w.user_id
        where ($1 = '' or p.phone ilike $2 or p.game_uid ilike $2 or w.order_id ilike $2)
          and ($3 = '' or w.status = $3)
        order by w.created_at desc limit $4 offset $5`,
      params,
    ),
    pool.query(
      `select count(*) as total from public.${table} w join public.profiles p on p.id = w.user_id
        where ($1 = '' or p.phone ilike $2 or p.game_uid ilike $2 or w.order_id ilike $2)
          and ($3 = '' or w.status = $3)`,
      params.slice(0, 3),
    ),
  ]);
  return { [kind === "deposit" ? "deposits" : "withdrawals"]: list.rows, total: Number(count.rows[0]?.total ?? 0), page, pageSize: limit };
}

async function userDetails(pool, userId) {
  if (!UUID_RE.test(userId)) return { status: 400, body: { error: "Invalid user id" } };
  const [profile, bets, deposits, withdrawals] = await Promise.all([
    pool.query("select id, phone, balance, game_uid, created_at from public.profiles where id = $1::uuid", [userId]),
    pool.query("select bet_uid, round_id, bet, win, changemoney, balance_after, game_id, room_id, created_at from public.slot_bets where user_id = $1::uuid order by created_at desc limit 25", [userId]),
    pool.query("select order_id, service_type, amount, transaction_id, status, message, created_at, completed_at from public.deposits where user_id = $1::uuid order by created_at desc limit 25", [userId]),
    pool.query("select order_id, service_type, amount, payout_phone, provider_txn_id, status, message, created_at, completed_at from public.withdrawals where user_id = $1::uuid order by created_at desc limit 25", [userId]),
  ]);
  if (!profile.rowCount) return { status: 404, body: { error: "User not found" } };
  return { user: profile.rows[0], bets: bets.rows, deposits: deposits.rows, withdrawals: withdrawals.rows };
}

export async function handleAdminApi(req) {
  const authorization = await authorize(req);
  if (!authorization.session) return authorization;
  if (req.method !== "GET") return { status: 405, body: { error: "Method not allowed" } };

  const url = new URL(req.url ?? "/api/admin", "http://localhost");
  const view = url.searchParams.get("view") || "overview";
  const pool = getPool();

  try {
    if (view === "overview") return { status: 200, body: await overview(pool) };
    if (view === "users") return { status: 200, body: await users(pool, url) };
    if (view === "bets") return { status: 200, body: await bets(pool, url) };
    if (view === "deposits") return { status: 200, body: await walletList(pool, url, "deposit") };
    if (view === "withdrawals") return { status: 200, body: await walletList(pool, url, "withdraw") };
    if (view === "user") {
      const result = await userDetails(pool, url.searchParams.get("user_id") || "");
      return result.status ? result : { status: 200, body: result };
    }
    return { status: 400, body: { error: "Unknown admin view" } };
  } catch (error) {
    console.error("Admin dashboard query failed", error);
    return { status: 500, body: { error: "Could not load admin data" } };
  }
}
