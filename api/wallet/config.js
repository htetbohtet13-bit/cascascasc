import { handleWalletProxy } from "../../server/wallet-proxy.mjs";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
    res.status(204).end();
    return;
  }

  const result = await handleWalletProxy({
    authHeader: req.headers.authorization,
    supabaseUrl: process.env.VITE_SUPABASE_URL,
    anonKey: process.env.VITE_SUPABASE_ANON_KEY,
    functionName: "wallet-config",
    method: "GET",
  });

  res.status(result.status).json(result.body);
}
