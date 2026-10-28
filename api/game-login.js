import { gameLoginFailure, handleGameLogin } from "../server/game-login.mjs";
import { currentSession } from "../server/auth.mjs";
import { unsafeRequestError } from "../server/request-security.mjs";
import { readJsonBody, sendBodyError } from "../server/request-body.mjs";

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const denied = unsafeRequestError(req);
  if (denied) return res.status(denied.status).json(denied.body);

  try {
    const payload = await readJsonBody(req);
    const session = await currentSession(req);
    const result = await handleGameLogin({
      userId: session?.user?.id,
      gameCode: payload.game_code,
      tableId: payload.table_id,
      device: /mobile|android|iphone/i.test(String(req.headers["user-agent"] ?? "")) ? "mobile" : "desktop",
    });
    return res.status(result.status).json(result.body);
  } catch (error) {
    if (sendBodyError(res, error)) return;
    console.error("Game login failed", error);
    const result = gameLoginFailure(error);
    return res.status(result.status).json(result.body);
  }
}
