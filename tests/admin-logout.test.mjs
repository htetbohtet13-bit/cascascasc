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
  const react = {
    Fragment: Symbol("Fragment"),
    useEffect() {},
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
    fetch: async (...args) => { calls.push(args); return fetchResult(); },
  });
  function render() { cursor = 0; return exports.default(); }
  render();
  // Existing loaded records must remain present if server-side revocation fails.
  const existingData = { summary: { users: 7 }, users: [{ id: "existing-player", phone: "+959123456789", balance: 1000 }] };
  const dataIndex = states.findIndex((value) => value && typeof value === "object");
  assert.ok(dataIndex >= 0);
  states[dataIndex] = existingData;
  return { render, states, existingData, calls };
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
