import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Readable, PassThrough } from "node:stream";
import { after, before, mock, test } from "node:test";
import { MAX_BODY_BYTES, readRequestBody, readJsonBody } from "../server/request-body.mjs";
import { callSkmApi, listProviderGames, verifySkmRequest } from "../server/skm-api.mjs";

let callbacks = 0;
let callbackRaw;
let sessionLookups = 0;
mock.module("../server/skm-wallet.mjs", { namedExports: {
  processSkmWalletCallback: async (_route, _payload, rawBody) => { callbacks++; callbackRaw = rawBody; return { status: "OK" }; },
  createSkmGameSession: async () => ({ player_id: "local-player", player_name: "Local player", token: "local-only-token" }),
} });
mock.module("../server/auth.mjs", { namedExports: {
  currentSession: async () => { sessionLookups++; return { user: { id: "local-player" } }; },
} });
const { handleSkmWallet } = await import("../api/_skm-wallet.js");
const { validGameLaunchUrl } = await import("../server/game-login.mjs");
const { default: gameLogin } = await import("../api/game-login.js");
const env = { gameapibaseurl: "https://provider.example/api/v1", operatorcode: "local-audit", gameproviderkey: "local-only-test-key", GATEWAY_URL: "https://gateway.example", GATEWAY_SECRET: "local-gateway-key", GATEWAY_REQUIRE_HTTPS: "false" };
const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
before(() => Object.assign(process.env, env));
after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });

function request(body, headers = {}, method = "POST") {
  const req = Readable.from(body === undefined ? [] : [body]);
  req.method = method;
  req.headers = headers;
  return req;
}
function response() {
  return { headers: {}, setHeader(name, value) { this.headers[name.toLowerCase()] = value; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, end(body) { this.body = body ? JSON.parse(String(body)) : undefined; return this; } };
}
function signedHeaders(rawBody, timestamp = String(Math.floor(Date.now() / 1000))) {
  return { "x-operator-code": env.operatorcode, "x-timestamp": timestamp, "x-signature": createHmac("sha256", env.gameproviderkey).update(Buffer.concat([Buffer.from(`${timestamp}.`), rawBody])).digest("hex") };
}

test("body limits apply to streamed, declared, parsed and pre-buffered bodies", async () => {
  assert.equal((await readRequestBody(request(Buffer.alloc(MAX_BODY_BYTES)))).length, MAX_BODY_BYTES);
  for (const req of [request(Buffer.alloc(MAX_BODY_BYTES + 1)), request(undefined, { "content-length": String(MAX_BODY_BYTES + 1) }), { body: { padding: "x".repeat(MAX_BODY_BYTES) } }]) {
    await assert.rejects(readRequestBody(req), { status: 413 });
  }
  for (const supplied of [undefined, Buffer.alloc(MAX_BODY_BYTES + 1)]) {
    const res = response();
    await handleSkmWallet(request(Buffer.alloc(MAX_BODY_BYTES + 1)), res, "debit", supplied);
    assert.equal(res.statusCode, 413);
    assert.equal(res.headers.connection, "close");
  }
  assert.equal(callbacks, 0);
});

test("incomplete request bodies expire and invalid JSON is rejected", async () => {
  const stalled = new PassThrough();
  stalled.headers = {};
  await assert.rejects(readRequestBody(stalled, { timeoutMs: 15 }), { status: 408 });
  stalled.destroy();
  for (const value of ["{", "null", "[]"]) await assert.rejects(readJsonBody(request(value)), { status: 400 });
});

test("callbacks reject modified bytes, missing signatures and stale timestamps before wallet access", async () => {
  const raw = Buffer.from('{"currency":"MMK"}');
  assert.equal(verifySkmRequest({ headers: signedHeaders(raw), rawBody: raw }).ok, true);
  assert.equal(verifySkmRequest({ headers: signedHeaders(raw), rawBody: Buffer.from(raw + " ") }).ok, false);
  assert.equal(verifySkmRequest({ headers: signedHeaders(raw, "1"), rawBody: raw }).reason, "EXPIRED_REQUEST");
  const res = response();
  await handleSkmWallet(request(raw), res, "credit");
  assert.equal(res.statusCode, 401);
  assert.equal(callbacks, 0);
});

test("signed callbacks never invoke a lazy body getter and preserve whitespace and key order", async () => {
  for (const text of ['{\n  "currency": "MMK", "amount": 100\n}\n', '{"2":2,"1":1,"currency":"MMK"}']) {
    const raw = Buffer.from(text);
    const req = request(raw, signedHeaders(raw));
    Object.defineProperty(req, "body", { get() { throw new Error("Lazy body getter must never be invoked"); } });
    const res = response();
    await handleSkmWallet(req, res, "debit");
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, "OK");
    assert.deepEqual(callbackRaw, raw);
  }
});

