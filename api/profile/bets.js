import { currentSession } from "../../server/auth.mjs";
import { getPool } from "../../server/neon.mjs";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const session = await currentSession(req);
  if (!session?.user) return res.status(401).json({ error: "Not authenticated" });
  const result = await getPool().query(
    `select bet_uid, round_id, bet, win, changemoney, balance_after, game_id, created_at
       from public.slot_bets where user_id = $1::uuid order by created_at desc limit 8`,
    [session.user.id],
  );
  return res.status(200).json(result.rows);
}
