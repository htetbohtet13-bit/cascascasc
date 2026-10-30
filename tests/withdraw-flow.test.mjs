import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

async function compile(path) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  return ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
}
const componentCode = await compile("../src/Wallet.tsx");
const walletCode = await compile("../src/lib/wallet.ts");
const resultCode = await compile("../src/PaymentResult.tsx");

function find(tree, predicate) {
  if (!tree || typeof tree !== "object") return null;
  if (Array.isArray(tree)) {
    for (const child of tree) { const found = find(child, predicate); if (found) return found; }
    return null;
  }
  return predicate(tree) ? tree : find(tree.props?.children, predicate);
}
function text(tree) {
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  if (Array.isArray(tree)) return tree.map(text).join("");
  return tree && typeof tree === "object" ? text(tree.props?.children) : "";
}
const response = (payload, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => payload });
const flush = () => new Promise(setImmediate);

function harness(payout = () => response({ ok: true, state: "paid", balance: 94000, message: "Transfer Successful" }), overrides = {}) {
  const states = [];
  const calls = [];
  const balances = [];
  const effects = [];
  let cursor = 0;
  let generatedIds = 0;
  let closed = 0;
  const props = { embedded: true, balance: 99000, defaultPhone: "+959123456789", onClose: () => { closed++; }, onBalance: (value) => balances.push(value), ...overrides };
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
      return [states[index], (next) => { states[index] = typeof next === "function" ? next(states[index]) : next; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = { current: initial };
      return states[index];
    },
    useEffect(callback) { if (!effects.length) effects.push(callback); },
    useLayoutEffect(callback) { callback(); },
  };
  const api = {};
  runInNewContext(walletCode, { exports: api, fetch: async (url, options) => {
    calls.push({ url, options });
    if (url === "/api/wallet/config") return response({ kbzpay: { receiver: "09900000000" }, wavepay: { receiver: "09900000001" } });
    assert.equal(url, "/api/wallet/withdraw");
    return payout(url, options);
  } });
  const exports = {};
  const jsx = (type, properties) => typeof type === "function" ? type(properties) : ({ type, props: properties });
  const resultExports = {};
  runInNewContext(resultCode, { exports: resultExports, require: () => ({ jsx, jsxs: jsx }) });
  const forbiddenStorage = new Proxy({}, { get() { throw new Error("Withdrawal fields must not use persistent storage"); } });
  runInNewContext(componentCode, {
    exports, localStorage: forbiddenStorage, sessionStorage: forbiddenStorage,
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++generatedIds).padStart(12, "0")}` },
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "./lib/wallet") return api;
      if (name === "./PaymentResult") return resultExports;
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  const render = () => { cursor = 0; return exports.default(props); };
  const element = (predicate) => find(render(), predicate);
  const field = (id) => element((node) => node.props?.id === id);
  const input = (id, value) => { assert.ok(field(id), `Missing field ${id}`); field(id).props.onChange({ target: { value } }); };
  const button = (label) => element((node) => node.type === "button" && text(node) === label);
  const submit = async () => {
    const form = element((node) => node.type === "form");
    assert.ok(form, "A form must be visible");
    form.props.onSubmit({ preventDefault() {} });
    await flush();
  };
  const choose = (method) => element((node) => node.type === "button" && node.props.className?.split(" ").includes(method)).props.onClick();
  const toAccount = async (method = "kbz", amount = "5000") => { choose(method); input("withdraw-amount", amount); await submit(); };
  const toPreview = async (name = "Display name only", phone = "09123456789") => {
    await toAccount(); input("withdraw-name", name); input("withdraw-phone", phone); await submit();
  };
  render();
  return { render, props, input, field, button, choose, submit, toAccount, toPreview, calls, balances,
    payoutCalls: () => calls.filter((call) => call.url === "/api/wallet/withdraw"), closed: () => closed,
    async load() { effects[0](); await flush(); } };
}

test("withdrawal starts with balance, banks and amount; neither Next step sends a payout", async () => {
  const app = harness();
  await app.load();
  assert.ok(text(app.render()).includes("99,000"));
  assert.ok(app.field("withdraw-amount"));
  assert.equal(app.field("withdraw-name"), null);
  assert.equal(app.field("withdraw-phone"), null);
  await app.toAccount();
  assert.equal(app.field("withdraw-amount"), null);
  assert.ok(app.field("withdraw-name"));
  assert.equal(app.field("withdraw-phone").props.value, "09123456789");
  assert.equal(app.field("withdraw-name").props.autoComplete, "off");
  assert.equal(app.payoutCalls().length, 0);
  app.input("withdraw-name", "မောင်မောင်");
  await app.submit();
  assert.equal(app.field("withdraw-name"), null);
  assert.ok(text(app.render()).includes("မောင်မောင်"));
  assert.ok(text(app.render()).includes("09123456789"));
  assert.ok(text(app.render()).includes("5,000"));
  assert.ok(app.button("အတည်ပြုပြီး ငွေထုတ်မည်"));
  assert.equal(app.payoutCalls().length, 0);
});

test("invalid bank, amounts, empty names and invalid recipient numbers cannot advance or send money", async () => {
  const app = harness();
  app.input("withdraw-amount", "5000");
  await app.submit();
  assert.ok(app.field("withdraw-amount"));
  app.choose("kbz");
  for (const amount of ["", "0", "1000001", "100000"]) {
    app.input("withdraw-amount", amount); await app.submit();
    assert.ok(app.field("withdraw-amount"));
    assert.equal(app.payoutCalls().length, 0);
  }
  app.input("withdraw-amount", "5000"); await app.submit();
  app.input("withdraw-name", "   "); await app.submit();
  assert.ok(app.field("withdraw-name"));
  app.input("withdraw-name", "မောင်မောင်");
  for (const phone of ["", "0912", "08123456789", "0912345678901"]) {
    app.input("withdraw-phone", phone); await app.submit();
    assert.ok(app.field("withdraw-phone"));
    assert.equal(app.field("withdraw-phone").props.value, phone);
    assert.equal(app.payoutCalls().length, 0);
  }
});

test("editing a preview preserves fields and only the latest bank, amount and phone reach the real request builder", async () => {
  const app = harness();
  await app.toPreview();
  app.button("ပြင်မည်").props.onClick();
  assert.equal(app.field("withdraw-name").props.value, "Display name only");
  assert.equal(app.field("withdraw-phone").props.value, "09123456789");
  app.input("withdraw-name", "Private display-only name");
  app.input("withdraw-phone", "+959876543210");
  assert.equal(app.field("withdraw-phone").props.value, "09876543210");
  app.button("ပြောင်းမည်").props.onClick();
  assert.equal(app.field("withdraw-amount").props.value, "5000");
  app.choose("wave"); app.input("withdraw-amount", "4000"); await app.submit(); await app.submit();
  assert.ok(text(app.render()).includes("WavePay"));
  assert.ok(text(app.render()).includes("Private display-only name"));
  assert.equal(app.payoutCalls().length, 0);
  await app.submit();
  const call = app.payoutCalls()[0];
  assert.equal(call.options.method, "POST");
  assert.equal(call.options.credentials, "include");
  const body = JSON.parse(call.options.body);
  assert.deepEqual(body, { service_type: "wavepay", amount: 4000, phone: "09876543210", request_id: "00000000-0000-4000-8000-000000000001" });
  assert.ok(!JSON.stringify(app.calls).includes("Private display-only name"));
  assert.deepEqual(app.balances, [94000]);
  const fresh = harness(); await fresh.toAccount();
  assert.equal(fresh.field("withdraw-name").props.value, "");
});

test("rapid repeated confirmations create one payout and pending results never offer an automatic retry", async () => {
  let finish;
  const app = harness(() => new Promise((resolve) => { finish = resolve; }));
  await app.toPreview();
  const confirm = find(app.render(), (node) => node.type === "form").props.onSubmit;
  confirm({ preventDefault() {} }); confirm({ preventDefault() {} });
  await flush();
  assert.equal(app.payoutCalls().length, 1);
  assert.equal(app.button("ပြင်မည်"), null);
  assert.equal(app.button("အတည်ပြုပြီး ငွေထုတ်မည်"), null);
  assert.ok(text(app.render()).includes("ငွေလွှဲနေပါသည်"));
  finish(response({ state: "pending", balance: 94000 }, 502));
  await flush();
  assert.equal(app.button("ပြန်လည်ကြိုးစားမည်"), null);
  assert.ok(app.button("ပြီးပါပြီ"));
  app.button("ပြီးပါပြီ").props.onClick();
  assert.equal(app.closed(), 1);
  assert.equal(app.payoutCalls().length, 1);
});

test("a confirmed unsent failure permits an explicit retry with a new request ID", async () => {
  let count = 0;
  const app = harness(() => response({ ok: ++count > 1, state: count === 1 ? "failed" : "paid", safeToRetry: count === 1, balance: count === 1 ? 99000 : 94000, message: "Result" }));
  await app.toPreview(); await app.submit();
  app.button("ပြန်လည်ကြိုးစားမည်").props.onClick();
  await app.submit(); await app.submit(); await app.submit();
  const bodies = app.payoutCalls().map((call) => JSON.parse(call.options.body));
  assert.equal(bodies.length, 2);
  assert.notEqual(bodies[0].request_id, bodies[1].request_id);
});

test("an unrecognized result stays pending and cannot offer a second payout", async () => {
  const app = harness(() => response({}));
  await app.toPreview(); await app.submit();
  assert.equal(app.button("အတည်ပြုပြီး ငွေထုတ်မည်"), null);
  assert.equal(app.button("ပြန်လည်ကြိုးစားမည်"), null);
  assert.ok(app.button("ပြီးပါပြီ"));
  assert.equal(app.payoutCalls().length, 1);
  assert.deepEqual(app.balances, []);
});

test("HTML, server errors and contradictory payout results never claim failure or refund", async () => {
  for (const payout of [
    () => ({ ok: false, status: 502, json: async () => { throw new Error("Cloudflare HTML"); } }),
    () => response({ error: "Wallet request failed" }, 500),
    () => response(null),
    () => response([]),
    () => response({ state: "unexpected", ok: true, balance: 94000, message: "unrecognized" }),
    () => response({ state: "paid", ok: false, balance: 94000, message: "contradiction" }),
    () => response({ state: "paid", ok: true, balance: "94000", message: "bad balance" }),
    () => response({ state: "paid", ok: true, balance: 94000 }, 500),
    () => response({ state: "failed", ok: false, balance: 99000, message: "not confirmed unsent" }),
    () => response({ state: "failed", ok: false, safeToRetry: true, balance: 99000 }, 500),
    () => response({ state: "pending", balance: -1 }, 502),
  ]) {
    const app = harness(payout); await app.toPreview(); await app.submit();
    const view = text(app.render());
    assert.ok(view.includes("အတည်မပြုနိုင်သေးပါ"));
    assert.ok(!view.includes("မအောင်မြင်ပါ"));
    assert.ok(!view.includes("ပြန်လည်ဖြည့်ပေးထားပါသည်"));
    assert.equal(app.button("ပြန်လည်ကြိုးစားမည်"), null);
    assert.equal(app.button("အတည်ပြုပြီး ငွေထုတ်မည်"), null);
    assert.equal(app.payoutCalls().length, 1);
    assert.deepEqual(app.balances, []);
  }
});

test("an explicit paid result shows Burmese success without depending on a gateway message", async () => {
  const app = harness(() => response({ state: "paid", ok: true, balance: 94000 }));
  await app.toPreview(); await app.submit();
  assert.ok(text(app.render()).includes("ငွေထုတ်ခြင်း အောင်မြင်ပါသည်။"));
  assert.ok(text(app.render()).includes("5,000"));
  assert.ok(text(app.render()).includes("KBZPay"));
  assert.ok(text(app.render()).includes("09123456789"));
  assert.deepEqual(app.balances, [94000]);
  assert.equal(app.button("ပြန်လည်ကြိုးစားမည်"), null);
});

test("network uncertainty remains pending and wagering rejections keep their Burmese error screen", async () => {
  const pending = harness(() => { throw new Error("Network lost after request"); });
  await pending.toPreview(); await pending.submit();
  assert.equal(pending.button("ပြန်လည်ကြိုးစားမည်"), null);
  assert.deepEqual(pending.balances, []);
  const message = "ငွေထုတ်ရန် နောက်ထပ် 400 ကျပ် လောင်းကြေးပြည့်ရန် လိုအပ်ပါသည်။";
  const wagering = harness(() => response({ error: message, code: "WAGERING_REQUIRED" }, 403));
  await wagering.toPreview(); await wagering.submit();
  assert.ok(text(wagering.render()).includes(message));
  assert.ok(wagering.button("ဂိမ်းဆက်ကစားမည်"));
  assert.deepEqual(wagering.balances, []);
});

test("a balance reduced after preview is checked again before sending the payout", async () => {
  const app = harness();
  await app.toPreview(); app.props.balance = 1000; await app.submit();
  assert.equal(app.payoutCalls().length, 0);
  assert.ok(text(app.render()).includes("လက်ကျန်ငွေ မလုံလောက်ပါ။"));
});
