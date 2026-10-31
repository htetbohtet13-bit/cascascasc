import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { getPool, withTransaction } from "./neon.mjs";
import { normalizePhone } from "./phone.mjs";

const scrypt = promisify(scryptCallback);
const SESSION_COOKIE = "casino_session";
const SESSION_DAYS = 30;
const AUTH_FAILURE = "Phone number or password is incorrect";
const DUMMY_SALT = Buffer.alloc(16, 0);

export class AuthError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function cookieToken(req) {
  const header = String(req.headers?.cookie ?? "");
  const entry = header.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  try {
    const token = entry ? decodeURIComponent(entry.slice(SESSION_COOKIE.length + 1)) : "";
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : "";
  } catch {
    return "";
  }
}

function tokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

function sessionCookie(token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`;
}

function expiredCookie() {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

async function createSession(userId) {
  const token = randomBytes(32).toString("base64url");
  await getPool().query(
    `insert into public.auth_sessions (user_id, token_hash, expires_at)
     values ($1::uuid, $2, now() + ($3 * interval '1 day'))`,
    [userId, tokenHash(token), SESSION_DAYS],
  );
  return sessionCookie(token);
}

export async function currentSession(req) {
  const token = cookieToken(req);
  if (!token) return null;
  const result = await getPool().query(
    `select p.id, p.phone
       from public.auth_sessions s
       join public.profiles p on p.id = s.user_id
      where s.token_hash = $1 and s.expires_at > now()`,
    [tokenHash(token)],
  );
  const user = result.rows[0];
  if (!user) return null;
  return { user: { id: user.id, name: user.phone, username: user.phone.replace(/\D/g, "") } };
}

export async function signUpPhone(phoneInput, password) {
  const phone = normalizePhone(phoneInput);
  if (!phone) throw new AuthError("Enter a valid phone number");
  if (typeof password !== "string" || password.length < 5 || password.length > 128) {
    throw new AuthError("Password must be between 5 and 128 characters");
  }
  const userId = randomUUID();
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  const passwordHash = `scrypt$${salt.toString("hex")}$${Buffer.from(derived).toString("hex")}`;

  try {
    await withTransaction(async (client) => {
      await client.query("insert into public.profiles (id, phone) values ($1::uuid, $2)", [userId, phone]);
      await client.query(
        "insert into public.auth_credentials (user_id, password_hash) values ($1::uuid, $2)",
        [userId, passwordHash],
      );
    });
  } catch (error) {
    if (error?.code === "23505") throw new AuthError("Could not create account. Try signing in or use another phone number.", 409);
    throw error;
  }

  return { cookie: await createSession(userId), user: { id: userId, name: phone, username: phone.replace(/\D/g, "") } };
}

export async function signInPhone(phoneInput, password) {
  const phone = normalizePhone(phoneInput);
  // Keep existing passwords usable. Never hash unbounded attacker-controlled
  // password input, or impose a changed signup minimum on existing accounts.
  if (!phone || typeof password !== "string" || !password.length || password.length > 128) throw new AuthError(AUTH_FAILURE, 401);
  const result = await getPool().query(
    `select p.id, p.phone, c.password_hash
       from public.profiles p join public.auth_credentials c on c.user_id = p.id
      where p.phone = $1`,
    [phone],
  );
  const user = result.rows[0];
  const stored = /^scrypt\$([0-9a-f]{32})\$([0-9a-f]{128})$/.exec(String(user?.password_hash ?? ""));
  const expected = stored ? Buffer.from(stored[2], "hex") : Buffer.alloc(64);
  const actual = Buffer.from(await scrypt(password, stored ? Buffer.from(stored[1], "hex") : DUMMY_SALT, 64));
  // Missing accounts still perform the same password work to remove the easy
  // timing oracle. The API rate limit runs before this expensive operation.
  if (!timingSafeEqual(actual, expected) || !user || !stored) {
    throw new AuthError(AUTH_FAILURE, 401);
  }
  return {
    cookie: await createSession(user.id),
    user: { id: user.id, name: user.phone, username: user.phone.replace(/\D/g, "") },
  };
}

export async function signOut(req) {
  const token = cookieToken(req);
  if (token) await getPool().query("delete from public.auth_sessions where token_hash = $1", [tokenHash(token)]);
  return expiredCookie();
}

export function authCookie(token) {
  return sessionCookie(token);
}

export function clearAuthCookie() {
  return expiredCookie();
}
