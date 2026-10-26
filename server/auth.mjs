import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { getPool, withTransaction } from "./neon.mjs";
import { normalizePhone } from "./phone.mjs";

const scrypt = promisify(scryptCallback);
const SESSION_COOKIE = "casino_session";
const SESSION_DAYS = 30;

function cookieToken(req) {
  const header = req.headers?.cookie ?? "";
  const entry = header.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  return entry ? decodeURIComponent(entry.slice(SESSION_COOKIE.length + 1)) : "";
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
  if (!phone) throw new Error("Enter a valid phone number");
  if (typeof password !== "string" || password.length < 6 || password.length > 128) {
    throw new Error("Password must be at least 6 characters");
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
    if (error?.code === "23505") throw new Error("Phone number is already registered");
    throw error;
  }

  return { cookie: await createSession(userId), user: { id: userId, name: phone, username: phone.replace(/\D/g, "") } };
}

export async function signInPhone(phoneInput, password) {
  const phone = normalizePhone(phoneInput);
  if (!phone || typeof password !== "string") throw new Error("Phone number or password is incorrect");
  const result = await getPool().query(
    `select p.id, p.phone, c.password_hash
       from public.profiles p join public.auth_credentials c on c.user_id = p.id
      where p.phone = $1`,
    [phone],
  );
  const user = result.rows[0];
  if (!user) throw new Error("Phone number or password is incorrect");
  const [algorithm, saltHex, hashHex] = user.password_hash.split("$");
  if (algorithm !== "scrypt") throw new Error("Phone number or password is incorrect");
  const expected = Buffer.from(hashHex, "hex");
  const actual = Buffer.from(await scrypt(password, Buffer.from(saltHex, "hex"), expected.length));
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("Phone number or password is incorrect");
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
