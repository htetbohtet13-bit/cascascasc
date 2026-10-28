import { handleWalletProxy } from "../../server/wallet-proxy.mjs";
import { unsafeRequestError } from "../../server/request-security.mjs";
import { readJsonBody, sendBodyError } from "../../server/request-body.mjs";

export const config = {
  maxDuration: 120,
  api: { bodyParser: false },
};

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const denied = unsafeRequestError(req);
  if (denied) return res.status(denied.status).json(denied.body);
  try {
    const result = await handleWalletProxy({
      req,
      functionName: "wallet-withdraw",
      payload: await readJsonBody(req),
    });
    for (const [name, value] of Object.entries(result.headers ?? {})) res.setHeader(name, value);
    return res.status(result.status).json(result.body);
  } catch (error) {
    if (sendBodyError(res, error)) return;
    console.error("Wallet withdrawal failed", error?.name);
    return res.status(500).json({ error: "Wallet request failed" });
  }
}

