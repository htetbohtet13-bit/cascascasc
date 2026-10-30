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
const moneyExports = {};
runInNewContext(ts.transpileModule(await readFile(new URL("../src/lib/format-money.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: moneyExports });

function findElement(tree, predicate) {
  if (!tree || typeof tree !== "object") return null;
  if (Array.isArray(tree)) {
    for (const child of tree) { const found = findElement(child, predicate); if (found) return found; }
    return null;
  }
  if (predicate(tree)) return tree;
  return findElement(tree.props?.children, predicate);
}

function componentHarness(fetchResult, { authenticated = false } = {}) {
  const states = [];
  const calls = [];
  let cursor = 0;
  let initialEffect;
  let cleanup;
  let initialGet = true;
  const existingData = { summary: { users: 7 }, users: [{ id: "existing-player", phone: "+959123456789", balance: 1000 }] };
  const react = {
    Fragment: Symbol("Fragment"),
    useEffect(effect) { initialEffect = effect; },
    useRef(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = { current: initial };
      return states[index];
    },
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
      if (name === "./lib/format-money") return moneyExports;
      throw new Error(`Unexpected component import: ${name}`);
    },
    fetch: async (...args) => {
      calls.push(args);
      if (authenticated && initialGet && !args[1]?.method) {
        initialGet = false;
        return { ok: true, status: 200, json: async () => existingData };
      }
      return fetchResult(...args);
    },
    URLSearchParams,
    window: { setTimeout(callback) { callback(); return 1; }, clearTimeout() {} },
  });
  function render() { cursor = 0; return exports.default(); }
  render();
  return { render, states, existingData, calls, async load() {
    cleanup?.();
    cleanup = initialEffect();
    await new Promise(setImmediate);
  } };
}

function overviewView(app) {
  const overview = findElement(app.render(), (node) => typeof node.type === "function" && node.type.name === "Overview");
  assert.ok(overview);
  return overview.type(overview.props);
}
function treeText(tree) {
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  if (Array.isArray(tree)) return tree.map(treeText).join("");
  return tree && typeof tree === "object" ? treeText(tree.props?.children) : "";
}
function rangeButton(app, label) {
  return findElement(overviewView(app), (node) => node.type === "button" && treeText(node) === label);
}

test("overview replaces the intro with five range controls and sends the selected range to the protected API", async () => {
  const app = componentHarness((url) => ({ ok: true, status: 200, json: async () => ({ summary: { deposit_total: 5000, withdrawal_total: 1000, net_cash_flow: 4000, new_users: 3 } }) }), { authenticated: true });
  await app.load();
  const view = overviewView(app);
  assert.ok(!treeText(view).includes("Casino activity at a glance"));
  assert.ok(!treeText(view).includes("BUSINESS OVERVIEW"));
  for (const label of ["Today", "Yesterday", "This week", "This month", "All"]) assert.ok(rangeButton(app, label));
  assert.equal(rangeButton(app, "Today").props["aria-pressed"], true);
  assert.equal(new URL(app.calls[0][0], "https://example.invalid").searchParams.get("range"), "today");
  rangeButton(app, "Yesterday").props.onClick();
  assert.equal(findElement(overviewView(app), (node) => node.props?.className === "admin-period-summary").props["aria-busy"], true);
  await app.load();
  assert.equal(new URL(app.calls.at(-1)[0], "https://example.invalid").searchParams.get("range"), "yesterday");
  assert.equal(rangeButton(app, "Yesterday").props["aria-pressed"], true);
  assert.ok(treeText(overviewView(app)).includes("Yesterday summary"));
  assert.ok(treeText(overviewView(app)).includes("5,000 Ks"));
  assert.ok(treeText(overviewView(app)).includes("+4,000 Ks"));
});

test("a slow previous date-range response cannot overwrite the most recently selected range", async () => {
  const pending = new Map();
  const app = componentHarness((url) => new Promise((resolve) => pending.set(new URL(url, "https://example.invalid").searchParams.get("range"), resolve)), { authenticated: true });
  await app.load();
  rangeButton(app, "Yesterday").props.onClick(); app.render(); await app.load();
  rangeButton(app, "This week").props.onClick(); app.render(); await app.load();
  const week = { summary: { deposit_total: 7000 } };
  pending.get("week")({ ok: true, status: 200, json: async () => week });
  await new Promise(setImmediate);
  const yesterday = { summary: { deposit_total: 999999 } };
  pending.get("yesterday")({ ok: true, status: 200, json: async () => yesterday });
  await new Promise(setImmediate);
  assert.ok(app.states.includes(week)); assert.ok(!app.states.includes(yesterday));
  assert.ok(treeText(overviewView(app)).includes("7,000 Ks"));
  assert.equal(rangeButton(app, "This week").props["aria-pressed"], true);
});

test("admin logout retains records and displays an error when revocation returns HTTP 503", async () => {
  const app = componentHarness(() => ({ ok: false, status: 503 }), { authenticated: true });
  await app.load();
  const logoutButton = findElement(app.render(), (node) => node.props?.className === "admin-logout");
  assert.ok(logoutButton);
  logoutButton.props.onClick();
  await new Promise(setImmediate);
  const rendered = app.render();
  assert.ok(app.states.includes(app.existingData));
  assert.ok(findElement(rendered, (node) => node.props?.className === "admin-logout"));
  assert.equal(findElement(rendered, (node) => node.props?.className === "admin-error").props.children, "Could not confirm sign-out. Please try again.");
  const logoutCall = app.calls.find((call) => call[1]?.method === "POST");
  assert.equal(logoutCall[0], "/api/admin");
  assert.equal(logoutCall[1].method, "POST");
  assert.equal(logoutCall[1].credentials, "include");
});

test("admin logout retains current state when the network fails", async () => {
  const app = componentHarness(() => { throw new Error("Connection was interrupted"); }, { authenticated: true });
  await app.load();
  findElement(app.render(), (node) => node.props?.className === "admin-logout").props.onClick();
  await new Promise(setImmediate);
  const rendered = app.render();
  assert.ok(app.states.includes(app.existingData));
  assert.ok(findElement(rendered, (node) => node.props?.className === "admin-logout"));
  assert.ok(findElement(rendered, (node) => node.props?.className === "admin-error"));
});

test("admin logout clears records and shows the sign-in gate after confirmed revocation", async () => {
  const app = componentHarness(() => ({ ok: true, status: 200 }), { authenticated: true });
  await app.load();
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
  let signedIn = false;
  const app = componentHarness((_url, options) => {
    if (options?.method === "POST") {
      signedIn = true;
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return signedIn
      ? { ok: true, status: 200, json: async () => ({ summary: { users: 7 } }) }
      : { ok: false, status: 401, json: async () => ({ error: "Sign in", mfaRequired: true }) };
  });
  await app.load();
  findElement(app.render(), (node) => node.props?.id === "admin-secret").props.onChange({ target: { value: "private-password" } });
  findElement(app.render(), (node) => node.props?.id === "admin-otp").props.onChange({ target: { value: "005924" } });
  findElement(app.render(), (node) => node.type === "form").props.onSubmit({ preventDefault() {} });
  await new Promise(setImmediate);
  assert.ok(!app.states.includes("private-password"));
  assert.ok(!app.states.includes("005924"));
  // Successful POST alone must not briefly reveal the dashboard.
  assert.equal(findElement(app.render(), (node) => node.props?.className === "admin-shell"), null);
  assert.ok(findElement(app.render(), (node) => node.props?.role === "status"));
  await app.load();
  assert.ok(findElement(app.render(), (node) => node.props?.className === "admin-shell"));
});

test("admin dashboard never mounts before the first effect or while an unauthenticated check is pending", async () => {
  let finish;
  const app = componentHarness(() => new Promise((resolve) => { finish = resolve; }));
  assert.equal(app.calls.length, 0);
  assert.equal(findElement(app.render(), (node) => node.props?.className === "admin-shell"), null);
  assert.ok(findElement(app.render(), (node) => node.props?.role === "status"));
  await app.load();
  assert.equal(app.calls.length, 1);
  assert.equal(findElement(app.render(), (node) => node.props?.className === "admin-shell"), null);
  finish({ ok: false, status: 401, json: async () => ({ error: "Sign in", mfaRequired: true }) });
  await new Promise(setImmediate);
  assert.equal(findElement(app.render(), (node) => node.props?.className === "admin-shell"), null);
  assert.ok(findElement(app.render(), (node) => node.props?.id === "admin-secret"));
});

test("a valid existing session shows the dashboard only after its protected request succeeds", async () => {
  let finish;
  const app = componentHarness(() => new Promise((resolve) => { finish = resolve; }));
  await app.load();
  assert.equal(findElement(app.render(), (node) => node.props?.className === "admin-shell"), null);
  finish({ ok: true, status: 200, json: async () => app.existingData });
  await new Promise(setImmediate);
  assert.ok(findElement(app.render(), (node) => node.props?.className === "admin-shell"));
  assert.ok(app.states.includes(app.existingData));
});

test("failed initial checks never reveal the dashboard, including unavailable, forbidden and malformed responses", async () => {
  for (const result of [
    () => { throw new Error("Network unavailable"); },
    () => ({ ok: false, status: 503, json: async () => ({ error: "Unavailable" }) }),
    () => ({ ok: false, status: 403, json: async () => ({ error: "Forbidden" }) }),
    () => ({ ok: false, status: 500, json: async () => ({ error: "Internal failure" }) }),
    () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Invalid JSON"); } }),
    () => ({ ok: true, status: 200, json: async () => null }),
  ]) {
    const app = componentHarness(result);
    await app.load();
    assert.equal(findElement(app.render(), (node) => node.props?.className === "admin-shell"), null);
    assert.equal(findElement(app.render(), (node) => node.props?.className === "admin-brand"), null);
    assert.ok(findElement(app.render(), (node) => node.props?.className === "admin-gate"));
  }
});

test("an unavailable initial check can be retried without flashing the dashboard", async () => {
  let recovered = false;
  const app = componentHarness(() => {
    if (!recovered) throw new Error("Network unavailable");
    return { ok: true, status: 200, json: async () => ({ summary: { users: 7 } }) };
  });
  await app.load();
  const retry = findElement(app.render(), (node) => node.props?.className === "admin-gate-button");
  assert.ok(retry);
  recovered = true;
  retry.props.onClick();
  assert.equal(findElement(app.render(), (node) => node.props?.className === "admin-shell"), null);
  await app.load();
  assert.ok(findElement(app.render(), (node) => node.props?.className === "admin-shell"));
});

test("a stale dashboard response arriving after logout cannot restore records or authenticated UI", async () => {
  let finishRefresh;
  const app = componentHarness((_url, options) => options?.method === "POST"
    ? { ok: true, status: 200 }
    : new Promise((resolve) => { finishRefresh = resolve; }), { authenticated: true });
  await app.load();
  assert.ok(findElement(app.render(), (node) => node.props?.className === "admin-shell"));
  await app.load();
  findElement(app.render(), (node) => node.props?.className === "admin-logout").props.onClick();
  await new Promise(setImmediate);
  finishRefresh({ ok: true, status: 200, json: async () => app.existingData });
  await new Promise(setImmediate);
  assert.ok(!app.states.includes(app.existingData));
  assert.equal(findElement(app.render(), (node) => node.props?.className === "admin-shell"), null);
  assert.ok(findElement(app.render(), (node) => node.props?.id === "admin-secret"));
});
