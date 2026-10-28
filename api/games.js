import { listProviderGames } from "../server/skm-api.mjs";
import { applyGameDisplaySettings } from "../server/game-display.mjs";
import { getPool } from "../server/neon.mjs";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const providerGames = await listProviderGames();
    const display = await applyGameDisplaySettings(getPool(), providerGames);
    return res.status(200).json({ games: display.games });
  } catch (error) {
    console.error("Game catalog lookup failed", error);
    const status = Number.isInteger(error?.status) ? error.status : 502;
    return res.status(status).json({ error: status === 503 ? "Game provider or gateway settings are missing" : "Could not load games" });
  }
}
