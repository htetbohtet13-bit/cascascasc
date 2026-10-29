import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const PERIOD_MS = 30_000;

// A fixed 160-bit, canonical Base32 key is compatible with authenticator apps.
// No authenticator seed or submitted code is returned by a browser endpoint.
export function encodeAdminTotpKey(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== 20) throw new Error("Expected a 160-bit authenticator key");
  let value = 0;
  let bits = 0;
  let encoded = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += BASE32[(value >>> bits) & 31];
    }
    value &= (1 << bits) - 1;
  }
  return encoded;
}

function configurationError() {
  return Object.assign(new Error("Admin authenticator configuration is invalid"), { code: "ADMIN_MFA_CONFIG_INVALID" });
}

export function adminMfaConfig() {
  const required = String(process.env.ADMIN_MFA_REQUIRED ?? "false").trim().toLowerCase();
  if (!["true", "false"].includes(required)) throw configurationError();
  const secret = String(process.env.ADMIN_TOTP_SECRET ?? "").trim().toUpperCase();
  if (!secret && required === "false") return null;
  if (!/^[A-Z2-7]{32}$/.test(secret)) throw configurationError();
  const key = Buffer.alloc(20);
  let value = 0;
  let bits = 0;
  let offset = 0;
  for (const character of secret) {
    value = (value << 5) | BASE32.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      key[offset++] = (value >>> bits) & 255;
    }
    value &= (1 << bits) - 1;
  }
  return { key };
}

// RFC 4226 dynamic truncation, using Node's HMAC implementation. The caller
// supplies the RFC 6238 Unix-time counter; SHA1/6 digits/30 seconds are fixed.
export function adminTotpCode(key, step) {
  if (!Number.isSafeInteger(step) || step < 0) throw new Error("Invalid authenticator counter");
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

export function matchingAdminTotpStep(mfa, code, timestamp = Date.now()) {
  if (typeof code !== "string" || code.length !== 6 || !/^[0-9]{6}$/.test(code) || !Number.isSafeInteger(timestamp) || timestamp < 0) return null;
  const current = Math.floor(timestamp / PERIOD_MS);
  const supplied = Buffer.from(code, "ascii");
  let match = null;
  // Only one neighbouring time step in each direction is accepted. Compare all
  // three candidates rather than stopping at the first matching time window.
  for (const delta of [0, -1, 1]) {
    const step = current + delta;
    if (step < 0) continue;
    const valid = timingSafeEqual(supplied, Buffer.from(adminTotpCode(mfa.key, step), "ascii"));
    if (valid && match === null) match = step;
  }
  return match;
}

export function adminSessionKey(password, mfa) {
  if (!mfa) return password;
  // Enabling or rotating MFA invalidates password-only and old-MFA sessions.
  return createHmac("sha256", password).update("casino-admin-mfa-session-v1\0").update(mfa.key).digest("hex");
}

export async function claimAdminTotp(client, mfa, step) {
  const hash = createHmac("sha256", mfa.key).update(`casino-admin-totp-used-v1\0${step}`).digest("hex");
  // Existing migration 009 supplies the unique (scope,key_hash) key and the
  // runtime role already has these privileges. Never SELECT then INSERT: only
  // one login can claim a code across concurrent serverless instances.
  const result = await client.query(
    `insert into public.auth_rate_limits (scope, key_hash, attempts, expires_at)
     values ('admin-totp-used:v1', $1, 1, now() + interval '5 minutes')
     on conflict (scope, key_hash) do nothing
     returning key_hash`,
    [hash],
  );
  return result.rows.length === 1;
}

export function generateAdminTotpSetup() {
  const secret = encodeAdminTotpKey(randomBytes(20));
  const parameters = new URLSearchParams({ secret, issuer: "J777", algorithm: "SHA1", digits: "6", period: "30" });
  return { secret, uri: `otpauth://totp/J777:admin?${parameters}` };
}
