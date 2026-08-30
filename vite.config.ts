import { readFileSync } from "node:fs";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import type { IncomingMessage } from "node:http";
import { handleGameLogin } from "./server/game-login.mjs";
import { isAllowedSlotCaller } from "./server/slot-allowlist.mjs";

function readDotEnv(cwd: string) {
  const env: Record<string, string> = {};
  try {
    for (const line of readFileSync(`${cwd}/.env`, "utf8").split(/\r?\n/)) {
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
      env[key] = value;
    }
  } catch {
    // .env is optional
  }
  return env;
}

const partnerRoutes: Record<string, string> = {
  "/api/slot/balance": "/functions/v1/slot-balance",
  "/api/slot/change-balance": "/functions/v1/slot-change-balance",
};

function slotPartnerProxy(env: Record<string, string>): Plugin {
  const supabaseUrl = env.VITE_SUPABASE_URL;
  const anonKey = env.VITE_SUPABASE_ANON_KEY;
  const fileEnv = readDotEnv(process.cwd());
  const gatewaySecret =
    fileEnv.GATEWAY_SECRET ||
    env.GATEWAY_SECRET ||
    process.env.GATEWAY_SECRET ||
    "";
  const gatewayUrl =
    fileEnv.GATEWAY_URL ||
    env.GATEWAY_URL ||
    process.env.GATEWAY_URL ||
    "http://69.169.109.91:3001/";

  return {
    name: "slot-partner-proxy",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path = req.url?.split("?")[0] ?? "";

        if (path === "/api/game-login") {
          if (req.method === "OPTIONS") {
            res.statusCode = 204;
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
            res.setHeader(
              "Access-Control-Allow-Headers",
              "content-type, authorization",
            );
            res.end();
            return;
          }

          try {
            const raw = await readBody(req);
            let payload: { gameId?: number; roomId?: number } = {};
            try {
              payload = JSON.parse(raw.toString("utf8") || "{}");
            } catch {
              payload = {};
            }

            const result = await handleGameLogin({
              authHeader: req.headers.authorization,
              supabaseUrl,
              anonKey,
              gameId: Number(payload.gameId ?? 23),
              roomId: Number(payload.roomId ?? 1),
              lobbyUrl: env.LOBBY_URL,
              domain: env.GAME_PROVIDER_DOMAIN,
              gatewayUrl,
              gatewaySecret,
            });

            res.statusCode = result.status;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(result.body));
          } catch (error) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                error: error instanceof Error ? error.message : "Game login failed",
              }),
            );
          }
          return;
        }

        const functionPath = partnerRoutes[path];
        if (!functionPath || !supabaseUrl || !anonKey) {
          next();
          return;
        }

        if (req.method === "OPTIONS") {
          res.statusCode = 204;
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
          res.setHeader("Access-Control-Allow-Headers", "content-type");
          res.end();
          return;
        }

        if (!isAllowedSlotCaller(req)) {
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ code: 0 }));
          return;
        }

        try {
          const body = await readBody(req);
          const forwarded = await fetch(`${supabaseUrl}${functionPath}`, {
            method: req.method ?? "POST",
            headers: {
              "Content-Type":
                req.headers["content-type"] ?? "application/x-www-form-urlencoded",
              Authorization: `Bearer ${anonKey}`,
              apikey: anonKey,
            },
            body:
              req.method === "GET" || req.method === "HEAD" ? undefined : body,
          });

          res.statusCode = forwarded.status;
          res.setHeader(
            "Content-Type",
            forwarded.headers.get("Content-Type") ?? "application/json",
          );
          res.end(Buffer.from(await forwarded.arrayBuffer()));
        } catch (error) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              code: 0,
              msg: error instanceof Error ? error.message : "Proxy failed",
            }),
          );
        }
      });
    },
  };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export default defineConfig(({ mode }) => {
  const fileEnv = readDotEnv(process.cwd());
  const env = { ...loadEnv(mode, process.cwd(), ""), ...fileEnv };
  process.env.LOBBY_URL = env.LOBBY_URL ?? process.env.LOBBY_URL;
  process.env.GAME_PROVIDER_DOMAIN =
    env.GAME_PROVIDER_DOMAIN ?? process.env.GAME_PROVIDER_DOMAIN;
  process.env.GATEWAY_URL = env.GATEWAY_URL ?? process.env.GATEWAY_URL;
  process.env.GATEWAY_SECRET = env.GATEWAY_SECRET ?? process.env.GATEWAY_SECRET;
  return {
    plugins: [react(), slotPartnerProxy(env)],
  };
});
