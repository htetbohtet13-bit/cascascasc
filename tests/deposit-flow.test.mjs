import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

async function compile(path) {
  return ts.transpileModule(await readFile(new URL(path, import.meta.url), "utf8"), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
}
const walletCode = await compile("../src/lib/wallet.ts");
const depositCode = await compile("../src/DepositFlow.tsx");
const flush = () => new Promise(setImmediate);

function walletLibrary(fetch) {
  const exports = {};
  runInNewContext(walletCode, { exports, fetch, Error });
  return exports;
}
const reply = (payload, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => payload });

test("a lost connection or Cloudflare HTML response is unconfirmed and is never automatically retried", async () => {
  for (const outcome of [
    () => { throw new Error("Connection lost after send"); },
    () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError("HTML is not JSON"); } }),
    () => reply({ error: "Wallet request failed", code: "DEPOSIT_CREDIT_FAILED" }, 500),
    () => reply({ error: "The payment service returned an incomplete verification result" }, 502),
    () => reply(null),
  ]) {
    let calls = 0;
    const api = walletLibrary(async () => { calls++; return outcome(); });
    await assert.rejects(() => api.submitDeposit("kbzpay", 1000, "456789"), api.DepositVerificationPendingError);
    assert.equal(calls, 1);
  }
});

test("only an explicit successful result with a safe numeric balance is displayed as a credited deposit", async () => {
  for (const invalid of [{}, { ok: false, balance: 1000 }, { ok: true, balance: "1000" }, { ok: true, balance: -1 }, { ok: true, balance: Number.MAX_SAFE_INTEGER + 1 }]) {
    const api = walletLibrary(async () => reply(invalid));
    await assert.rejects(() => api.submitDeposit("kbzpay", 1000, "456789"), api.DepositVerificationPendingError);
  }
  let sent;
  const api = walletLibrary(async (url, options) => { sent = { url, options }; return reply({ ok: true, balance: 1500 }); });
  const result = await api.submitDeposit("wavepay", 1000, "000123");
  assert.equal(result.balance, 1500);
  assert.equal(sent.url, "/api/wallet/deposit");
  assert.equal(sent.options.credentials, "include");
  assert.deepEqual(JSON.parse(sent.options.body), { service_type: "wavepay", amount: 1000, transaction_id: "000123" });
});

test("known rejected verification replies retain a Burmese error rather than claiming a credit", async () => {
  const api = walletLibrary(async () => reply({ error: "Payment not found. Check the transaction digits and try again.", code: "PAYMENT_NOT_FOUND" }, 400));
  await assert.rejects(() => api.submitDeposit("kbzpay", 1000, "456789"), (error) => {
    assert.ok(!(error instanceof api.DepositVerificationPendingError));
    assert.match(error.message, /[\u1000-\u109f]/);
    return true;
  });
});

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

function componentHarness(depositReply) {
  const states = [];
  const effects = [];
  const timers = new Map();
  const calls = [];
  const balances = [];
  let cursor = 0;
  let effectCursor = 0;
  let timerId = 0;
  let closes = 0;
  let histories = 0;
  const schedule = (callback, deps) => {
    const index = effectCursor++;
    const previous = effects[index];
    if (!previous || deps.some((value, offset) => !Object.is(value, previous.deps[offset]))) {
      effects[index] = { callback, deps: [...deps], changed: true, cleanup: previous?.cleanup };
    }
  };
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
    useEffect: schedule, useLayoutEffect: schedule,
  };
  const api = walletLibrary(async (url, options) => {
    calls.push({ url, options });
    if (url === "/api/wallet/config") return reply({ kbzpay: { receiver: "09900000000", name: "Test receiver" }, wavepay: { receiver: "09900000001", name: "Test receiver" } });
    assert.equal(url, "/api/wallet/deposit");
    return depositReply();
  });
  const exports = {};
  const jsx = (type, props) => ({ type, props });
  const addTimer = (callback, delay, repeat = false) => { const id = ++timerId; timers.set(id, { callback, delay, repeat }); return id; };
  runInNewContext(depositCode, {
    exports, Error,
    window: { setTimeout: (fn, delay) => addTimer(fn, delay), clearTimeout: (id) => timers.delete(id),
      setInterval: (fn, delay) => addTimer(fn, delay, true), clearInterval: (id) => timers.delete(id) },
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "./lib/wallet") return api;
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  const props = { embedded: true, onClose: () => { closes++; }, onBalance: (balance) => balances.push(balance), onHistory: () => { histories++; }, onFullscreenChange() {} };
  const render = () => { cursor = 0; effectCursor = 0; return exports.default(props); };
  const settle = async () => {
    for (let pass = 0; pass < 3; pass++) {
      render();
      for (const effect of effects) {
        if (!effect.changed) continue;
        effect.changed = false; effect.cleanup?.(); effect.cleanup = effect.callback();
      }
      await flush();
    }
  };
  const fire = (delay) => {
    const timer = [...timers].find(([, value]) => value.delay === delay && !value.repeat);
    assert.ok(timer, `Missing timer ${delay}`);
    timers.delete(timer[0]); timer[1].callback();
  };
  const button = (label) => find(render(), (node) => node.type === "button" && text(node) === label);
  render();
  return { render, settle, button, balances, timers, calls, closes: () => closes, histories: () => histories,
    async toReceipt() {
      await settle();
      find(render(), (node) => node.type === "button" && node.props.className === "deposit-bank-card kbz").props.onClick();
      find(render(), (node) => node.type === "input" && node.props["aria-label"] === "ငွေပမာဏ").props.onChange({ target: { value: "1000" } });
      button("ရှေ့ဆက်မည်").props.onClick();
      await settle(); fire(2200); await settle();
      find(render(), (node) => node.type === "input" && node.props["aria-label"] === "ပြေစာနောက်ဆုံး 6 လုံး").props.onChange({ target: { value: "456789" } });
      await settle();
    },
  };
}

test("an interrupted deposit stays on an unconfirmed screen with history access, no auto-close and no false balance update", async () => {
  const app = componentHarness(() => ({ ok: false, status: 502, json: async () => { throw new SyntaxError("Cloudflare HTML"); } }));
  await app.toReceipt();
  app.button("အတည်ပြုမည်").props.onClick();
  await app.settle();
  assert.ok(text(app.render()).includes("ငွေသွင်းမှုကို စစ်ဆေးရန် လိုအပ်ပါသည်"));
  assert.ok(!text(app.render()).includes("စစ်ဆေးမရပါ"));
  assert.deepEqual(app.balances, []);
  assert.equal(app.closes(), 0);
  assert.ok(![...app.timers.values()].some((timer) => !timer.repeat && timer.delay === 1000));
  app.button("မှတ်တမ်းကြည့်မည်").props.onClick();
  assert.equal(app.histories(), 1);
  assert.equal(app.calls.filter((call) => call.url === "/api/wallet/deposit").length, 1);
});

test("rapid deposit confirmations invoke verification only once", async () => {
  let finish;
  const app = componentHarness(() => new Promise((resolve) => { finish = resolve; }));
  await app.toReceipt();
  const confirm = app.button("အတည်ပြုမည်").props.onClick;
  confirm(); confirm();
  await app.settle();
  assert.equal(app.calls.filter((call) => call.url === "/api/wallet/deposit").length, 1);
  finish(reply({ ok: true, balance: 1000 }));
  await app.settle();
  assert.deepEqual(app.balances, [1000]);
  assert.ok(text(app.render()).includes("ငွေသွင်းအောင်မြင်"));
});
