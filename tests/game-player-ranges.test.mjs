import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, mock, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { parsePlayerCount, displayedPlayerCount } from "../server/player-count.mjs";
import { applyGameDisplaySettings } from "../server/game-display.mjs";

const db = new PGlite();
const pool = { async query(sql, params) { const result = await db.query(sql, params); return { rows: result.rows, rowCount: /^\s*select/i.test(sql) ? result.rows.length : result.affectedRows }; } };
const games = [{ game_code: "shankoemee", name: "Shan Koe Mee" }, { game_code: "abcd", name: "ABCD" }];
mock.module("../server/neon.mjs", { namedExports: { getPool: () => pool, withTransaction: () => { throw new Error("Unexpected transaction in catalog tests"); } } });
mock.module("../server/skm-api.mjs", { namedExports: { listProviderGames: async () => games } });
mock.module("../server/rate-limit.mjs", { namedExports: { consumeRateLimit: async () => null } });
const { handleAdminApi } = await import("../server/admin-api.mjs");
const { default: catalog } = await import("../api/games.js");
const envKeys = ["admin_secret", "ADMIN_TOTP_SECRET", "ADMIN_MFA_REQUIRED"];
const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
let cookie;
async function migration(name, connection = db) {
  await connection.exec((await readFile(new URL(`../neon/${name}`, import.meta.url), "utf8")).replace("create extension if not exists pgcrypto;", ""));
}
const admin = (body, headers = {}) => handleAdminApi({ method: "POST", url: "/api/admin", headers: { origin: "https://www.j777ml.com", "content-type": "application/json", cookie, ...headers }, body });
before(async () => {
  for (const name of ["001_app_schema.sql", "006_game_display_settings.sql", "007_game_hot_setting.sql", "009_auth_security.sql", "014_game_player_ranges.sql"]) await migration(name);
  process.env.admin_secret = "local-only-test-admin"; delete process.env.ADMIN_TOTP_SECRET; process.env.ADMIN_MFA_REQUIRED = "false";
  const login = await admin({ action: "login", password: process.env.admin_secret });
  assert.equal(login.status, 200); cookie = login.headers["Set-Cookie"].split(";", 1)[0];
});
beforeEach(async () => {
  await db.exec("truncate public.game_display_settings");
  await db.query("insert into public.game_display_settings(game_code,image_url,players_online,sort_order,is_active,is_hot) values('shankoemee','https://example.com/game.png',77,8,false,true)");
});
after(async () => { for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } await db.close(); });
const stored = async () => (await db.query("select image_url,players_online,players_online_max,sort_order,is_active,is_hot from public.game_display_settings where game_code='shankoemee'")).rows[0];
const quick = (value, extra = {}) => admin({ action: "set_game_players", game_code: "shankoemee", players_online: value, sort_order: 8, ...extra });

test("player counts accept fixed, range, equal endpoints, zero and hidden values with strict bounds", () => {
  for (const [value, expected] of [["100-500", { min: 100, max: 500 }], ["100 – 500", { min: 100, max: 500 }], [100, { min: 100, max: null }], ["100-100", { min: 100, max: null }], [0, { min: 0, max: null }], ["0-1000000000", { min: 0, max: 1000000000 }], [" ", { min: null, max: null }], [null, { min: null, max: null }]]) assert.deepEqual(parsePlayerCount(value), expected);
  for (const invalid of ["500-100", "-1", "1.5", "1-", "1-2-3", "1e5", "0-1000000001", "1000000001", true, {}, [], Infinity, NaN]) assert.equal(parsePlayerCount(invalid), null, String(invalid));
});

test("both range endpoints are included; fixed or hidden counts never call the random source", () => {
  assert.equal(displayedPlayerCount(100, 500, (min, max) => { assert.equal(min, 100); assert.equal(max, 501); return min; }), 100);
  assert.equal(displayedPlayerCount(100, 500, (_min, max) => max - 1), 500);
  const fail = () => { throw new Error("Not a random range"); };
  assert.equal(displayedPlayerCount(0, null, fail), 0); assert.equal(displayedPlayerCount(null, null, fail), null);
});

