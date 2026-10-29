import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { after, before, beforeEach, mock, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

// Real PostgreSQL statements in memory. No production database or provider calls.
const db = new PGlite();
const queries = [];
let passwordHashes = 0;
let cleanupNow = false;
let databaseFailure;
let failAdminSessionInsert = false;
mock.module("node:crypto", {
  namedExports: {
    ...crypto,
    scrypt(...args) { passwordHashes++; return crypto.scrypt(...args); },
    randomInt: () => cleanupNow ? 0 : 1,
  },
});
function clientFor(connection) {
  return { async query(sql, params) {
    queries.push(sql);
    if (databaseFailure) throw databaseFailure;
    if (failAdminSessionInsert && /insert into public.auth_admin_sessions/i.test(sql)) throw new Error("Simulated admin session write failure");
    const result = await connection.query(sql, params);
    return { rows: result.rows, rowCount: /^\s*select/i.test(sql) ? result.rows.length : result.affectedRows };
  } };
}
mock.module("../server/neon.mjs", {
  namedExports: {
    getPool: () => clientFor(db),
    withTransaction: (callback) => db.transaction((tx) => callback(clientFor(tx))),
  },
});
const { default: authHandler } = await import("../api/auth/[...all].js");
const { default: adminHandler } = await import("../api/admin/index.js");
const { currentSession } = await import("../server/auth.mjs");
const { handleAdminApi } = await import("../server/admin-api.mjs");
const { consumeRateLimit } = await import("../server/rate-limit.mjs");
const secondLimiter = await import("../server/rate-limit.mjs?separate-serverless-instance");
const { unsafeRequestError, trustedClientIp } = await import("../server/request-security.mjs");
const { adminTotpCode } = await import("../server/admin-mfa.mjs");
const secondAdmin = await import("../server/admin-api.mjs?separate-mfa-instance");

const ENV_KEYS = ["NODE_ENV", "VERCEL", "VERCEL_ENV", "VERCEL_URL", "APP_ORIGINS", "DATABASE_URL", "admin_secret", "ADMIN_SECRET", "ADMIN_TOTP_SECRET", "ADMIN_MFA_REQUIRED", "RATE_LIMIT_SECRET", "SLOT_API_PORT"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
async function migration(name) {
  const sql = await readFile(new URL(`../neon/${name}`, import.meta.url), "utf8");
  await db.exec(sql.replace("create extension if not exists pgcrypto;", ""));
}
before(async () => {
  await migration("001_app_schema.sql");
  await migration("002_phone_auth.sql");
  await migration("006_game_display_settings.sql");
  await migration("009_auth_security.sql");
  mock.method(globalThis, "fetch", () => { throw new Error("Network access is forbidden in security tests"); });
});
beforeEach(async () => {
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = "postgres://local-tests-only";
  process.env.admin_secret = "local-administrator-test-password";
  process.env.RATE_LIMIT_SECRET = "local-rate-limit-test-secret";
  databaseFailure = undefined;
  failAdminSessionInsert = false;
  cleanupNow = false;
  passwordHashes = 0;
  queries.length = 0;
  await db.exec("truncate public.auth_rate_limits, public.auth_admin_sessions, public.auth_sessions, public.auth_credentials, public.game_display_settings, public.profiles restart identity cascade");
});
after(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await db.close();
});

function request(body = {}, { url = "/api/auth/sign-in", method = "POST", ip = "203.0.113.7", headers = {} } = {}) {
  return { url, method, body, socket: { remoteAddress: ip }, headers: { origin: "https://www.j777ml.com", "content-type": "application/json", ...headers } };
}
function response() {
  return { headers: {}, status(code) { this.statusCode = code; return this; }, setHeader(name, value) { this.headers[name.toLowerCase()] = value; }, json(body) { this.body = body; return this; } };
}
async function auth(body, options) {
  const res = response();
  await authHandler(request(body, options), res);
  return res;
}
async function signup(phone = "09123456789", password = "new-password") {
  const result = await auth({ phone, password }, { url: "/api/auth/sign-up" });
  assert.equal(result.statusCode, 200);
  return result;
}
function cookie(res) { return res.headers["set-cookie"].split(";", 1)[0]; }
async function admin(body, headers = {}) { return handleAdminApi(request(body, { url: "/api/admin", headers })); }
async function adminLogin(ip = "203.0.113.7") {
  const result = await handleAdminApi(request({ action: "login", password: process.env.admin_secret }, { url: "/api/admin", ip }));
  assert.equal(result.status, 200);
  return result.headers["Set-Cookie"].split(";", 1)[0];
}

test("foreign, missing, null, sibling, and ambiguous origins cannot create sessions or reach storage", async () => {
  for (const origin of ["https://attacker.example", "https://evil.j777ml.com", "null", "https://www.j777ml.com.attacker.example", ["https://www.j777ml.com", "https://attacker.example"], undefined]) {
    const res = await auth({ phone: "09123456789", password: "new-password" }, { url: "/api/auth/sign-up", headers: { origin } });
    assert.equal(res.statusCode, 403);
    assert.equal(res.headers["set-cookie"], undefined);
  }
  assert.equal(queries.length, 0);
  assert.equal(passwordHashes, 0);
});

test("form, multipart and text requests are rejected even when they contain valid JSON", async () => {
  for (const contentType of ["application/x-www-form-urlencoded", "multipart/form-data", "text/plain", ""]) {
    const res = await auth('{"phone":"09123456789","password":"new-password"}', { headers: { "content-type": contentType } });
    assert.equal(res.statusCode, 415);
  }
  assert.equal(queries.length, 0);
  assert.equal(passwordHashes, 0);
});

test("exact production origins, trusted Referer and local development work; forged Host does not authorize", () => {
  for (const origin of ["https://www.j777ml.com", "https://j777ml.com", "http://localhost:5173", "http://127.0.0.1:8787", "http://[::1]:5174"]) {
    assert.equal(unsafeRequestError(request({}, { headers: { origin, "content-type": "application/json; charset=utf-8" } })), null);
  }
  assert.equal(unsafeRequestError(request({}, { headers: { origin: undefined, referer: "https://www.j777ml.com/admin" } })), null);
  assert.equal(unsafeRequestError(request({}, { headers: { origin: "null", referer: "https://www.j777ml.com/admin" } })).status, 403);
  assert.equal(unsafeRequestError(request({}, { headers: { origin: "https://attacker.example", host: "attacker.example" } })).status, 403);
  assert.equal(unsafeRequestError(request({}, { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  process.env.NODE_ENV = "production";
  assert.equal(unsafeRequestError(request({}, { headers: { origin: "http://localhost:5173" } })).status, 403);
  process.env.APP_ORIGINS = "https://extra.example,*,https://invalid.example/path";
  assert.equal(unsafeRequestError(request({}, { headers: { origin: "https://extra.example" } })), null);
  assert.equal(unsafeRequestError(request({}, { headers: { origin: "https://invalid.example" } })).status, 403);
  process.env.VERCEL = "1";
  process.env.VERCEL_ENV = "preview";
  process.env.VERCEL_URL = "trusted-deployment.vercel.app";
  assert.equal(unsafeRequestError(request({}, { headers: { origin: "https://trusted-deployment.vercel.app" } })), null);
  assert.equal(unsafeRequestError(request({}, { headers: { origin: "https://untrusted.vercel.app" } })).status, 403);
});

test("client IP ignores spoofed forwarding headers outside Vercel and validates the Vercel edge header", () => {
  const req = request({}, { ip: "::ffff:203.0.113.7", headers: { "x-forwarded-for": "198.51.100.8", "x-vercel-forwarded-for": "198.51.100.9" } });
  assert.equal(trustedClientIp(req), "203.0.113.7");
  process.env.VERCEL = "1";
  assert.equal(trustedClientIp(req), "198.51.100.9");
  req.headers["x-vercel-forwarded-for"] = "198.51.100.9, 203.0.113.7";
  assert.equal(trustedClientIp(req), "unknown");
  req.headers["x-vercel-forwarded-for"] = "fe80::1%eth0";
  assert.equal(trustedClientIp(req), "unknown");
  delete req.headers["x-vercel-forwarded-for"];
  assert.equal(trustedClientIp(req), "unknown");
});

test("atomic limits are shared across independent module instances and concurrent attempts", async () => {
  const results = await Promise.all(Array.from({ length: 125 }, (_, index) => (
    index % 2 ? consumeRateLimit : secondLimiter.consumeRateLimit
  )(request(), "sign-in", `distinct-account-${index}`)));
  assert.equal(results.filter((result) => result === null).length, 120);
  assert.equal(results.filter((result) => result?.status === 429).length, 5);
  assert.ok(results.filter(Boolean).every((result) => Number(result.headers["Retry-After"]) > 0));
  const stored = await db.query("select * from public.auth_rate_limits");
  assert.ok(stored.rows.every((row) => /^[0-9a-f]{64}$/.test(row.key_hash)));
  assert.ok(!JSON.stringify(stored.rows).includes("203.0.113.7"));
  assert.ok(!JSON.stringify(stored.rows).includes("distinct-account"));
});

test("an exhausted IP cannot create identity rows by rotating phone numbers", async () => {
  for (let index = 0; index < 30; index++) {
    assert.equal(await consumeRateLimit(request(), "sign-up", `allowed-phone-${index}`), null);
  }
  const before = await db.query("select count(*)::integer as count from public.auth_rate_limits where scope like 'sign-up:identity:%'");
  assert.equal(before.rows[0].count, 30);
  const blocked = await Promise.all(Array.from({ length: 100 }, (_, index) => (
    index % 2 ? consumeRateLimit : secondLimiter.consumeRateLimit
  )(request(), "sign-up", `blocked-phone-${index}`)));
  assert.ok(blocked.every((result) => result?.status === 429));
  const after = await db.query("select count(*)::integer as count from public.auth_rate_limits where scope like 'sign-up:identity:%'");
  assert.deepEqual(after.rows, before.rows);
});

test("normalized account limits prevent distributed guesses and blocked calls never read credentials or hash passwords", async () => {
  await signup();
  for (let index = 0; index < 10; index++) {
    const res = await auth({ phone: index % 2 ? "+959123456789" : "09123456789", password: "wrong-password" }, { ip: `203.0.113.${index + 1}` });
    assert.equal(res.statusCode, 401);
  }
  const previousHashes = passwordHashes;
  queries.length = 0;
  const blocked = await auth({ phone: "959123456789", password: "new-password" }, { ip: "198.51.100.1" });
  assert.equal(blocked.statusCode, 429);
  assert.ok(Number(blocked.headers["retry-after"]) > 0);
  assert.equal(passwordHashes, previousHashes);
  assert.ok(!queries.some((sql) => sql.includes("auth_credentials")));
});

test("expired limits reset without extending blocked windows and maintenance removes old abandoned keys", async () => {
  for (let index = 0; index < 11; index++) await consumeRateLimit(request(), "sign-in", "same-account");
  const before = await db.query("select expires_at from public.auth_rate_limits where scope = 'sign-in:identity:900'");
  assert.equal((await consumeRateLimit(request(), "sign-in", "same-account")).status, 429);
  const after = await db.query("select expires_at from public.auth_rate_limits where scope = 'sign-in:identity:900'");
  assert.deepEqual(after.rows, before.rows);
  await db.exec("update public.auth_rate_limits set window_started_at = now() - interval '1 hour', expires_at = now() - interval '1 second'");
  assert.equal(await consumeRateLimit(request(), "sign-in", "same-account"), null);
  await db.query("insert into public.auth_rate_limits (scope,key_hash,attempts,window_started_at,expires_at) values ('abandoned',$1,1,now()-interval '3 days',now()-interval '2 days')", ["0".repeat(64)]);
  cleanupNow = true;
  assert.equal(await consumeRateLimit(request(), "sign-in", "same-account"), null);
  assert.equal((await db.query("select count(*)::integer as count from public.auth_rate_limits where scope='abandoned'")).rows[0].count, 0);
});

test("new passwords require 8-128 characters, while existing six-character passwords still sign in", async () => {
  for (const [index, password] of ["1234567", "x".repeat(129), {}, null].entries()) {
    const res = await auth({ phone: `0999999999${index}`, password }, { url: "/api/auth/sign-up" });
    assert.equal(res.statusCode, 400);
  }
  assert.equal(passwordHashes, 0);
  const id = crypto.randomUUID();
  const salt = Buffer.alloc(16, 3);
  const hash = `scrypt$${salt.toString("hex")}$${crypto.scryptSync("123456", salt, 64).toString("hex")}`;
  await db.query("insert into public.profiles(id,phone) values($1,'+959123456789')", [id]);
  await db.query("insert into public.auth_credentials(user_id,password_hash) values($1,$2)", [id, hash]);
  const signedIn = await auth({ phone: "09123456789", password: "123456" });
  assert.equal(signedIn.statusCode, 200);
  assert.ok(cookie(signedIn).startsWith("casino_session="));
  const hashesBefore = passwordHashes;
  assert.equal((await auth({ phone: "09123456789", password: "x".repeat(129) })).statusCode, 401);
  assert.equal(passwordHashes, hashesBefore);
});

test("unknown accounts and wrong passwords do equal password work and return the same public failure", async () => {
  await signup();
  const previousHashes = passwordHashes;
  const unknown = await auth({ phone: "09999999999", password: "wrong-password" });
  assert.equal(passwordHashes, previousHashes + 1);
  const known = await auth({ phone: "09123456789", password: "wrong-password" });
  assert.equal(passwordHashes, previousHashes + 2);
  assert.equal(unknown.statusCode, 401);
  assert.deepEqual(unknown.body, known.body);
});

test("signup/session/logout preserve hashed session storage, revoke user tokens and prevent cached identity responses", async () => {
  process.env.NODE_ENV = "production";
  const created = await signup();
  const sessionCookie = cookie(created);
  assert.match(created.headers["set-cookie"], /HttpOnly; SameSite=Lax;.*Secure/);
  const stored = await db.query("select token_hash from public.auth_sessions");
  assert.match(stored.rows[0].token_hash, /^[0-9a-f]{64}$/);
  assert.ok(!sessionCookie.includes(stored.rows[0].token_hash));
  const session = await auth({}, { url: "/api/auth/get-session", method: "GET", headers: { cookie: sessionCookie } });
  assert.equal(session.statusCode, 200);
  assert.equal(session.headers["cache-control"], "private, no-store");
  assert.ok(session.body.user.id);
  const signedOut = await auth({}, { url: "/api/auth/sign-out", headers: { cookie: sessionCookie } });
  assert.equal(signedOut.statusCode, 200);
  assert.equal(await currentSession(request({}, { headers: { cookie: sessionCookie } })), null);
  const previousQueries = queries.length;
  assert.equal(await currentSession(request({}, { headers: { cookie: "casino_session=%ZZ" } })), null);
  assert.equal(queries.length, previousQueries);
});

test("admin logout revokes only its own session; replay, forged signatures and unregistered cookies fail", async () => {
  const firstCookie = await adminLogin();
  const secondCookie = await adminLogin("198.51.100.1");
  assert.equal((await admin({ action: "set_game_visibility", game_code: "shankoemee", is_active: false }, { cookie: firstCookie })).status, 200);
  assert.equal((await admin({ action: "logout" }, { cookie: firstCookie })).status, 200);
  assert.equal((await admin({ action: "set_game_visibility", game_code: "shankoemee", is_active: true }, { cookie: firstCookie })).status, 401);
  assert.equal((await admin({ action: "set_game_visibility", game_code: "shankoemee", is_active: true }, { cookie: secondCookie })).status, 200);
  const payload = `${Math.floor(Date.now() / 1000)}.${"a".repeat(36)}`;
  const unregistered = `${payload}.${crypto.createHmac("sha256", process.env.admin_secret).update(payload).digest("hex")}`;
  assert.equal((await admin({ action: "set_game_hot", game_code: "shankoemee", is_hot: true }, { cookie: `casino_admin_session=${unregistered}` })).status, 401);
  assert.equal((await admin({ action: "set_game_hot", game_code: "shankoemee", is_hot: true }, { cookie: `${secondCookie}tampered` })).status, 401);
  assert.equal((await db.query("select count(*)::integer as count from public.auth_admin_sessions")).rows[0].count, 1);
});

test("expired admin sessions and secret rotation invalidate previously issued cookies", async () => {
  const firstCookie = await adminLogin();
  await db.exec("update public.auth_admin_sessions set created_at=now()-interval '2 days',expires_at=now()-interval '1 day'");
  assert.equal((await admin({ action: "unknown" }, { cookie: firstCookie })).status, 401);
  const nextCookie = await adminLogin("198.51.100.1");
  process.env.admin_secret = "rotated-administrator-test-secret";
  assert.equal((await admin({ action: "unknown" }, { cookie: nextCookie })).status, 401);
});

test("admin brute-force protection persists and missing trusted origin cannot mutate settings", async () => {
  for (let index = 0; index < 10; index++) assert.equal((await admin({ action: "login", password: "wrong" })).status, 401);
  const limited = await admin({ action: "login", password: process.env.admin_secret });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers["Retry-After"]) > 0);
  assert.equal((await db.query("select count(*)::integer as count from public.auth_admin_sessions")).rows[0].count, 0);
  const adminCookie = await adminLogin("198.51.100.1");
  const unauthorized = await admin({ action: "set_game_visibility", game_code: "shankoemee", is_active: false }, { cookie: adminCookie, origin: undefined });
  assert.equal(unauthorized.status, 403);
  assert.equal((await db.query("select count(*)::integer as count from public.game_display_settings")).rows[0].count, 0);
});

const MFA_SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // RFC 6238 public test key.
function enableMfa(t) {
  process.env.ADMIN_TOTP_SECRET = MFA_SEED;
  process.env.ADMIN_MFA_REQUIRED = "true";
  const timestamp = Math.floor(Date.now() / 30_000) * 30_000 + 15_000;
  t.mock.method(Date, "now", () => timestamp);
  const key = Buffer.from("12345678901234567890");
  return { timestamp, key, step: Math.floor(timestamp / 30_000), code: adminTotpCode(key, Math.floor(timestamp / 30_000)) };
}
async function mfaLogin(code, ip = "203.0.113.7", handler = handleAdminApi, password = process.env.admin_secret) {
  return handler(request({ action: "login", password, code }, { url: "/api/admin", ip }));
}

test("configured MFA rejects missing, malformed, stale codes and wrong passwords with one generic failure", async (t) => {
  const { code, key, step } = enableMfa(t);
  const invalid = [undefined, Number(code), [code], { code }, ` ${code}`, code + "0", adminTotpCode(key, step - 2), adminTotpCode(key, step + 2)];
  for (const [index, value] of invalid.entries()) {
    const rejected = await mfaLogin(value, `198.51.100.${index + 1}`);
    assert.equal(rejected.status, 401);
    assert.equal(rejected.body.mfaRequired, true);
    assert.equal(rejected.headers?.["Set-Cookie"], undefined);
  }
  const wrongPassword = await mfaLogin(code, "198.51.100.50", handleAdminApi, "incorrect-password");
  assert.equal(wrongPassword.status, 401);
  assert.deepEqual(wrongPassword.body, (await mfaLogin(undefined, "198.51.100.51")).body);
  assert.equal((await db.query("select count(*)::int as count from public.auth_admin_sessions")).rows[0].count, 0);
  assert.equal((await db.query("select count(*)::int as count from public.auth_rate_limits where scope='admin-totp-used:v1'")).rows[0].count, 0);
});

test("password plus a valid code registers a Secure HttpOnly session, and a used code never creates another session", async (t) => {
  const { code } = enableMfa(t);
  process.env.NODE_ENV = "production";
  const signedIn = await mfaLogin(code);
  assert.equal(signedIn.status, 200);
  assert.match(signedIn.headers["Set-Cookie"], /HttpOnly; SameSite=Strict; Max-Age=43200; Secure$/);
  const sessionCookie = signedIn.headers["Set-Cookie"].split(";", 1)[0];
  assert.equal((await admin({ action: "unknown" }, { cookie: sessionCookie })).status, 400);
  assert.equal((await mfaLogin(code, "198.51.100.1")).status, 401);
  const used = await db.query("select * from public.auth_rate_limits where scope='admin-totp-used:v1'");
  assert.equal(used.rows.length, 1);
  assert.match(used.rows[0].key_hash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(used.rows).includes(MFA_SEED));
  assert.equal((await db.query("select count(*)::int as count from public.auth_admin_sessions")).rows[0].count, 1);
  assert.equal((await admin({ action: "logout" }, { cookie: sessionCookie })).status, 200);
  assert.equal((await admin({ action: "unknown" }, { cookie: sessionCookie })).status, 401);
});

test("the same accepted time step remains consumed when a neighbouring clock window is used", async (t) => {
  const { timestamp, code } = enableMfa(t);
  assert.equal((await mfaLogin(code)).status, 200);
  t.mock.method(Date, "now", () => timestamp + 30_000);
  assert.equal((await mfaLogin(code, "198.51.100.1")).status, 401);
});

test("concurrent code replays across independent admin instances issue at most one session", async (t) => {
  const { code } = enableMfa(t);
  const results = await Promise.all(Array.from({ length: 5 }, (_, index) => mfaLogin(
    code, `198.51.100.${index + 1}`, index % 2 ? secondAdmin.handleAdminApi : handleAdminApi,
  )));
  assert.equal(results.filter((result) => result.status === 200).length, 1);
  assert.equal(results.filter((result) => result.status === 401).length, 4);
  assert.equal((await db.query("select count(*)::int as count from public.auth_admin_sessions")).rows[0].count, 1);
});

test("shared MFA attempt ceiling blocks distributed guesses even when each IP is fresh", async (t) => {
  const { code } = enableMfa(t);
  for (let index = 0; index < 10; index++) assert.equal((await mfaLogin("invalid", `198.51.100.${index + 1}`)).status, 401);
  const result = await mfaLogin(code, "203.0.113.99", secondAdmin.handleAdminApi);
  assert.equal(result.status, 429);
  assert.ok(Number(result.headers["Retry-After"]) > 0);
  assert.equal((await db.query("select count(*)::int as count from public.auth_admin_sessions")).rows[0].count, 0);
});

test("enabling and rotating MFA invalidates old sessions on reads and mutations", async (t) => {
  const passwordOnlyCookie = await adminLogin();
  const { code } = enableMfa(t);
  for (const cookie of [passwordOnlyCookie]) {
    assert.equal((await admin({ action: "set_game_visibility", game_code: "shankoemee", is_active: false }, { cookie })).status, 401);
    assert.equal((await handleAdminApi(request({}, { method: "GET", url: "/api/admin?view=unknown", headers: { cookie } }))).status, 401);
  }
  const signedIn = await mfaLogin(code, "198.51.100.20");
  assert.equal(signedIn.status, 200);
  const mfaCookie = signedIn.headers["Set-Cookie"].split(";", 1)[0];
  process.env.ADMIN_TOTP_SECRET = "A".repeat(32);
  assert.equal((await admin({ action: "unknown" }, { cookie: mfaCookie })).status, 401);
  assert.equal((await handleAdminApi(request({}, { method: "GET", url: "/api/admin?view=unknown", headers: { cookie: mfaCookie } }))).status, 401);
});

test("required MFA missing or invalid configuration fails closed without returning configuration values", async (t) => {
  const cookie = await adminLogin();
  t.mock.method(console, "error", () => {});
  process.env.ADMIN_MFA_REQUIRED = "true";
  for (const value of ["", "invalid-secret-must-not-be-returned", "A".repeat(31), "0".repeat(32)]) {
    process.env.ADMIN_TOTP_SECRET = value;
    for (const req of [request({ action: "login", password: process.env.admin_secret }), request({}, { method: "GET", headers: { cookie } })]) {
      const result = await handleAdminApi(req);
      assert.equal(result.status, 503);
      if (value) assert.ok(!JSON.stringify(result).includes(value));
      assert.equal(result.headers?.["Set-Cookie"], undefined);
    }
  }
  process.env.ADMIN_TOTP_SECRET = MFA_SEED;
  process.env.ADMIN_MFA_REQUIRED = "misspelled";
  assert.equal((await mfaLogin("123456")).status, 503);
  assert.equal((await db.query("select count(*)::int as count from public.auth_admin_sessions")).rows[0].count, 1);
});

test("a configured secret enables MFA even before the required flag is set", async (t) => {
  enableMfa(t);
  delete process.env.ADMIN_MFA_REQUIRED;
  assert.equal((await mfaLogin(undefined)).status, 401);
  process.env.ADMIN_MFA_REQUIRED = "false";
  assert.equal((await mfaLogin(undefined)).status, 401);
});

test("code consumption rolls back when session registration fails; no cookie is issued and the code can be retried", async (t) => {
  const { code } = enableMfa(t);
  t.mock.method(console, "error", () => {});
  failAdminSessionInsert = true;
  const failed = await mfaLogin(code);
  assert.equal(failed.status, 503);
  assert.equal(failed.headers?.["Set-Cookie"], undefined);
  assert.equal((await db.query("select count(*)::int as count from public.auth_rate_limits where scope='admin-totp-used:v1'")).rows[0].count, 0);
  assert.equal((await db.query("select count(*)::int as count from public.auth_admin_sessions")).rows[0].count, 0);
  failAdminSessionInsert = false;
  assert.equal((await mfaLogin(code, "198.51.100.2")).status, 200);
});

test("missing security migration fails closed before signup, signin or admin sessions, while existing user session reads/logout work", async (t) => {
  const created = await signup();
  const sessionCookie = cookie(created);
  await db.exec("drop table public.auth_rate_limits");
  t.mock.method(console, "error", () => {});
  try {
    const previousHashes = passwordHashes;
    assert.equal((await auth({ phone: "09123456789", password: "new-password" })).statusCode, 503);
    assert.equal((await auth({ phone: "09999999999", password: "new-password" }, { url: "/api/auth/sign-up" })).statusCode, 503);
    assert.equal((await admin({ action: "login", password: process.env.admin_secret })).status, 503);
    assert.equal(passwordHashes, previousHashes);
    assert.ok(await currentSession(request({}, { headers: { cookie: sessionCookie } })));
    assert.equal((await auth({}, { url: "/api/auth/sign-out", headers: { cookie: sessionCookie } })).statusCode, 200);
  } finally { await migration("009_auth_security.sql"); }
});

test("missing admin session storage never falls back to stateless tokens and internal errors are not returned", async (t) => {
  const adminCookie = await adminLogin();
  t.mock.method(console, "error", () => {});
  await db.exec("drop table public.auth_admin_sessions");
  try {
    assert.equal((await admin({ action: "unknown" }, { cookie: adminCookie })).status, 503);
    assert.equal((await admin({ action: "logout" }, { cookie: adminCookie })).status, 503);
    assert.equal((await admin({ action: "login", password: process.env.admin_secret })).status, 503);
  } finally { await migration("009_auth_security.sql"); }
  databaseFailure = Object.assign(new Error("internal-password-and-host-must-never-escape"), { code: "08006" });
  const failure = await auth({ phone: "09123456789", password: "new-password" });
  assert.equal(failure.statusCode, 503);
  assert.ok(!JSON.stringify(failure.body).includes("internal-password"));
});

test("admin HTTP wrapper rejects malformed JSON and applies no-store on failures", async () => {
  const res = response();
  await adminHandler(request("not-json", { url: "/api/admin" }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.headers["cache-control"], "private, no-store");
  assert.equal(queries.length, 0);
});

test("admin HTTP wrapper accepts the raw stream without touching a read-only framework body getter", async () => {
  const req = Readable.from([JSON.stringify({ action: "login", password: process.env.admin_secret })]);
  Object.assign(req, request());
  req.url = "/api/admin";
  Object.defineProperty(req, "body", { get() { throw new Error("Framework body getter must remain untouched"); } });
  const res = response();
  await adminHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.ok(res.headers["set-cookie"].startsWith("casino_admin_session="));
});

test("security migration is repeatable and preserves existing players, balances, credentials and sessions", async () => {
  const created = await signup();
  await db.query("update public.profiles set balance=1234 where id=$1", [created.body.user.id]);
  await migration("009_auth_security.sql");
  await migration("009_auth_security.sql");
  const stored = await db.query("select p.balance::text, c.password_hash from public.profiles p join public.auth_credentials c on c.user_id=p.id where p.id=$1", [created.body.user.id]);
  assert.equal(stored.rows[0].balance, "1234");
  assert.match(stored.rows[0].password_hash, /^scrypt\$/);
  assert.equal((await currentSession(request({}, { headers: { cookie: cookie(created) } }))).user.id, created.body.user.id);
});
