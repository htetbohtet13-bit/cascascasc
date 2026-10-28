import { listProviderGames, MANUAL_SAMPLE_GAME } from "../server/skm-api.mjs";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    return res.status(200).json({ games: await listProviderGames() });
  } catch (error) {
    console.error("Game catalog lookup failed", error);
    return res.status(200).json({ games: [MANUAL_SAMPLE_GAME], catalog_fallback: true });
  }
}
