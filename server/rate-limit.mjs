import { createHmac, randomInt } from "node:crypto";
import { getPool } from "./neon.mjs";
import { trustedClientIp } from "./request-security.mjs";

const POLICIES = {
  // Carrier NAT can put unrelated players behind one address, so IP limits are
  // coarse. Tight account limits stop distributed guesses but can temporarily
  // block a known phone for 15 minutes if an attacker targets it deliberately.
  "sign-in": [{ kind: "ip", limit: 120, seconds: 900 }, { kind: "identity", limit: 10, seconds: 900 }],
  "sign-up": [{ kind: "ip", limit: 30, seconds: 3600 }, { kind: "identity", limit: 3, seconds: 3600 }],
  "admin-login": [{ kind: "ip", limit: 10, seconds: 900 }],
  "deposit-verify": [
    { kind: "ip", limit: 120, seconds: 300 },
    { kind: "identity", limit: 6, seconds: 300 },
    { kind: "identity", limit: 30, seconds: 3600 },
  ],
};

function identifierHash(scope, value) {
  // An optional dedicated secret avoids changing buckets when DB credentials rotate.
  const secret = process.env.RATE_LIMIT_SECRET || process.env.admin_secret || process.env.ADMIN_SECRET || process.env.DATABASE_URL;
  if (!secret) throw new Error("Rate limiting is not configured");
  return createHmac("sha256", secret).update(`casino-rate-limit-v1\0${scope}\0${value}`).digest("hex");
}

export async function consumeRateLimit(req, action, identifier = "") {
  const policy = POLICIES[action];
  if (!policy) throw new Error("Unknown rate limit policy");
  try {
    const ip = trustedClientIp(req);
    const buckets = policy.map((entry) => {
      const scope = `${action}:${entry.kind}:${entry.seconds}`;
      const value = entry.kind === "ip" ? ip : String(identifier || "unknown").slice(0, 256);
      return { ...entry, scope, hash: identifierHash(scope, value) };
    });
    // Consume the IP ceiling first. Requests above that ceiling must not create
    // fresh identity rows by sending a different phone number on every attempt.
    // Each stage is atomic across independent serverless instances.
    for (const stage of [buckets.filter((entry) => entry.kind === "ip"), buckets.filter((entry) => entry.kind === "identity")]) {
      if (!stage.length) continue;
      const result = await getPool().query(
      `insert into public.auth_rate_limits (scope, key_hash, attempts, window_started_at, expires_at)
       select scope, key_hash, 1, now(), now() + seconds * interval '1 second'
         from unnest($1::text[], $2::text[], $3::integer[]) as limits(scope, key_hash, seconds)
        order by scope, key_hash
       on conflict (scope, key_hash) do update set
         attempts = case when auth_rate_limits.expires_at <= now() then 1
                         else least(auth_rate_limits.attempts + 1, 1000000) end,
         window_started_at = case when auth_rate_limits.expires_at <= now() then excluded.window_started_at
                                  else auth_rate_limits.window_started_at end,
         expires_at = case when auth_rate_limits.expires_at <= now() then excluded.expires_at
                           else auth_rate_limits.expires_at end
       returning scope, attempts,
         greatest(1, ceil(extract(epoch from (expires_at - now()))))::integer as retry_after`,
        [stage.map((entry) => entry.scope), stage.map((entry) => entry.hash), stage.map((entry) => entry.seconds)],
      );
      let retryAfter = 0;
      for (const bucket of stage) {
        const row = result.rows.find((entry) => entry.scope === bucket.scope);
        if (!row) throw new Error("Incomplete rate limit result");
        if (Number(row.attempts) > bucket.limit) retryAfter = Math.max(retryAfter, Number(row.retry_after));
      }
      if (retryAfter) {
        return { status: 429, headers: { "Retry-After": String(retryAfter) }, body: { error: "Too many attempts. Please try again later." } };
      }
    }
    // Keep abandoned identifiers bounded without requiring a scheduler. Expiry
    // checks enforce security even if this best-effort maintenance cannot run.
    if (randomInt(100) === 0) {
      await getPool().query(
        `delete from public.auth_rate_limits where (scope, key_hash) in
           (select scope, key_hash from public.auth_rate_limits
             where expires_at < now() - interval '1 day' order by expires_at limit 1000)`,
      ).catch(() => {});
    }
    return null;
  } catch (error) {
    // A missing migration or DB outage must never silently disable protection.
    console.error("Rate limit storage unavailable", { code: error?.code ?? "unavailable" });
    return { status: 503, headers: { "Retry-After": "60" }, body: { error: "Sign-in and payment checks are temporarily unavailable. Please try again later." } };
  }
}
