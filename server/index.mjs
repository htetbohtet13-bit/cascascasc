import http from "node:http";
import { handleSkmWallet } from "../api/_skm-wallet.js";
import gameLoginHandler from "../api/game-login.js";
import walletConfigHandler from "../api/wallet/config.js";
import walletDepositHandler from "../api/wallet/deposit.js";
import walletWithdrawHandler from "../api/wallet/withdraw.js";
import { handleWalletProxy } from "./wallet-proxy.mjs";
import { readJsonBody, sendBodyError } from "./request-body.mjs";
import meHandler from "../api/me.js";
import betsHandler from "../api/profile/bets.js";
import authRequestHandler from "../api/auth/[...all].js";
import { handleAdminApi } from "./admin-api.mjs";
import { listProviderGames } from "./skm-api.mjs";
import { applyGameDisplaySettings } from "./game-display.mjs";
import { getPool } from "./neon.mjs";

const port = Number(process.env.SLOT_API_PORT ?? 8787);

function adaptResponse(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(body)); return res; };
  res.send = (body) => { res.end(body); return res; };
  return res;
}

const server = http.createServer(async (req, rawRes) => {
  const res = adaptResponse(rawRes);
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  try {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const walletRoutes = {
      "/balance": "balance",
      "/debit": "debit",
      "/credit": "credit",
      "/rollback": "rollback",
      "/api/provider-wallet/balance": "balance",
      "/api/provider-wallet/debit": "debit",
      "/api/provider-wallet/credit": "credit",
      "/api/provider-wallet/rollback": "rollback",
    };
    if (walletRoutes[path]) {
      return handleSkmWallet(req, res, walletRoutes[path]);
    }
    if (req.method === "OPTIONS") return res.status(204).end();
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) req.body = await readJsonBody(req);
    if (path.startsWith("/api/auth/")) return authRequestHandler(req, res);
    if (path === "/api/me") return meHandler(req, res);
    if (path === "/api/profile/bets") return betsHandler(req, res);
    if (path === "/api/games") {
      if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
      const providerGames = await listProviderGames();
      const display = await applyGameDisplaySettings(getPool(), providerGames);
      return res.status(200).json({ games: display.games });
    }
    if (path === "/api/admin") {
      res.setHeader("Cache-Control", "private, no-store");
      const result = await handleAdminApi(req);
      for (const [name, value] of Object.entries(result.headers ?? {})) res.setHeader(name, value);
      return res.status(result.status).json(result.body);
    }
    if (path === "/api/game-login") return gameLoginHandler(req, res);
    if (path.startsWith("/api/wallet/")) {
      if (path === "/api/wallet/config") return walletConfigHandler(req, res);
      if (path === "/api/wallet/deposit") return walletDepositHandler(req, res);
      if (path === "/api/wallet/withdraw") return walletWithdrawHandler(req, res);
      const functionName = path === "/api/wallet/history" ? "wallet-history" : null;
      if (!functionName) return res.status(404).json({ error: "Not found" });
      if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
      const result = await handleWalletProxy({ req, functionName, method: req.method, payload: req.body });
      for (const [name, value] of Object.entries(result.headers ?? {})) res.setHeader(name, value);
      return res.status(result.status).json(result.body);
    }
    return res.status(404).json({ error: "Not found" });
  } catch (error) {
    if (sendBodyError(res, error)) return;
    console.error("API request failed", error);
    return res.status(500).json({ error: "Request failed" });
  }
});
server.headersTimeout = 10_000;
server.requestTimeout = 15_000;
server.maxHeadersCount = 50;
server.keepAliveTimeout = 5_000;

server.listen(port, () => console.log(`Neon API listening on http://localhost:${port}`));
