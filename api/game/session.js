import { currentSession } from "../../server/auth.mjs";
import { issueGameToken } from "../../server/game.mjs";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const session = await currentSession(req);
  if (!session?.user) return res.status(401).json({ error: "Not authenticated" });
  try {
    return res.status(200).json(await issueGameToken(session.user.id));
  } catch {
    return res.status(500).json({ error: "Could not create a game session" });
  }
}
