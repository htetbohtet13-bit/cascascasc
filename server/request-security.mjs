import { isIP } from "node:net";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const PRODUCTION_ORIGINS = ["https://www.j777ml.com", "https://j777ml.com"];

function header(req, name) {
  const value = req.headers?.[name];
  return typeof value === "string" ? value.trim() : "";
}

function parsedOrigin(value, originOnly = false) {
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    if (originOnly && value !== parsed.origin) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function trustedOrigins() {
  const origins = new Set(PRODUCTION_ORIGINS);
  for (const value of String(process.env.APP_ORIGINS ?? "").split(",")) {
    const origin = parsedOrigin(value.trim(), true);
    if (origin) origins.add(origin);
  }
  // Preview hosts come from deployment configuration, never a request Host header.
  if (process.env.VERCEL === "1" && process.env.VERCEL_ENV === "preview") {
    const origin = parsedOrigin(`https://${process.env.VERCEL_URL ?? ""}`, true);
    if (origin) origins.add(origin);
  }
  if (process.env.NODE_ENV !== "production" && process.env.VERCEL !== "1") {
    const ports = new Set(["5173", "5174", String(process.env.SLOT_API_PORT ?? "8787")]);
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      for (const port of ports) {
        if (/^\d{1,5}$/.test(port) && Number(port) > 0 && Number(port) <= 65535) origins.add(`http://${host}:${port}`);
      }
    }
  }
  return origins;
}

// Cookie-backed browser APIs only accept deliberate JSON requests from our UI.
// SameSite cookies alone do not prevent login CSRF or hostile sibling origins.
export function unsafeRequestError(req) {
  if (!UNSAFE_METHODS.has(String(req.method ?? "").toUpperCase())) return null;
  const originValue = header(req, "origin");
  const sourceOrigin = req.headers?.origin !== undefined
    ? parsedOrigin(originValue, true)
    : parsedOrigin(header(req, "referer"));
  if (!sourceOrigin || !trustedOrigins().has(sourceOrigin) || header(req, "sec-fetch-site").toLowerCase() === "cross-site") {
    return { status: 403, body: { error: "Request origin is not allowed" } };
  }
  if (header(req, "content-type").split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return { status: 415, body: { error: "Send this request as JSON" } };
  }
  return null;
}

function canonicalIp(value) {
  if (value.includes("%") || !isIP(value)) return "";
  if (isIP(value) === 4) return value;
  const address = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (mapped) {
    const high = Number.parseInt(mapped[1], 16);
    const low = Number.parseInt(mapped[2], 16);
    return [high >> 8, high & 255, low >> 8, low & 255].join(".");
  }
  return address;
}

export function trustedClientIp(req) {
  // Vercel overwrites this header at its edge. Other servers must use the socket,
  // not arbitrary X-Forwarded-For values supplied by an internet client.
  const value = process.env.VERCEL === "1"
    ? header(req, "x-vercel-forwarded-for")
    : String(req.socket?.remoteAddress ?? "").trim();
  return canonicalIp(value) || "unknown";
}
