import { listProviderGames } from "../server/skm-api.mjs";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    return res.status(200).json({ games: await listProviderGames() });
  } catch (error) {
    console.error("Game catalog lookup failed", error);
    const status = Number.isInteger(error?.status) ? error.status : 502;
    return res.status(status).json({ error: status === 503 ? "Provider API settings are missing" : "Could not load games" });
  }
}