test("raw callbacks ignore an already-parsed object and JSON readers accept read-only lazy properties", async () => {
  const raw = Buffer.from('{ "currency": "MMK" }');
  const req = request(raw, signedHeaders(raw));
  req.body = { currency: "MMK" };
  const res = response();
  await handleSkmWallet(req, res, "balance");
  assert.equal(res.statusCode, 200);
  assert.deepEqual(callbackRaw, raw);
  const jsonReq = request('{ "value": 1 }');
  Object.defineProperty(jsonReq, "body", { get() { throw new Error("Read-only lazy getter must remain untouched"); } });
  assert.deepEqual(await readJsonBody(jsonReq), { value: 1 });
});

test("gateway TLS migration can be enforced without silently disabling legacy HTTP", async (t) => {
  let outbound;
  t.mock.method(globalThis, "fetch", async (url, options) => { outbound = { url, options }; return new Response('{"games":[]}'); });
  process.env.GATEWAY_URL = "http://gateway.example:3001/";
  process.env.GATEWAY_REQUIRE_HTTPS = "false";
  t.after(() => Object.assign(process.env, { GATEWAY_URL: env.GATEWAY_URL, GATEWAY_REQUIRE_HTTPS: env.GATEWAY_REQUIRE_HTTPS }));
  await callSkmApi("games");
  assert.equal(outbound.url, "http://gateway.example:3001/proxy");
  assert.equal(outbound.options.redirect, "error");
  process.env.GATEWAY_REQUIRE_HTTPS = "true";
  await assert.rejects(callSkmApi("games"), { code: "CONFIG_INVALID" });
  process.env.GATEWAY_URL = "https://gateway.example/";
  await callSkmApi("games");
});

test("gateway credentials in URLs and oversized upstream responses fail closed", async (t) => {
  t.after(() => { process.env.GATEWAY_URL = env.GATEWAY_URL; });
  process.env.GATEWAY_URL = "https://user:password@gateway.example/";
  await assert.rejects(callSkmApi("games"), { code: "CONFIG_INVALID" });
  process.env.GATEWAY_URL = env.GATEWAY_URL;
  t.mock.method(globalThis, "fetch", async () => new Response("x".repeat(MAX_BODY_BYTES + 1)));
  await assert.rejects(callSkmApi("games"), { code: "INVALID_RESPONSE" });
});

test("launch URL parsing rejects malformed HTTPS and embedded credentials", () => {
  for (const value of ["https://", "https://user:password@game.example/", "javascript:alert(1)", "http://game.example/", "https://game.example/\n"]) assert.equal(validGameLaunchUrl(value), false, value);
  assert.equal(validGameLaunchUrl("https://game.example/play?code=single-use"), true);
});

test("game launch requires trusted browser origin before checking a session", async () => {
  const beforeLookups = sessionLookups;
  const res = response();
  await gameLogin(request('{"game_code":"shankoemee"}', { origin: "https://attacker.example", "content-type": "application/json" }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(sessionLookups, beforeLookups);
  assert.equal(res.headers["cache-control"], "private, no-store");
  assert.equal(res.headers["access-control-allow-origin"], undefined);
});

test("trusted game launch uses session identity and preserves a valid provider URL", async (t) => {
  const launchUrl = "https://game.example/play?code=single-use";
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const envelope = JSON.parse(options.body);
    requests.push(envelope);
    return new Response(JSON.stringify(envelope.method === "GET" ? { games: [{ game_code: "shankoemee" }] } : { url: launchUrl }));
  });
  const res = response();
  await gameLogin(request('{"game_code":"shankoemee","userId":"attacker-selected"}', { origin: "https://www.j777ml.com", "content-type": "application/json" }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.url, launchUrl);
  assert.equal(requests.at(-1).body.player_id, "local-player");
});

test("concurrent catalogue misses share one outbound request", async (t) => {
  let release;
  let outbound = 0;
  t.mock.method(globalThis, "fetch", async () => {
    outbound++;
    await new Promise((resolve) => { release = resolve; });
    return new Response('{"games":[{"game_code":"shankoemee"}]}');
  });
  const pending = Array.from({ length: 12 }, () => listProviderGames({ refresh: true }));
  assert.equal(outbound, 1);
  release();
  for (const games of await Promise.all(pending)) assert.equal(games[0].game_code, "shankoemee");
});

test("catalogue failures have a short outbound retry backoff", async (t) => {
  let outbound = 0;
  t.mock.method(globalThis, "fetch", async () => { outbound++; throw new Error("Local test outage"); });
  await assert.rejects(listProviderGames({ refresh: true }), /Local test outage/);
  await assert.rejects(listProviderGames({ refresh: true }), /Local test outage/);
  assert.equal(outbound, 1);
});
