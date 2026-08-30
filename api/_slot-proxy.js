import { isAllowedSlotCaller } from "../server/slot-allowlist.mjs";

function asRecord(value) {
  if (!value || typeof value !== "object" || Buffer.isBuffer(value)) return {};
  const params = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry == null || typeof entry === "object") continue;
    params[key] = String(entry).trim();
  }
  return params;
}

function parseText(text) {
  const raw = (text ?? "").trim();
  if (!raw) return {};
  if (raw.startsWith("{")) {
    try {
      return asRecord(JSON.parse(raw));
    } catch {
      return {};
    }
  }
  return Object.fromEntries(
    [...new URLSearchParams(raw)].map(([key, value]) => [key, value.trim()]),
  );
}

function collectParams(req) {
  const params = {};
  try {
    const url = new URL(req.url, "http://localhost");
    for (const [key, value] of url.searchParams) params[key] = value.trim();
  } catch {
    // ignore malformed urls
  }

  Object.assign(params, asRecord(req.query));

  if (typeof req.body === "string" || Buffer.isBuffer(req.body)) {
    Object.assign(params, parseText(String(req.body)));
  } else {
    Object.assign(params, asRecord(req.body));
  }

  return params;
}

export async function proxySlot(req, res, functionPath) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (!isAllowedSlotCaller(req)) {
    res.status(200).json({ code: 0 });
    return;
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY;

  if (!functionPath || !supabaseUrl || !anonKey) {
    res.status(200).json({ code: 0, msg: "Not found" });
    return;
  }

  const forwarded = await fetch(`${supabaseUrl}${functionPath}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Bearer ${anonKey}`,
      apikey: anonKey,
    },
    body: new URLSearchParams(collectParams(req)).toString(),
  });

  const payload = await forwarded.text();
  res.status(200);
  res.setHeader("Content-Type", "application/json");
  res.send(payload || JSON.stringify({ code: 0 }));
}
