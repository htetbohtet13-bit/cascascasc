import { currentSession } from "../server/auth.mjs";
import { getProfile } from "../server/wallet.mjs";

export default async function handler(req, res) {
  const session = await currentSession(req);
  if (!session?.user) return res.status(401).json({ error: "Not authenticated" });
  const profile = await getProfile(session.user.id);
  return res.status(200).json({ user: session.user, profile });
}
