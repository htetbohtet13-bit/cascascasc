import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getPool } from "./neon.mjs";

const PAGE_SIZE = 50;
const MAX_PAGE = 1_000_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADMIN_SESSION_COOKIE = "casino_admin_session";
const ADMIN_SESSION_SECONDS = 12 * 60 * 60;

function adminSecret() {
  return String(process.env.admin_secret ?? process.env.ADMIN_SECRET ?? "");
}

function cookieValue(req, name) {
  const cookies = String(req.headers?.cookie ?? "").split(";");
  const pair = cookies.map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  try {
    return pair ? decodeURIComponent(pair.slice(name.length + 1)) : "";
  } catch {
    return "";
  }
}

function tokenSignature(payload, secret) {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

function createAdminSession(secret) {
  const payload = `${Math.floor(Date.now() / 1000)}.${randomBytes(18).toString("hex")}`;
  const token = `${payload}.${tokenSignature(payload, secret)}`;
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${ADMIN_SESSION_SECONDS}${secure}`;
}

function validAdminSession(req, secret) {
  const parts = cookieValue(req, ADMIN_SESSION_COOKIE).split(".");
  if (parts.length !== 3 || !/^\d+$/.test(parts[0]) || !/^[0-9a-f]{36}$/.test(parts[1]) || !/^[0-9a-f]{64}$/.test(parts[2])) return false;
  const issuedAt = Number(parts[0]);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(issuedAt) || issuedAt > now + 60 || now - issuedAt > ADMIN_SESSION_SECONDS) return false;
  const payload = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(tokenSignature(payload, secret), "hex");
  const actual = Buffer.from(parts[2], "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function passwordsMatch(attempt, secret) {
  const expected = createHash("sha256").update(secret).digest();
  const actual = createHash("sha256").update(attempt).digest();
  return timingSafeEqual(actual, expected);
}

function sameOrigin(req) {
  const origin = req.headers?.origin;
  const host = req.headers?.host;
  if (!origin || !host) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
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
       (select count(*) from public.withdrawals where status = 'failed') as failed_withdrawals,
       (select count(*) from public.games) as games_total,
       (select count(*) from public.games where is_active = true) as active_games`,
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

function validateGame(body) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const gameId = Number(body.game_id);
  const roomId = Number(body.room_id);
  const category = String(body.category ?? "slots");
  const imageUrl = typeof body.image_url === "string" ? body.image_url.trim() : "";
  const gradientStart = String(body.gradient_start ?? "#5c3918");
  const gradientEnd = String(body.gradient_end ?? "#d59612");
  const playersOnline = body.players_online === "" || body.players_online == null ? null : Number(body.players_online);
  const sortOrder = Number(body.sort_order ?? 0);
  const safeImageUrl = !imageUrl || (imageUrl.startsWith("/images/") && !imageUrl.startsWith("//")) || (() => {
    try { return new URL(imageUrl).protocol === "https:"; } catch { return false; }
  })();
  if (!name || name.length > 80) return { error: "Game name must be 1 to 80 characters" };
  if (!Number.isSafeInteger(gameId) || gameId < 1 || gameId > 2_147_483_647) return { error: "Enter a valid game ID" };
  if (!Number.isSafeInteger(roomId) || roomId < 1 || roomId > 2_147_483_647) return { error: "Enter a valid room ID" };
  if (!["slots", "cards", "buffalo", "other"].includes(category)) return { error: "Choose a valid game category" };
  if (!safeImageUrl) return { error: "Image must be an HTTPS link or a local /images/ path" };
  if (imageUrl.length > 2048) return { error: "Image link is too long" };
  if (!/^#[0-9a-f]{6}$/i.test(gradientStart) || !/^#[0-9a-f]{6}$/i.test(gradientEnd)) return { error: "Choose valid gradient colors" };
  if (playersOnline !== null && (!Number.isSafeInteger(playersOnline) || playersOnline < 0 || playersOnline > 2_147_483_647)) return { error: "Players online must be a non-negative whole number" };
  if (!Number.isSafeInteger(sortOrder) || sortOrder < -1_000_000 || sortOrder > 1_000_000) return { error: "Sort order is out of range" };
  return {
    values: [gameId, roomId, name, category, imageUrl || null, gradientStart, gradientEnd,
      playersOnline, Boolean(body.is_popular), Boolean(body.is_active), sortOrder],
  };
}

async function manageGame(pool, action, body) {
  if (action === "delete_game") {
    const id = Number(body.id);
    if (!Number.isSafeInteger(id) || id < 1) return { status: 400, body: { error: "Invalid game record" } };
    const result = await pool.query("delete from public.games where id = $1 returning id", [id]);
    return result.rowCount
      ? { status: 200, body: { ok: true } }
      : { status: 404, body: { error: "Game not found" } };
  }

  const parsed = validateGame(body);
  if (parsed.error) return { status: 400, body: { error: parsed.error } };
  const [gameId, roomId, name, category, imageUrl, gradientStart, gradientEnd, playersOnline, isPopular, isActive, sortOrder] = parsed.values;
  const recordId = Number(body.id);
  if (action === "update_game" && (!Number.isSafeInteger(recordId) || recordId < 1)) {
    return { status: 400, body: { error: "Invalid game record" } };
  }
  try {
    const result = action === "create_game"
      ? await pool.query(
        `insert into public.games
           (provider_game_id, room_id, name, category, image_url, gradient_start, gradient_end, players_online, is_popular, is_active, sort_order)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         returning id`,
        [gameId, roomId, name, category, imageUrl, gradientStart, gradientEnd, playersOnline, isPopular, isActive, sortOrder],
      )
      : await pool.query(
        `update public.games
            set provider_game_id = $2, room_id = $3, name = $4, category = $5, image_url = $6,
                gradient_start = $7, gradient_end = $8, players_online = $9, is_popular = $10,
                is_active = $11, sort_order = $12, updated_at = now()
          where id = $1
          returning id`,
        [recordId, gameId, roomId, name, category, imageUrl, gradientStart, gradientEnd, playersOnline, isPopular, isActive, sortOrder],
      );
    if (!result.rowCount) return { status: 404, body: { error: "Game not found" } };
    return { status: 200, body: { ok: true, id: result.rows[0].id } };
  } catch (error) {
    if (error?.code === "23505") return { status: 409, body: { error: "That game ID and room are already listed" } };
    throw error;
  }
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
  const url = new URL(req.url ?? "/api/admin", "http://localhost");
  const secret = adminSecret();
  if (Buffer.byteLength(secret, "utf8") < 16) {
    return { status: 503, body: { error: secret ? "Admin password must be at least 16 characters" : "Admin password is not configured" } };
  }

  if (req.method === "POST") {
    if (!sameOrigin(req)) return { status: 403, body: { error: "Request origin is not allowed" } };
    const action = req.body?.action;
    if (action === "login") {
      const attempt = typeof req.body?.password === "string" ? req.body.password.slice(0, 4096) : "";
      if (!passwordsMatch(attempt, secret)) return { status: 401, body: { error: "Password is incorrect" } };
      return { status: 200, headers: { "Set-Cookie": createAdminSession(secret) }, body: { ok: true } };
    }
    if (action === "logout") {
      const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
      return {
        status: 200,
        headers: { "Set-Cookie": `${ADMIN_SESSION_COOKIE}=; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=0${secure}` },
        body: { ok: true },
      };
    }
    if (!["create_game", "update_game", "delete_game"].includes(action)) return { status: 400, body: { error: "Unknown admin action" } };
    if (!validAdminSession(req, secret)) return { status: 401, body: { error: "Enter the admin password to continue" } };
    try {
      return await manageGame(getPool(), action, req.body ?? {});
    } catch (error) {
      console.error("Admin game update failed", error);
      return { status: 500, body: { error: "Could not save game details" } };
    }
  }
  if (req.method !== "GET") return { status: 405, body: { error: "Method not allowed" } };
  if (!validAdminSession(req, secret)) return { status: 401, body: { error: "Enter the admin password to continue" } };

  const view = url.searchParams.get("view") || "overview";
  const pool = getPool();

  try {
    if (view === "overview") return { status: 200, body: await overview(pool) };
    if (view === "users") return { status: 200, body: await users(pool, url) };
    if (view === "games") {
      const result = await pool.query(
        `select id, provider_game_id as game_id, room_id, name, category, image_url,
                gradient_start, gradient_end, players_online, is_popular, is_active, sort_order, created_at
           from public.games order by sort_order asc, id asc`,
      );
      return { status: 200, body: { games: result.rows } };
    }
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
