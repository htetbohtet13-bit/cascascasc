import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROVIDER_LOGIN_URL = "https://api-ms.african-buffalo.net/api/game-login";
const DEFAULT_LOBBY_URL = "https://j777ml.com";
const DEFAULT_DOMAIN = "jlwin777.com";
const DEFAULT_GATEWAY_URL = "http://69.169.109.91:3001/";

function parseEnvFile(text) {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function loadLocalEnv() {
  const candidates = [];
  try {
    candidates.push(join(dirname(fileURLToPath(import.meta.url)), "..", ".env"));
  } catch {
    // import.meta.url is unavailable in some bundled contexts
  }
  candidates.push(join(process.cwd(), ".env"));

  for (const envPath of candidates) {
    try {
      const parsed = parseEnvFile(readFileSync(envPath, "utf8"));
      for (const [key, value] of Object.entries(parsed)) {
        if (!process.env[key]) process.env[key] = value;
      }
      if (parsed.GATEWAY_SECRET) process.env.GATEWAY_SECRET = parsed.GATEWAY_SECRET;
      if (parsed.GATEWAY_URL) process.env.GATEWAY_URL = parsed.GATEWAY_URL;
      return;
    } catch {
      // try the next path
    }
  }
}

loadLocalEnv();

function extractGameUrl(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.url === "string" && payload.url) return payload.url;
  if (typeof payload.data === "string" && payload.data.startsWith("http")) {
    return payload.data;
  }
  if (payload.data && typeof payload.data.url === "string") return payload.data.url;
  return null;
}

export async function handleGameLogin({
  authHeader,
  supabaseUrl,
  anonKey,
  gameId = 23,
  roomId = 1,
  lobbyUrl = process.env.LOBBY_URL ?? DEFAULT_LOBBY_URL,
  domain = process.env.GAME_PROVIDER_DOMAIN ?? DEFAULT_DOMAIN,
  gatewayUrl = process.env.GATEWAY_URL ?? DEFAULT_GATEWAY_URL,
  gatewaySecret = process.env.GATEWAY_SECRET ?? "",
}) {
  if (!authHeader) {
    return { status: 401, body: { error: "Not authenticated" } };
  }

  if (!supabaseUrl || !anonKey) {
    return { status: 500, body: { error: "Server is not configured" } };
  }

  const secret = gatewaySecret || process.env.GATEWAY_SECRET || "";
  const proxyUrl = gatewayUrl || process.env.GATEWAY_URL || DEFAULT_GATEWAY_URL;

  if (!secret) {
    return { status: 500, body: { error: "Game gateway is not configured" } };
  }

  const tokenRes = await fetch(`${supabaseUrl}/functions/v1/issue-game-token`, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      apikey: anonKey,
    },
  });
  const tokenData = await tokenRes.json().catch(() => ({}));

  if (!tokenData?.uid || !tokenData?.token) {
    return {
      status: 400,
      body: { error: tokenData?.error ?? "Could not create game session" },
    };
  }

  const providerRes = await fetch(proxyUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Gateway-Secret": secret,
    },
    body: JSON.stringify({
      targetUrl: PROVIDER_LOGIN_URL,
      body: {
        uid: tokenData.uid,
        token: tokenData.token,
        gameId: Number(gameId) || 23,
        roomId: String(roomId || 1),
        lobbyUrl,
        domain,
      },
    }),
  });

  const providerBody = await providerRes.json().catch(() => ({}));
  const url = extractGameUrl(providerBody);

  if (!url) {
    const message =
      providerBody.error ??
      providerBody.msg ??
      providerBody.message ??
      `Game login failed (${providerRes.status})`;
    return { status: 400, body: { error: message } };
  }

  return { status: 200, body: { url } };
}
