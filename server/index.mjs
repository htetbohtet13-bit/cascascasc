import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { handleGameLogin } from "./game-login.mjs";
import { isAllowedSlotCaller } from "./slot-allowlist.mjs";
import { handleWalletProxy } from "./wallet-proxy.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

for (const line of readFileSync(join(root, ".env"), "utf8").split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq <= 0) continue;
  const key = trimmed.slice(0, eq).trim();
  let value = trimmed.slice(eq + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  if (!process.env[key] || key === "GATEWAY_SECRET" || key === "GATEWAY_URL") {
    process.env[key] = value;
  }
}

const supabaseUrl = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
const anonKey = process.env.VITE_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY;
const port = Number(process.env.SLOT_API_PORT ?? 8787);

const routes = {
  "/api/slot/balance": "/functions/v1/slot-balance",
  "/api/slot/change-balance": "/functions/v1/slot-change-balance",
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization",
};

const server = http.createServer(async (req, res) => {
  const path = req.url?.split("?")[0] ?? "";

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  if (path === "/api/game-login") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let payload = {};
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      payload = {};
    }

    const result = await handleGameLogin({
      authHeader: req.headers.authorization,
      supabaseUrl,
      anonKey,
      gameId: Number(payload.gameId ?? 23),
      roomId: Number(payload.roomId ?? 1),
      lobbyUrl: process.env.LOBBY_URL,
      domain: process.env.GAME_PROVIDER_DOMAIN,
      gatewayUrl: process.env.GATEWAY_URL,
      gatewaySecret: process.env.GATEWAY_SECRET,
    });

    res.writeHead(result.status, {
      "Content-Type": "application/json",
      ...corsHeaders,
    });
    res.end(JSON.stringify(result.body));
    return;
  }

  const walletFunction = {
    "/api/wallet/config": "wallet-config",
    "/api/wallet/deposit": "wallet-deposit",
    "/api/wallet/withdraw": "wallet-withdraw",
  }[path];

  if (walletFunction) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let payload = {};
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      payload = {};
    }

    const result = await handleWalletProxy({
      authHeader: req.headers.authorization,
      supabaseUrl,
      anonKey,
      functionName: walletFunction,
      method: req.method === "GET" ? "GET" : "POST",
      payload,
    });

    res.writeHead(result.status, {
      "Content-Type": "application/json",
      ...corsHeaders,
    });
    res.end(JSON.stringify(result.body));
    return;
  }

  const functionPath = routes[path];
  if (!functionPath || !supabaseUrl || !anonKey) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: 0, msg: "Not found" }));
    return;
  }

  if (!isAllowedSlotCaller(req)) {
    res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders });
    res.end(JSON.stringify({ code: 0 }));
    return;
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);

  const forwarded = await fetch(`${supabaseUrl}${functionPath}`, {
    method: req.method ?? "POST",
    headers: {
      "Content-Type": req.headers["content-type"] ?? "application/x-www-form-urlencoded",
      Authorization: `Bearer ${anonKey}`,
      apikey: anonKey,
    },
    body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
  });

  res.writeHead(forwarded.status, {
    "Content-Type": forwarded.headers.get("Content-Type") ?? "application/json",
  });
  res.end(Buffer.from(await forwarded.arrayBuffer()));
});

server.listen(port, () => {
  console.log(`Partner API on http://localhost:${port}`);
});
