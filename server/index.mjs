import http from "node:http";
import { currentSession } from "./auth.mjs";
import { issueGameToken } from "./game.mjs";
import { handleGameLogin } from "./game-login.mjs";
import { handleWalletProxy } from "./wallet-proxy.mjs";
import { proxySlot } from "../api/_slot-proxy.js";
import meHandler from "../api/me.js";
import betsHandler from "../api/profile/bets.js";
import authRequestHandler from "../api/auth/[...all].js";
import { handleAdminApi } from "./admin-api.mjs";

const port = Number(process.env.SLOT_API_PORT ?? 8787);

function adaptResponse(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(body)); return res; };
  res.send = (body) => { res.end(body); return res; };
  return res;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

const server = http.createServer(async (req, rawRes) => {
  const res = adaptResponse(rawRes);
  const path = new URL(req.url ?? "/", "http://localhost").pathname;

  try {
    if (req.method === "OPTIONS" && path.startsWith("/api/slot/")) {
      return proxySlot(req, res, path === "/api/slot/balance" ? "balance" : "change");
    }
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method === "POST" || req.method === "PUT") req.body = await readJson(req);
    if (path.startsWith("/api/auth/")) return authRequestHandler(req, res);
    if (path === "/api/me") return meHandler(req, res);
    if (path === "/api/profile/bets") return betsHandler(req, res);
    if (path === "/api/admin") {
      res.setHeader("Cache-Control", "private, no-store");
      const result = await handleAdminApi(req);
      for (const [name, value] of Object.entries(result.headers ?? {})) res.setHeader(name, value);
      return res.status(result.status).json(result.body);
    }
    if (path === "/api/game/session") {
      const session = await currentSession(req);
      if (!session?.user) return res.status(401).json({ error: "Not authenticated" });
      return res.status(200).json(await issueGameToken(session.user.id));
    }
    if (path === "/api/game-login") {
      const session = await currentSession(req);
      const result = await handleGameLogin({ ...req.body, userId: session?.user?.id });
      return res.status(result.status).json(result.body);
    }
    if (path.startsWith("/api/wallet/")) {
      const functionName = { config: "wallet-config", deposit: "wallet-deposit", withdraw: "wallet-withdraw", history: "wallet-history" }[path.split("/").at(-1)];
      if (!functionName) return res.status(404).json({ error: "Not found" });
      const result = await handleWalletProxy({ req, functionName, method: req.method, payload: req.body });
      return res.status(result.status).json(result.body);
    }
    if (path === "/api/slot/balance" || path === "/api/slot/change-balance") {
      return proxySlot(req, res, path === "/api/slot/balance" ? "balance" : "change");
    }
    return res.status(404).json({ error: "Not found" });
  } catch (error) {
    console.error("API request failed", error);
    return res.status(500).json({ error: "Request failed" });
  }
});

server.listen(port, () => console.log(`Neon API listening on http://localhost:${port}`));
