import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { adminMfaConfig, adminSessionKey, adminTotpCode, encodeAdminTotpKey, generateAdminTotpSetup, matchingAdminTotpStep } from "../server/admin-mfa.mjs";

const key = Buffer.from("12345678901234567890");

test("fixed six-digit HOTP matches every published RFC 4226 test vector", () => {
  const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
  expected.forEach((value, step) => assert.equal(adminTotpCode(key, step), value));
});

test("RFC 6238 SHA1 vectors match six-digit truncation at times past 2038", () => {
  for (const [seconds, expected] of [[59, "287082"], [1111111109, "081804"], [1111111111, "050471"], [1234567890, "005924"], [2000000000, "279037"], [20000000000, "353130"]]) {
    const step = Math.floor(seconds / 30);
    assert.equal(adminTotpCode(key, step), expected);
    assert.equal(matchingAdminTotpStep({ key }, expected, seconds * 1000), step);
  }
});

test("validation preserves leading zeroes, accepts at most one neighbouring step and rejects coercion", () => {
  const timestamp = 1234567890000;
  const step = Math.floor(timestamp / 30_000);
  for (const delta of [-1, 0, 1]) assert.equal(matchingAdminTotpStep({ key }, adminTotpCode(key, step + delta), timestamp), step + delta);
  for (const delta of [-2, 2, -20, 20]) assert.equal(matchingAdminTotpStep({ key }, adminTotpCode(key, step + delta), timestamp), null);
  for (const code of [5924, "5924", " 005924", "005924\n", ["005924"], { code: "005924" }, null]) assert.equal(matchingAdminTotpStep({ key }, code, timestamp), null);
  for (const timestamp of [-1, NaN, Infinity]) assert.equal(matchingAdminTotpStep({ key }, "005924", timestamp), null);
});

test("Base32 setup and config decode round-trip without losing leading zero bytes", (t) => {
  const saved = { ADMIN_TOTP_SECRET: process.env.ADMIN_TOTP_SECRET, ADMIN_MFA_REQUIRED: process.env.ADMIN_MFA_REQUIRED };
  t.after(() => { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  assert.equal(encodeAdminTotpKey(key), "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  process.env.ADMIN_MFA_REQUIRED = "true";
  for (const bytes of [key, Buffer.alloc(20), Buffer.alloc(20, 255), Buffer.from("00000102030405060708090a0b0c0d0e0f101112", "hex")]) {
    process.env.ADMIN_TOTP_SECRET = encodeAdminTotpKey(bytes).toLowerCase();
    assert.deepEqual(adminMfaConfig().key, bytes);
  }
  assert.notEqual(adminSessionKey("password", { key }), adminSessionKey("password", null));
  assert.notEqual(adminSessionKey("password", { key }), adminSessionKey("password", { key: Buffer.alloc(20) }));
});

test("setup creates unique 160-bit seeds and a correctly configured authenticator URI without network calls", () => {
  const first = generateAdminTotpSetup();
  const second = generateAdminTotpSetup();
  assert.match(first.secret, /^[A-Z2-7]{32}$/);
  assert.notEqual(first.secret, second.secret);
  const uri = new URL(first.uri);
  assert.equal(uri.protocol, "otpauth:");
  assert.equal(uri.hostname, "totp");
  for (const [name, value] of Object.entries({ secret: first.secret, issuer: "J777", algorithm: "SHA1", digits: "6", period: "30" })) assert.equal(uri.searchParams.get(name), value);
  // Capture helper output privately; never print the generated real setup key.
  const output = execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/setup-admin-mfa.mjs", import.meta.url))], { encoding: "utf8" });
  assert.match(output, /ADMIN_TOTP_SECRET=[A-Z2-7]{32}/);
  assert.match(output, /ADMIN_MFA_REQUIRED=true/);
});
