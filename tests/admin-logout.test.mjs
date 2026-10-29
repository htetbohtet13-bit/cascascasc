import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Execute the real component and click handler with a minimal hook/JSX harness.
// This verifies state transitions without a browser or additional dependencies.
const source = await readFile(new URL("../src/AdminDashboard.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function findElement(tree, predicate) {
  if (!tree || typeof tree !== "object") return null;
  if (Array.isArray(tree)) {
    for (const child of tree) { const found = findElement(child, predicate); if (found) return found; }
    return null;
  }
  if (predicate(tree)) return tree;
  return findElement(tree.props?.children, predicate);
}

function componentHarness(fetchResult) {
  const states = [];
  const calls = [];
  let cursor = 0;
  let initialEffect;
  const react = {
    Fragment: Symbol("Fragment"),
    useEffect(effect) { initialEffect ??= effect; },
    useState(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
      return [states[index], (next) => { states[index] = typeof next === "function" ? next(states[index]) : next; }];
    },
  };
  const jsx = (type, props) => ({ type, props });
  const exports = {};
  runInNewContext(compiled, {
    exports,
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      throw new Error(`Unexpected component import: ${name}`);
    },
    fetch: async (...args) => { calls.push(args); return fetchResult(...args); },
    URLSearchParams,
    window: { setTimeout(callback) { callback(); return 1; }, clearTimeout() {} },
  });
  function render() { cursor = 0; return exports.default(); }
  render();
  // Existing loaded records must remain present if server-side revocation fails.
  const existingData = { summary: { users: 7 }, users: [{ id: "existing-player", phone: "+959123456789", balance: 1000 }] };
  const dataIndex = states.findIndex((value) => value && typeof value === "object");
  assert.ok(dataIndex >= 0);
  states[dataIndex] = existingData;
  return { render, states, existingData, calls, async load() { initialEffect(); await new Promise(setImmediate); } };
}

test("admin logout retains records and displays an error when revocation returns HTTP 503", async () => {
  const app = componentHarness(() => ({ ok: false, status: 503 }));
  const logoutButton = findElement(app.render(), (node) => node.props?.className === "admin-logout");
  assert.ok(logoutButton);
  logoutButton.props.onClick();
  await new Promise(setImmediate);
  const rendered = app.render();
  assert.ok(app.states.includes(app.existingData));
  assert.ok(findElement(rendered, (node) => node.props?.className === "admin-logout"));
  assert.equal(findElement(rendered, (node) => node.props?.className === "admin-error").props.children, "Could not confirm sign-out. Please try again.");
  assert.equal(app.calls[0][0], "/api/admin");
  assert.equal(app.calls[0][1].method, "POST");
  assert.equal(app.calls[0][1].credentials, "include");
});

test("admin logout retains current state when the network fails", async () => {
  const app = componentHarness(() => { throw new Error("Connection was interrupted"); });
  findElement(app.render(), (node) => node.props?.className === "admin-logout").props.onClick();
  await new Promise(setImmediate);
  const rendered = app.render();
  assert.ok(app.states.includes(app.existingData));
  assert.ok(findElement(rendered, (node) => node.props?.className === "admin-logout"));
  assert.ok(findElement(rendered, (node) => node.props?.className === "admin-error"));
});

test("admin logout clears records and shows the sign-in gate after confirmed revocation", async () => {
  const app = componentHarness(() => ({ ok: true, status: 200 }));
  findElement(app.render(), (node) => node.props?.className === "admin-logout").props.onClick();
  await new Promise(setImmediate);
  const rendered = app.render();
  assert.ok(!app.states.includes(app.existingData));
  assert.ok(findElement(rendered, (node) => node.props?.className === "admin-gate"));
  assert.equal(findElement(rendered, (node) => node.props?.className === "admin-logout"), null);
});

test("admin gate shows a required numeric authenticator field when the server requires MFA and submits leading zeroes intact", async () => {
  const app = componentHarness((_url, options) => options?.method === "POST"
    ? { ok: false, status: 401, json: async () => ({ error: "ကုဒ်ကို ထပ်မံစစ်ဆေးပါ။", mfaRequired: true }) }
    : { ok: false, status: 401, json: async () => ({ error: "Sign in", mfaRequired: true }) });
  await app.load();
  let tree = app.render();
  const input = findElement(tree, (node) => node.props?.id === "admin-otp");
  assert.ok(input);
  assert.equal(input.props.type, "text");
  assert.equal(input.props.inputMode, "numeric");
  assert.equal(input.props.autoComplete, "one-time-code");
  assert.equal(input.props.required, true);
  assert.equal(input.props.maxLength, 6);
  assert.ok(!app.states.includes(app.existingData));
  findElement(tree, (node) => node.props?.id === "admin-secret").props.onChange({ target: { value: "private-password" } });
  input.props.onChange({ target: { value: "005924" } });
  tree = app.render();
  findElement(tree, (node) => node.type === "form").props.onSubmit({ preventDefault() {} });
  await new Promise(setImmediate);
  const submitted = JSON.parse(app.calls.find((call) => call[1]?.method === "POST")[1].body);
  assert.equal(submitted.code, "005924");
  assert.equal(submitted.password, "private-password");
  assert.equal(findElement(app.render(), (node) => node.props?.id === "admin-otp").props.value, "");
  assert.ok(findElement(app.render(), (node) => node.props?.role === "alert"));
});

test("legacy gate stays usable during rollout and discovers MFA enabled since the page loaded", async () => {
  const app = componentHarness((_url, options) => ({
    ok: false, status: 401, json: async () => ({ error: "Sign in", mfaRequired: options?.method === "POST" }),
  }));
  await app.load();
  assert.equal(findElement(app.render(), (node) => node.props?.id === "admin-otp"), null);
  findElement(app.render(), (node) => node.props?.id === "admin-secret").props.onChange({ target: { value: "private-password" } });
  findElement(app.render(), (node) => node.type === "form").props.onSubmit({ preventDefault() {} });
  await new Promise(setImmediate);
  assert.ok(findElement(app.render(), (node) => node.props?.id === "admin-otp"));
});

test("successful admin login clears password and code from component state", async () => {
  const app = componentHarness((_url, options) => options?.method === "POST"
    ? { ok: true, status: 200, json: async () => ({ ok: true }) }
    : { ok: false, status: 401, json: async () => ({ error: "Sign in", mfaRequired: true }) });
  await app.load();
  findElement(app.render(), (node) => node.props?.id === "admin-secret").props.onChange({ target: { value: "private-password" } });
  findElement(app.render(), (node) => node.props?.id === "admin-otp").props.onChange({ target: { value: "005924" } });
  findElement(app.render(), (node) => node.type === "form").props.onSubmit({ preventDefault() {} });
  await new Promise(setImmediate);
  assert.ok(!app.states.includes("private-password"));
  assert.ok(!app.states.includes("005924"));
  assert.equal(findElement(app.render(), (node) => node.props?.className === "admin-gate"), null);
});
