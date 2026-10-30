import { currentSession } from "../../server/auth.mjs";
import { walletHistory } from "../../server/wallet.mjs";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Allow", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const session = await currentSession(req);
    if (!session?.user) return res.status(401).json({ error: "Not authenticated" });
    return res.status(200).json({ history: await walletHistory(session.user.id) });
  } catch (error) {
    const codes = ["42P01", "42703", "42501", "08006", "57014"];
    console.error("Wallet history request failed", { code: codes.includes(error?.code) ? error.code : "unavailable" });
    return res.status(500).json({ error: "ငွေစာရင်းမှတ်တမ်းကို ဖွင့်မရပါ။ ခဏစောင့်ပြီး ပြန်လည်ကြိုးစားပါ။" });
  }
}
