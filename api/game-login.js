import { gameLoginFailure, handleGameLogin } from "../server/game-login.mjs";
import { currentSession } from "../server/auth.mjs";

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

  try {
    const payload = jsonBody(req);
    const session = await currentSession(req);
    const result = await handleGameLogin({
      userId: session?.user?.id,
      gameCode: payload.game_code,
      tableId: payload.table_id,
      device: /mobile|android|iphone/i.test(String(req.headers["user-agent"] ?? "")) ? "mobile" : "desktop",
    });
    return res.status(result.status).json(result.body);
  } catch (error) {
    console.error("Game login failed", error);
    const result = gameLoginFailure(error);
    return res.status(result.status).json(result.body);
  }
}
