import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getPool, withTransaction } from "./neon.mjs";
import { listProviderGames } from "./skm-api.mjs";
import { applyGameDisplaySettings } from "./game-display.mjs";
import { unsafeRequestError } from "./request-security.mjs";
import { consumeRateLimit } from "./rate-limit.mjs";
import { adminMfaConfig, adminSessionKey, claimAdminTotp, matchingAdminTotpStep } from "./admin-mfa.mjs";
import { overviewWindow, readAdminOverview } from "./admin-overview.mjs";
import { adminGameHistory, playerGameHistory } from "./game-history.mjs";

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

function sessionHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

async function createAdminSession(secret, client = getPool()) {
  const payload = `${Math.floor(Date.now() / 1000)}.${randomBytes(18).toString("hex")}`;
  const token = `${payload}.${tokenSignature(payload, secret)}`;
  await client.query(
    `insert into public.auth_admin_sessions (token_hash, expires_at)
     values ($1, now() + ($2 * interval '1 second'))`,
    [sessionHash(token), ADMIN_SESSION_SECONDS],
  );
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${ADMIN_SESSION_SECONDS}${secure}`;
}

async function validAdminSession(req, secret) {
  const token = cookieValue(req, ADMIN_SESSION_COOKIE);
  const parts = token.split(".");
  if (parts.length !== 3 || !/^\d+$/.test(parts[0]) || !/^[0-9a-f]{36}$/.test(parts[1]) || !/^[0-9a-f]{64}$/.test(parts[2])) return false;
  const issuedAt = Number(parts[0]);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(issuedAt) || issuedAt > now + 60 || now - issuedAt > ADMIN_SESSION_SECONDS) return false;
  const payload = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(tokenSignature(payload, secret), "hex");
  const actual = Buffer.from(parts[2], "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
  const result = await getPool().query(
    "select 1 from public.auth_admin_sessions where token_hash = $1 and expires_at > now()",
    [sessionHash(token)],
  );
  return result.rows.length > 0;
}

function passwordsMatch(attempt, secret) {
  const expected = createHash("sha256").update(secret).digest();
  const actual = createHash("sha256").update(attempt).digest();
  return timingSafeEqual(actual, expected);
}

async function saveGameSettings(body) {
  const gameCode = typeof body?.game_code === "string" ? body.game_code.trim() : "";
  if (!/^[a-z0-9]{1,80}$/.test(gameCode)) {
    return { status: 400, body: { error: "Invalid provider game code" } };
  }

  const imageInput = typeof body?.image_url === "string" ? body.image_url.trim() : "";
  let imageUrl = null;
  if (imageInput) {
    if (imageInput.length > 2048) return { status: 400, body: { error: "Image URL is too long" } };
    try {
      const parsed = new URL(imageInput);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("invalid image URL");
      imageUrl = parsed.toString();
    } catch {
      return { status: 400, body: { error: "Enter a valid HTTPS image URL" } };
    }
  }

  const playersInput = body?.players_online;
  const playersOnline = playersInput === "" || playersInput == null ? null : Number(playersInput);
  if (playersOnline !== null && (!Number.isInteger(playersOnline) || playersOnline < 0 || playersOnline > 1_000_000_000)) {
    return { status: 400, body: { error: "Player count must be a whole number from 0 to 1,000,000,000" } };
  }

  const sortOrder = Number(body?.sort_order);
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 1_000_000) {
    return { status: 400, body: { error: "Sort order must be a whole number from 0 to 1,000,000" } };
  }
  if (typeof body?.is_active !== "boolean") {
    return { status: 400, body: { error: "Choose whether this game is visible" } };
  }

  try {
    await getPool().query(
      `insert into public.game_display_settings
         (game_code, image_url, players_online, sort_order, is_active, updated_at)
       values ($1, $2, $3, $4, $5, now())
       on conflict (game_code) do update set
         image_url = excluded.image_url,
         players_online = excluded.players_online,
         sort_order = excluded.sort_order,
         is_active = excluded.is_active,
         updated_at = now()`,
      [gameCode, imageUrl, playersOnline, sortOrder, body.is_active],
    );
  } catch (error) {
    if (error?.code === "42P01") {
      return { status: 503, body: { error: "Run neon/006_game_display_settings.sql in the Neon SQL Editor first" } };
    }
    throw error;
  }
  return { status: 200, body: { ok: true, game_code: gameCode } };
}

async function setGameVisibility(body) {
  const gameCode = typeof body?.game_code === "string" ? body.game_code.trim() : "";
  if (!/^[a-z0-9]{1,80}$/.test(gameCode)) {
    return { status: 400, body: { error: "Invalid provider game code" } };
  }
  if (typeof body?.is_active !== "boolean") {
    return { status: 400, body: { error: "Choose whether this game is visible" } };
  }

  try {
    await getPool().query(
      `insert into public.game_display_settings (game_code, is_active, updated_at)
       values ($1, $2, now())
       on conflict (game_code) do update set
         is_active = excluded.is_active,
         updated_at = now()`,
      [gameCode, body.is_active],
    );
  } catch (error) {
    if (error?.code === "42P01") {
      return { status: 503, body: { error: "Run neon/006_game_display_settings.sql in the Neon SQL Editor first" } };
    }
    throw error;
  }
  return { status: 200, body: { ok: true, game_code: gameCode, is_active: body.is_active } };
}

async function setGameHot(body) {
  const gameCode = typeof body?.game_code === "string" ? body.game_code.trim() : "";
  if (!/^[a-z0-9]{1,80}$/.test(gameCode)) {
    return { status: 400, body: { error: "Invalid provider game code" } };
  }
  if (typeof body?.is_hot !== "boolean") {
    return { status: 400, body: { error: "Choose whether this game is hot" } };
  }

  try {
    await getPool().query(
      `insert into public.game_display_settings (game_code, is_hot, updated_at)
       values ($1, $2, now())
       on conflict (game_code) do update set
         is_hot = excluded.is_hot,
         updated_at = now()`,
      [gameCode, body.is_hot],
    );
  } catch (error) {
    if (error?.code === "42P01") {
      return { status: 503, body: { error: "Run neon/006_game_display_settings.sql in the Neon SQL Editor first" } };
    }
    if (error?.code === "42703") {
      return { status: 503, body: { error: "Run neon/007_game_hot_setting.sql in the Neon SQL Editor to enable Hot games" } };
    }
    throw error;
  }
  return { status: 200, body: { ok: true, game_code: gameCode, is_hot: body.is_hot } };
}

function pageParams(url) {
  const page = Math.min(MAX_PAGE, Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1));
  return { page, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE };
}

async function overview(pool, range) {
  const result = await readAdminOverview(pool, range);
  let gameCount = null;
  try {
    gameCount = (await listProviderGames()).length;
  } catch (error) {
    console.error("Admin provider game list lookup failed", error);
  }
  return {
    ...result,
    summary: { ...result.summary, games_total: gameCount, active_games: gameCount },
  };
}

async function users(pool, url) {
  const { page, limit, offset } = pageParams(url);
  const search = (url.searchParams.get("search") || "").trim().slice(0, 100);
  const pattern = `%${search}%`;
  const [list, count] = await Promise.all([
    pool.query(
      `select id, phone, balance + balance_minor::numeric / 100 as balance, created_at
         from public.profiles
        where $1 = '' or phone ilike $2 or id::text ilike $2
        order by created_at desc limit $3 offset $4`,
      [search, pattern, limit, offset],
    ),
    pool.query(
      `select count(*) as total from public.profiles
        where $1 = '' or phone ilike $2 or id::text ilike $2`,
      [search, pattern],
    ),
  ]);
  return { users: list.rows, total: Number(count.rows[0]?.total ?? 0), page, pageSize: limit };
}

async function bets(pool, url) {
  const { page, limit, offset } = pageParams(url);
  const search = (url.searchParams.get("search") || "").trim().slice(0, 100);
  return adminGameHistory(pool, { page, limit, offset, search });
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
      `select w.order_id, w.user_id, p.phone, w.service_type, w.amount, w.status,
              w.message, w.created_at, w.completed_at, w.provider_txn_id,
              ${kind === "deposit" ? "w.transaction_id" : "w.payout_phone"} as reference
         from public.${table} w join public.profiles p on p.id = w.user_id
        where ($1 = '' or p.phone ilike $2 or p.id::text ilike $2 or w.order_id ilike $2)
          and ($3 = '' or w.status = $3)
        order by w.created_at desc limit $4 offset $5`,
      params,
    ),
    pool.query(
      `select count(*) as total from public.${table} w join public.profiles p on p.id = w.user_id
        where ($1 = '' or p.phone ilike $2 or p.id::text ilike $2 or w.order_id ilike $2)
          and ($3 = '' or w.status = $3)`,
      params.slice(0, 3),
    ),
  ]);
  return { [kind === "deposit" ? "deposits" : "withdrawals"]: list.rows, total: Number(count.rows[0]?.total ?? 0), page, pageSize: limit };
}

async function userDetails(pool, userId) {
  if (!UUID_RE.test(userId)) return { status: 400, body: { error: "Invalid user id" } };
  const [profile, bets, deposits, withdrawals] = await Promise.all([
    pool.query("select id, phone, balance + balance_minor::numeric / 100 as balance, created_at from public.profiles where id = $1::uuid", [userId]),
    playerGameHistory(pool, userId, 25),
    pool.query("select order_id, service_type, amount, transaction_id, status, message, created_at, completed_at from public.deposits where user_id = $1::uuid order by created_at desc limit 25", [userId]),
    pool.query("select order_id, service_type, amount, payout_phone, provider_txn_id, status, message, created_at, completed_at from public.withdrawals where user_id = $1::uuid order by created_at desc limit 25", [userId]),
  ]);
  if (!profile.rowCount) return { status: 404, body: { error: "User not found" } };
  return { user: profile.rows[0], bets, deposits: deposits.rows, withdrawals: withdrawals.rows };
}

export async function handleAdminApi(req) {
  const requestError = unsafeRequestError(req);
  if (requestError) return requestError;
  try {
    return await adminRequest(req);
  } catch (error) {
    console.error("Admin session storage unavailable", { code: error?.code ?? "unavailable" });
    return { status: 503, headers: { "Retry-After": "60" }, body: { error: "Administration is temporarily unavailable. Please try again later." } };
  }
}

async function adminRequest(req) {
  const url = new URL(req.url ?? "/api/admin", "http://localhost");
  const secret = adminSecret();
  if (Buffer.byteLength(secret, "utf8") < 16) {
    return { status: 503, body: { error: secret ? "Admin password must be at least 16 characters" : "Admin password is not configured" } };
  }
  const mfa = adminMfaConfig();
  const sessionKey = adminSessionKey(secret, mfa);
  const unauthorized = () => ({ status: 401, body: {
    error: mfa ? "စကားဝှက်နှင့် Authenticator ကုဒ်ကို စစ်ဆေးပြီး ထပ်မံကြိုးစားပါ။" : "Enter the admin password to continue",
    mfaRequired: Boolean(mfa),
  } });

  if (req.method === "POST") {
    const action = req.body?.action;
    if (action === "login") {
      const limited = await consumeRateLimit(req, "admin-login");
      if (limited) return limited;
      const attempt = typeof req.body?.password === "string" && req.body.password.length <= 4096 ? req.body.password : "";
      if (!passwordsMatch(attempt, secret)) return unauthorized();
      if (mfa) {
        // A shared ceiling stops code guessing with a stolen password even if
        // requests rotate their source IP. Invalid passwords cannot exhaust it.
        const mfaLimited = await consumeRateLimit(req, "admin-mfa", "shared-admin");
        if (mfaLimited) return mfaLimited;
        const step = matchingAdminTotpStep(mfa, req.body?.code);
        if (step === null) return unauthorized();
        return await withTransaction(async (client) => {
          if (!await claimAdminTotp(client, mfa, step)) return unauthorized();
          // Code consumption and session registration commit together. A
          // storage failure cannot leave a reusable code and an active cookie.
          const cookie = await createAdminSession(sessionKey, client);
          return { status: 200, headers: { "Set-Cookie": cookie }, body: { ok: true } };
        });
      }
      return { status: 200, headers: { "Set-Cookie": await createAdminSession(sessionKey) }, body: { ok: true } };
    }
    if (action === "logout") {
      const token = cookieValue(req, ADMIN_SESSION_COOKIE);
      if (token) await getPool().query("delete from public.auth_admin_sessions where token_hash = $1", [sessionHash(token)]);
      const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
      return {
        status: 200,
        headers: { "Set-Cookie": `${ADMIN_SESSION_COOKIE}=; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=0${secure}` },
        body: { ok: true },
      };
    }
    if (!await validAdminSession(req, sessionKey)) return unauthorized();
    if (action === "save_game_settings") return await saveGameSettings(req.body);
    if (action === "set_game_visibility") return await setGameVisibility(req.body);
    if (action === "set_game_hot") return await setGameHot(req.body);
    return { status: 400, body: { error: "Unknown admin action" } };
  }
  if (req.method !== "GET") return { status: 405, body: { error: "Method not allowed" } };
  if (!await validAdminSession(req, sessionKey)) return unauthorized();

  const view = url.searchParams.get("view") || "overview";
  const pool = getPool();

  try {
    if (view === "overview") {
      const range = overviewWindow(url.searchParams.get("range") || "today");
      if (!range) return { status: 400, body: { error: "Choose a valid overview date range" } };
      return { status: 200, body: await overview(pool, range) };
    }
    if (view === "users") return { status: 200, body: await users(pool, url) };
    if (view === "games") {
      const providerGames = await listProviderGames({ refresh: true });
      const display = await applyGameDisplaySettings(pool, providerGames, { includeHidden: true });
      return { status: 200, body: display };
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
