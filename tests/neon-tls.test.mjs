import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { normalizeDatabaseSslMode } from "../server/neon.mjs";

// Only construct connection configuration. Never connect to a real database.
const base = "postgresql://test_user:fake%40password%3A%2F%3F%23%25@db.example.invalid:5432/neondb";

test("legacy pg SSL aliases become explicit verify-full without emitting their warning", (t) => {
  const warnings = [];
  t.mock.method(process, "emitWarning", (warning) => warnings.push(warning));
  for (const mode of ["prefer", "require", "verify-ca"]) {
    const normalized = normalizeDatabaseSslMode(`${base}?sslmode=${mode}&channel_binding=require&application_name=casino`);
    const url = new URL(normalized);
    assert.equal(url.searchParams.get("sslmode"), "verify-full");
    assert.equal(url.searchParams.get("channel_binding"), "require");
    const client = new pg.Client({ connectionString: normalized });
    assert.equal(typeof client.connectionParameters.ssl, "object");
    assert.notEqual(client.connectionParameters.ssl.rejectUnauthorized, false);
    assert.equal(client.connectionParameters.ssl.checkServerIdentity, undefined);
    assert.equal(client.connectionParameters.user, "test_user");
    assert.equal(client.connectionParameters.password, "fake@password:/?#%");
    assert.equal(client.connectionParameters.host, "db.example.invalid");
    assert.equal(client.connectionParameters.database, "neondb");
    assert.equal(client.connectionParameters.application_name, "casino");
  }
  assert.deepEqual(warnings, []);
});

test("duplicate parameters use the pg parser's final sslmode value and collapse legacy aliases safely", () => {
  const normalized = normalizeDatabaseSslMode(`${base}?sslmode=verify-full&sslmode=require`);
  assert.deepEqual(new URL(normalized).searchParams.getAll("sslmode"), ["verify-full"]);
});

test("libpq compatibility cannot turn a normalized legacy alias into unverified TLS", () => {
  const normalized = normalizeDatabaseSslMode(`${base}?sslmode=require&uselibpqcompat=true`);
  const { ssl } = new pg.Client({ connectionString: normalized }).connectionParameters;
  assert.equal(typeof ssl, "object");
  assert.notEqual(ssl.rejectUnauthorized, false);
  assert.equal(ssl.checkServerIdentity, undefined);
});

test("already strict URLs and existing local development URLs are unchanged", () => {
  const strict = `${base}?sslmode=verify-full&channel_binding=require`;
  assert.equal(normalizeDatabaseSslMode(strict), strict);
  for (const local of ["postgres://localhost/test", "postgresql://localhost/test?sslmode=disable"]) {
    assert.equal(normalizeDatabaseSslMode(local), local);
  }
});

test("all unrelated parameters, encoded credentials and custom trust configuration survive normalization", () => {
  const original = new URL(`${base}?sslmode=require&sslrootcert=%2Fetc%2Fdatabase-ca.pem&options=-c%20statement_timeout%3D5000&channel_binding=require`);
  const normalized = new URL(normalizeDatabaseSslMode(original.toString()));
  assert.equal(normalized.username, original.username);
  assert.equal(normalized.password, original.password);
  assert.equal(normalized.host, original.host);
  assert.equal(normalized.pathname, original.pathname);
  for (const name of ["sslrootcert", "options", "channel_binding"]) assert.equal(normalized.searchParams.get(name), original.searchParams.get(name));
});

test("invalid connection URL errors never expose the URL or its credential values", () => {
  for (const invalid of ["postgresql://user:private-value@[%", "https://user:private-value@example.invalid", "not-a-url-private-value"]) {
    assert.throws(() => normalizeDatabaseSslMode(invalid), (error) => {
      assert.equal(error.message, "DATABASE_URL must be a valid PostgreSQL connection URL");
      assert.ok(!String(error.stack).includes("private-value"));
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test("the actual app pool uses normalized TLS configuration and retains its connection limits", async (t) => {
  const saved = { DATABASE_URL: process.env.DATABASE_URL, DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX };
  t.after(() => { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  process.env.DATABASE_URL = `${base}?sslmode=require&channel_binding=require`;
  delete process.env.DATABASE_POOL_MAX;
  const { getPool } = await import("../server/neon.mjs?isolated-tls-pool-test");
  const pool = getPool();
  t.after(() => pool.end());
  assert.equal(getPool(), pool);
  assert.equal(new URL(pool.options.connectionString).searchParams.get("sslmode"), "verify-full");
  assert.equal(pool.options.max, 3);
  assert.equal(pool.options.idleTimeoutMillis, 30000);
  assert.equal(pool.options.connectionTimeoutMillis, 10000);
  assert.equal(pool.totalCount, 0);
});
