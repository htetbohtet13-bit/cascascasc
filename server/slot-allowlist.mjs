const DEFAULT_SLOT_ALLOWED_IPS = ["157.230.243.201"];

function headerValue(headers, name) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  if (Array.isArray(value)) return String(value[0] ?? "");
  return value ? String(value) : "";
}

export function normalizeIp(ip) {
  let value = (ip ?? "").trim();
  if (value.startsWith("[") && value.includes("]")) {
    value = value.slice(1, value.indexOf("]"));
  }
  if (value.toLowerCase().startsWith("::ffff:")) {
    value = value.slice(7);
  }
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(value)) {
    value = value.slice(0, value.lastIndexOf(":"));
  }
  return value;
}

export function allowedSlotIps() {
  const raw = process.env.SLOT_ALLOWED_IPS;
  if (raw != null && raw.trim()) {
    return raw
      .split(",")
      .map((ip) => normalizeIp(ip))
      .filter(Boolean);
  }
  return DEFAULT_SLOT_ALLOWED_IPS;
}

export function clientIp(req) {
  const headers = req.headers ?? {};
  const vercel =
    headerValue(headers, "x-vercel-forwarded-for") ||
    headerValue(headers, "x-real-ip");
  if (vercel) return normalizeIp(vercel.split(",")[0]);

  const forwarded = headerValue(headers, "x-forwarded-for");
  if (forwarded) return normalizeIp(forwarded.split(",")[0]);

  return normalizeIp(req.socket?.remoteAddress ?? req.connection?.remoteAddress ?? "");
}

export function isLoopbackIp(ip) {
  return ip === "127.0.0.1" || ip === "::1" || ip === "localhost";
}

export function isAllowedSlotCaller(req) {
  if (String(process.env.SLOT_IP_ALLOWLIST ?? "").toLowerCase() === "off") {
    return true;
  }

  const ip = clientIp(req);
  if (isLoopbackIp(ip) && !process.env.VERCEL) return true;
  return allowedSlotIps().includes(ip);
}
