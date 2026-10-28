import { handleWalletProxy } from "../../server/wallet-proxy.mjs";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const result = await handleWalletProxy({
    req,
    functionName: "wallet-config",
    method: "GET",
  });

  res.status(result.status).json(result.body);
}

