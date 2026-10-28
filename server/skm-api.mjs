import { createHmac, timingSafeEqual } from "node:crypto";

export class SkmApiError extends Error {
  constructor(message, { status = 502, code = "PROVIDER_ERROR" } = {}) {
    super(message);
    this.name = "SkmApiError";
    this.status = status;
    this.code = code;
  }
}

export function skmConfig() {
  const apiBaseUrl = String(process.env.gameapibaseurl ?? "").trim().replace(/\/+$/, "");
  const operatorCode = String(process.env.operatorcode ?? "").trim();
  const secret = String(process.env.gameproviderkey ?? "").trim();
  if (!apiBaseUrl || !operatorCode || !secret) {
    throw new SkmApiError("Provider API settings are missing", { status: 503, code: "CONFIG_MISSING" });
  }
  let parsed;
  try {
    parsed = new URL(apiBaseUrl);
  } catch {
    throw new SkmApiError("Provider API base URL is invalid", { status: 503, code: "CONFIG_INVALID" });
  }
  if (parsed.protocol !== "https:") {
    throw new SkmApiError("Provider API base URL must use HTTPS", { status: 503, code: "CONFIG_INVALID" });
  }
  return { apiBaseUrl, operatorCode, secret };
}

function gatewayConfig() {
  const gatewayUrl = String(process.env.GATEWAY_URL ?? "").trim();
  const gatewaySecret = String(process.env.GATEWAY_SECRET ?? "").trim();
  if (!gatewayUrl || !gatewaySecret) {
    throw new SkmApiError("VPS gateway settings are missing", { status: 503, code: "CONFIG_MISSING" });
  }
  let parsedGateway;
  try {
    parsedGateway = new URL(gatewayUrl);
  } catch {
    throw new SkmApiError("Gateway URL is invalid", { status: 503, code: "CONFIG_INVALID" });
  }
  if (parsedGateway.protocol !== "https:" && parsedGateway.protocol !== "http:") {
    throw new SkmApiError("Gateway URL must use HTTP or HTTPS", { status: 503, code: "CONFIG_INVALID" });
  }
  const gatewayPath = parsedGateway.pathname.replace(/\/+$/, "");
  parsedGateway.pathname = gatewayPath.endsWith("/proxy") ? gatewayPath : `${gatewayPath}/proxy`;
  parsedGateway.search = "";
  parsedGateway.hash = "";
  return { gatewayUrl: parsedGateway.toString(), gatewaySecret };
}

function signature(secret, timestamp, rawBody) {
  return createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), rawBody]))
    .digest("hex");
}

export function verifySkmRequest({ headers, rawBody }) {
  const config = skmConfig();
  const operatorCode = String(headers?.["x-operator-code"] ?? "");
  const timestamp = String(headers?.["x-timestamp"] ?? "");
  const supplied = String(headers?.["x-signature"] ?? "");
  if (operatorCode !== config.operatorCode || !/^\d{1,12}$/.test(timestamp) || !/^[0-9a-f]{64}$/i.test(supplied)) {
    return { ok: false, reason: "INVALID_SIGNATURE" };
  }
  const issuedAt = Number(timestamp);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(issuedAt) || Math.abs(now - issuedAt) > 300) {
    return { ok: false, reason: "EXPIRED_REQUEST" };
  }
  const expected = Buffer.from(signature(config.secret, timestamp, rawBody), "hex");
  const actual = Buffer.from(supplied, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected)
    ? { ok: true }
    : { ok: false, reason: "INVALID_SIGNATURE" };
}

export function signedSkmResponse(body) {
  const config = skmConfig();
  const rawBody = Buffer.from(JSON.stringify(body), "utf8");
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    rawBody,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Operator-Code": config.operatorCode,
      "X-Timestamp": timestamp,
      "X-Signature": signature(config.secret, timestamp, rawBody),
    },
  };
}

export async function callSkmApi(path, { method = "GET", payload } = {}) {
  const { apiBaseUrl, operatorCode, secret } = skmConfig();
  const { gatewayUrl, gatewaySecret } = gatewayConfig();
  const rawBody = method === "GET" ? Buffer.alloc(0) : Buffer.from(JSON.stringify(payload ?? {}), "utf8");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const url = `${apiBaseUrl}/${String(path).replace(/^\/+/, "")}`;
  const providerHeaders = {
    "X-Operator-Code": operatorCode,
    "X-Timestamp": timestamp,
    "X-Signature": signature(secret, timestamp, rawBody),
    ...(method === "GET" ? {} : { "Content-Type": "application/json" }),
  };
  const response = await fetch(gatewayUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Gateway-Secret": gatewaySecret,
    },
    body: JSON.stringify({
      targetUrl: url,
      method,
      headers: providerHeaders,
      body: method === "GET" ? null : payload ?? {},
      rawBody: rawBody.toString("utf8"),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* preserve a safe generic provider error */ }
  if (!response.ok) {
    const errorData = data?.error && typeof data.error === "object" ? data.error : data;
    const code = String(errorData?.code ?? errorData?.error_code ?? (typeof data?.error === "string" ? data.error : "PROVIDER_ERROR"));
    const message = [errorData?.message, errorData?.detail, errorData?.error_description,
      typeof data?.error === "string" ? data.error : undefined]
      .find((value) => typeof value === "string" && value.trim())
      ?? (text.trim() ? text.trim().slice(0, 400) : "The game provider rejected the request");
    throw new SkmApiError(message, { status: response.status, code });
  }
  return data;
}

let gamesCache;
let gamesCacheAt = 0;

export async function listProviderGames({ refresh = false } = {}) {
  if (!refresh && gamesCache && Date.now() - gamesCacheAt < 30_000) return gamesCache;
  const payload = await callSkmApi("games");
  if (!Array.isArray(payload?.games)) {
    throw new SkmApiError("Provider returned an invalid game list", { status: 502, code: "INVALID_RESPONSE" });
  }
  gamesCache = payload.games;
  gamesCacheAt = Date.now();
  return gamesCache;
}