test("quick changes save only count settings and preserve artwork, visibility, hot status and order", async () => {
  const result = await quick("100-500", { image_url: "https://wrong.example", sort_order: 999, is_active: true, is_hot: false });
  assert.equal(result.status, 200); assert.equal(result.body.players_online, 100); assert.equal(result.body.players_online_max, 500);
  assert.deepEqual(await stored(), { image_url: "https://example.com/game.png", players_online: 100, players_online_max: 500, sort_order: 8, is_active: false, is_hot: true });
  await quick("42"); assert.equal((await stored()).players_online_max, null);
  await quick(""); assert.equal((await stored()).players_online, null);
});

test("new quick settings preserve the catalog's initial order", async () => {
  assert.equal((await quick("100-500", { game_code: "abcd", sort_order: 12 })).status, 200);
  assert.equal((await db.query("select sort_order from public.game_display_settings where game_code='abcd'")).rows[0].sort_order, 12);
});

test("invalid and unauthorized edits cannot change settings", async () => {
  const snapshot = await stored();
  for (const value of ["500-100", -1, "1.5", "0-1000000001", {}, true]) assert.equal((await quick(value)).status, 400);
  assert.equal((await quick("100-500", { game_code: "'; drop table profiles; --" })).status, 400);
  assert.equal((await admin({ action: "set_game_players", game_code: "shankoemee", players_online: "100-500" }, { cookie: "" })).status, 401);
  assert.equal((await admin({ action: "set_game_players", game_code: "shankoemee", players_online: "100-500" }, { origin: "https://attacker.example" })).status, 403);
  assert.deepEqual(await stored(), snapshot);
});

test("the full game editor saves ranges and clears the upper bound when switching to fixed", async () => {
  const body = { action: "save_game_settings", game_code: "shankoemee", image_url: "https://example.com/new.png", sort_order: 9, is_active: true };
  assert.equal((await admin({ ...body, players_online: "100-500" })).status, 200);
  assert.equal((await stored()).players_online_max, 500); assert.equal((await stored()).is_hot, true);
  assert.equal((await admin({ ...body, players_online: "123" })).status, 200);
  assert.equal((await stored()).players_online_max, null);
});

test("public catalog requests draw fresh values without changing stored settings; admin sees the saved range", async () => {
  await quick("100-500"); await db.exec("update public.game_display_settings set is_active=true");
  const before = await stored();
  const first = await applyGameDisplaySettings(pool, games, { randomInteger: (min) => min });
  const second = await applyGameDisplaySettings(pool, games, { randomInteger: (_min, max) => max - 1 });
  assert.equal(first.games.find((game) => game.game_code === "shankoemee").players_online, 100);
  assert.equal(second.games.find((game) => game.game_code === "shankoemee").players_online, 500);
  const adminView = await applyGameDisplaySettings(pool, games, { includeHidden: true, randomInteger: () => { throw new Error("Admin must not randomize saved values"); } });
  const saved = adminView.games.find((game) => game.game_code === "shankoemee"); assert.equal(saved.players_online, 100); assert.equal(saved.players_online_max, 500);
  assert.deepEqual(await stored(), before);
  const res = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  await catalog({ method: "GET" }, res); assert.equal(res.code, 200); assert.equal(res.headers["Cache-Control"], "no-store");
  const count = res.body.games.find((game) => game.game_code === "shankoemee").players_online;
  assert.ok(Number.isInteger(count) && count >= 100 && count <= 500);
});

test("migration reruns preserve existing values and the database rejects invalid ranges", async () => {
  await quick("100-500"); const before = await stored();
  await migration("014_game_player_ranges.sql"); await migration("014_game_player_ranges.sql"); assert.deepEqual(await stored(), before);
  for (const max of [99, 1000000001]) await assert.rejects(() => db.query("update public.game_display_settings set players_online_max=$1 where game_code='shankoemee'", [max]), (error) => error.code === "23514");
  await assert.rejects(() => db.exec("update public.game_display_settings set players_online=null where game_code='shankoemee'"), (error) => error.code === "23514");
});

