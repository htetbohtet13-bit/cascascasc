function formBody(req) {
  if (typeof req.body === "string") return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");
  if (req.body && typeof req.body === "object") {
    return new URLSearchParams(
      Object.entries(req.body).map(([key, value]) => [key, String(value ?? "")]),
    ).toString();
  }
  return "";
}

export async function proxySlot(req, res, functionPath) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY;

  if (!functionPath || !supabaseUrl || !anonKey) {
    res.status(404).json({ code: 0, msg: "Not found" });
    return;
  }

  const forwarded = await fetch(`${supabaseUrl}${functionPath}`, {
    method: req.method ?? "POST",
    headers: {
      "Content-Type":
        req.headers["content-type"] ?? "application/x-www-form-urlencoded",
      Authorization: `Bearer ${anonKey}`,
      apikey: anonKey,
    },
    body: req.method === "GET" || req.method === "HEAD" ? undefined : formBody(req),
  });

  const payload = Buffer.from(await forwarded.arrayBuffer());
  res.status(forwarded.status);
  res.setHeader(
    "Content-Type",
    forwarded.headers.get("Content-Type") ?? "application/json",
  );
  res.send(payload);
}
