import { isAllowedSlotCaller } from "../server/slot-allowlist.mjs";
import { applySlotChange, getSlotBalance } from "../server/game.mjs";

function asParams(req) {
  const params = Object.fromEntries(new URL(req.url, "http://localhost").searchParams);
  const body = req.body;
  if (body && typeof body === "object" && !Buffer.isBuffer(body)) {
    for (const [key, value] of Object.entries(body)) if (value != null) params[key] = String(value);
  } else if (typeof body === "string" || Buffer.isBuffer(body)) {
    const text = String(body);
    try {
      Object.assign(params, text.trim().startsWith("{") ? JSON.parse(text) : Object.fromEntries(new URLSearchParams(text)));
    } catch { /* malformed partner callback */ }
  }
  return params;
}

export async function proxySlot(req, res, route) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(200).json({ code: 0, msg: "POST required" });
  if (!isAllowedSlotCaller(req)) return res.status(200).json({ code: 0, msg: "Request not allowed" });
  try {
    const params = asParams(req);
    const result = route === "balance"
      ? await getSlotBalance(params.uid, params.token)
      : await applySlotChange(params);
    if (!result.ok) {
      return res.status(200).json({ code: 0, msg: result.message ?? "Invalid request or token" });
    }
    if (route === "balance") {
      return res.status(200).json({ code: 1, msg: "Success", balance: result.balance });
    }
    return res.status(200).json({ code: 1, msg: String(result.balance) });
  } catch (error) {
    console.error(`Slot ${route} callback failed`, error);
    return res.status(200).json({ code: 0, msg: "Request failed" });
  }
}