test("old schemas still serve fixed counts and hot flags until the range migration is applied", async () => {
  const legacy = new PGlite();
  try {
    await migration("006_game_display_settings.sql", legacy); await migration("007_game_hot_setting.sql", legacy);
    await legacy.exec("insert into public.game_display_settings(game_code,players_online,is_hot) values('shankoemee',123,true)");
    const result = await applyGameDisplaySettings(legacy, games); assert.equal(result.settingsConfigured, true);
    assert.equal(result.games[0].players_online, 123); assert.equal(result.games[0].is_hot, true);
    await migration("014_game_player_ranges.sql", legacy);
    assert.equal((await legacy.query("select players_online from public.game_display_settings")).rows[0].players_online, 123);
  } finally { await legacy.close(); }
});

const compile = async (path) => ts.transpileModule(await readFile(new URL(path, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const countExports = {}; runInNewContext(await compile("../src/lib/player-count.ts"), { exports: countExports });
const editorCode = await compile("../src/GamePlayerCount.tsx");
function find(tree, predicate) {
  if (!tree || typeof tree !== "object") return null;
  if (Array.isArray(tree)) { for (const child of tree) { const result = find(child, predicate); if (result) return result; } return null; }
  return predicate(tree) ? tree : find(tree.props?.children, predicate);
}
function editorHarness(success = true) {
  const states = []; const calls = []; let cursor = 0; let saves = 0;
  const react = { useState(initial) { const i = cursor++; if (!(i in states)) states[i] = typeof initial === "function" ? initial() : initial; return [states[i], (value) => { states[i] = value; }]; }, useEffect() {} };
  const exports = {}; const jsx = (type, props) => ({ type, props });
  runInNewContext(editorCode, { exports, require: (name) => name === "react" ? react : name === "./lib/player-count" ? countExports : { jsx, jsxs: jsx },
    fetch: async (url, options) => { calls.push({ url, options }); return { ok: success, json: async () => success ? { ok: true, players_online: 100, players_online_max: 500 } : { error: "Invalid range" } }; } });
  const render = () => { cursor = 0; return exports.default({ code: "shankoemee", min: 77, max: null, sortOrder: 8, disabled: false, onSaved() { saves++; } }); };
  return { render, calls, saves: () => saves };
}
test("quick editor sends one count-only update and shows the returned range", async () => {
  const app = editorHarness(); app.render().props.onClick();
  find(app.render(), (node) => node.type === "input").props.onChange({ target: { value: "100-500" } });
  app.render().props.onSubmit({ preventDefault() {} }); await new Promise(setImmediate);
  assert.equal(app.calls.length, 1); assert.equal(app.saves(), 1);
  assert.deepEqual(JSON.parse(app.calls[0].options.body), { action: "set_game_players", game_code: "shankoemee", players_online: "100-500", sort_order: 8 });
  assert.equal(app.calls[0].options.credentials, "include");
  assert.ok(find(app.render(), (node) => node.type === "span" && node.props.children === "100-500"));
});
test("cancelling sends nothing and a failed save keeps the input and error visible", async () => {
  const app = editorHarness(false); app.render().props.onClick();
  app.render().props.onKeyDown({ key: "Escape", preventDefault() {} }); assert.equal(app.calls.length, 0); assert.equal(app.render().type, "button");
  app.render().props.onClick(); find(app.render(), (node) => node.type === "input").props.onChange({ target: { value: "500-100" } });
  app.render().props.onSubmit({ preventDefault() {} }); await new Promise(setImmediate);
  assert.equal(app.saves(), 0); assert.equal(find(app.render(), (node) => node.type === "input").props.value, "500-100");
  assert.ok(find(app.render(), (node) => node.props?.role === "alert"));
});
