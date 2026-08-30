import { handleGameLogin } from "../server/game-login.mjs";

function jsonBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    return req.body;
  }
  if (typeof req.body === "string" && req.body) {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return {};
}

function lobbyUrl() {
  if (process.env.LOBBY_URL) return process.env.LOBBY_URL;
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "https://www.j777ml.com";
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const payload = jsonBody(req);
  const result = await handleGameLogin({
    authHeader: req.headers.authorization,
    supabaseUrl: process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL,
    anonKey: process.env.VITE_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY,
    gameId: Number(payload.gameId ?? 23),
    roomId: Number(payload.roomId ?? 1),
    lobbyUrl: lobbyUrl(),
    domain: process.env.GAME_PROVIDER_DOMAIN ?? "jlwin777.com",
    gatewayUrl: process.env.GATEWAY_URL,
    gatewaySecret: process.env.GATEWAY_SECRET,
  });

  res.status(result.status).json(result.body);
}
