import { currentSession } from "../../server/auth.mjs";
import { getPool } from "../../server/neon.mjs";
import { playerGameHistory } from "../../server/game-history.mjs";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const session = await currentSession(req);
  if (!session?.user) return res.status(401).json({ error: "Not authenticated" });
  try {
    return res.status(200).json(await playerGameHistory(getPool(), session.user.id));
  } catch (error) {
    console.error("Player game history lookup failed", { code: error?.code ?? "unavailable" });
    return res.status(500).json({ error: "ကစားမှုမှတ်တမ်းကို ဖွင့်မရပါ။ ခဏစောင့်ပြီး ပြန်လည်ကြိုးစားပါ။" });
  }
}
