import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
const code = ts.transpileModule(await readFile(new URL("../src/DepositBankControls.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const banks = (kbz = true, wave = true) => ({ banks: { kbzpay: { enabled: kbz }, wavepay: { enabled: wave } } });
const reply = body => ({ ok: true, json: async () => body });
function find(node, predicate) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) { for (const child of node) { const found = find(child, predicate); if (found) return found; } return null; }
  return predicate(node) ? node : find(node.props?.children, predicate);
}
function text(node) { return typeof node === "string" ? node : Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" ? text(node.props?.children) : ""; }
function harness(fetcher) {
  const states = []; const effects = []; const calls = [];
  let cursor = 0; let effectCursor = 0;
  const react = {
    useState(initial) { const i=cursor++; if (!(i in states)) states[i]=initial; return [states[i], value => { states[i]=value; }]; },
    useRef(initial) { const i=cursor++; if (!(i in states)) states[i]={current:initial}; return states[i]; },
    useEffect(fn) { const i=effectCursor++; if (!effects[i]) effects[i]={fn, pending:true}; },
  };
  const jsx = (type, props) => ({type, props}); const exports = {};
  runInNewContext(code, { exports, Error, require: name => name === "react" ? react : {jsx,jsxs:jsx}, fetch: async (...args) => { calls.push(args); return fetcher(...args); } });
  const render = () => { cursor=0; effectCursor=0; return exports.default(); };
  const settle = async () => { for(let i=0;i<4;i++){render();for(const e of effects) if(e.pending){e.pending=false;e.fn();}await new Promise(setImmediate);} };
  return {render,settle,calls, toggle: bank => find(render(),node => node.props?.role === "switch" && node.props["aria-label"] === `${bank} top-ups`), refresh: () => find(render(),node => node.type === "button" && text(node) === "Refresh")};
}

test("bank controls read confirmed state, save an explicit value once and update only after acknowledgement", async () => {
  let finish;
  const app = harness((_url, init) => init.method === "POST" ? new Promise(resolve => { finish=resolve; }) : reply(banks()));
  await app.settle();
  assert.equal(app.calls.length, 1); assert.equal(app.toggle("KBZPay").props["aria-checked"], true);
  const toggle = app.toggle("KBZPay").props.onClick; toggle();toggle();
  await app.settle();
  assert.equal(app.calls.length,2); assert.equal(app.toggle("KBZPay").props.disabled,true);
  assert.equal(app.toggle("KBZPay").props["aria-checked"],true);
  const sent=app.calls[1][1]; assert.equal(sent.credentials,"include");
  assert.deepEqual(JSON.parse(sent.body),{action:"set_deposit_bank",service_type:"kbzpay",enabled:false});
  finish(reply(banks(false))); await app.settle();
  assert.equal(app.toggle("KBZPay").props["aria-checked"],false);
  assert.ok(app.toggle("KBZPay").props.className.includes("off"));
  assert.equal(app.toggle("WavePay").props["aria-checked"],true);
});

test("a lost save reply never invents a switch state or automatically resends; refresh reads the actual saved result", async () => {
  let reads=0;
  const app=harness((_url,init) => { if(init.method === "POST")throw new Error("Lost reply; refresh to check."); return reply(banks(reads++ === 0)); });
  await app.settle(); app.toggle("KBZPay").props.onClick(); await app.settle();
  assert.equal(app.toggle("KBZPay").props.disabled,true); assert.ok(text(app.render()).includes("Lost reply"));
  assert.equal(app.calls.filter(([,init])=>init.method === "POST").length,1);
  app.refresh().props.onClick(); await app.settle();
  assert.equal(app.toggle("KBZPay").props["aria-checked"],false); assert.equal(app.toggle("KBZPay").props.disabled,false);
});

test("an unavailable or malformed bank lookup leaves controls disabled", async () => {
  for(const result of [{ok:false,json:async()=>({error:"Please sign in again"})},reply({banks:{kbzpay:{enabled:"yes"}}})]) {
    const app=harness(()=>result); await app.settle();
    assert.equal(app.toggle("KBZPay").props.disabled,true); assert.equal(app.toggle("WavePay").props.disabled,true);
    assert.ok(find(app.render(),node=>node.props?.role === "alert"));
    assert.equal(app.calls.length,1);
  }
});
