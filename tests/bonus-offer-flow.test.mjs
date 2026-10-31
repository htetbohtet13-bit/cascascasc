import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const compile = async (path) => ts.transpileModule(await readFile(new URL(path, import.meta.url), "utf8"), { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
const appCode = await compile("../src/App.tsx");
const offerCode = await compile("../src/BonusOffer.tsx");
const flush = () => new Promise(setImmediate);
function find(tree, predicate) {
  if (!tree || typeof tree !== "object") return null;
  if (Array.isArray(tree)) { for (const child of tree) { const found = find(child, predicate); if (found) return found; } return null; }
  return predicate(tree) ? tree : find(tree.props?.children, predicate);
}
function text(tree) {
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  if (Array.isArray(tree)) return tree.map(text).join("");
  return tree && typeof tree === "object" ? text(tree.props?.children) : "";
}

// Exercise account creation -> eligibility -> popup -> deposit routing. All
// identity and configuration calls are mocked; no real account or payment exists.
function appHarness({ loggedIn = false, eligible = true, failed = false, pending = false } = {}) {
  const states = []; const effects = []; const calls = [];
  let cursor = 0; let effectCursor = 0;
  let session = loggedIn ? { user: { id: "test-player" } } : null;
  const user = { user: { id: "new-player" } };
  const control = { eligible, failed, pending };
  const react = {
    useState(initial) { const i = cursor++; if (!(i in states)) states[i] = typeof initial === "function" ? initial() : initial; return [states[i], (next) => { states[i] = typeof next === "function" ? next(states[i]) : next; }]; },
    useRef(initial) { const i = cursor++; if (!(i in states)) states[i] = { current: initial }; return states[i]; },
    useCallback(fn, deps) { const i = cursor++; if (!(i in states) || deps.some((v, j) => v !== states[i].deps[j])) states[i] = { fn, deps }; return states[i].fn; },
    useEffect(callback, deps) { const i = effectCursor++; const old = effects[i]; if (!old || deps.some((v, j) => !Object.is(v, old.deps[j]))) effects[i] = { callback, deps, changed: true, cleanup: old?.cleanup }; },
  };
  const jsx = (type, props) => ({ type, props });
  const Offer = (props) => ({ type: "bonus-offer", props });
  const Modal = (props) => ({ type: "welcome-popup", props });
  const Wallet = (props) => ({ type: "deposit-wallet", props });
  const exports = {};
  runInNewContext(appCode, {
    exports,
    window: { location: { pathname: "/" }, setInterval: () => 1, clearInterval() {} },
    fetch: async (path, options) => {
      assert.equal(path, "/api/me"); assert.notEqual(options?.method, "POST");
      return { ok: true, json: async () => ({ profile: { phone: "09123456789", balance: 0, created_at: "2026-10-31T00:00:00Z" } }) };
    },
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx: (type, props) => [Offer, Modal, Wallet].includes(type) ? type(props) : jsx(type, props), jsxs: jsx };
      if (name === "./lib/auth") return {
        getSession: async () => session,
        authenticate: async (mode) => { calls.push(mode); session = user; },
        signOut: async () => { calls.push("sign-out"); session = null; },
      };
      if (name === "./lib/game") return { loadGames: async () => [], loadSlotBets: async () => [] };
      if (name === "./lib/wallet") return { loadWalletMethods: async () => {
        calls.push("eligibility");
        if (control.pending) return new Promise(() => {});
        if (control.failed) throw new Error("Configuration unavailable");
        return { promotion: { eligible: control.eligible, bonus: 5000, minimum: 5000, multiplier: 30 } };
      } };
      if (name === "./BonusOffer") return { default: Offer, WelcomeBonusModal: Modal };
      if (name === "./WalletCenter") return { default: Wallet };
      if (name === "./GameHistory" || name === "./AdminDashboard") return { default: () => null };
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  const render = () => { cursor = 0; effectCursor = 0; return exports.default(); };
  const settle = async () => {
    for (let pass = 0; pass < 8; pass++) {
      render();
      for (const effect of effects) { if (effect.changed) { effect.changed = false; effect.cleanup?.(); effect.cleanup = effect.callback(); } }
      await flush();
    }
  };
  return { render, settle, calls, control,
    popup: () => find(render(), (node) => node.type === "welcome-popup"),
    offer: () => find(render(), (node) => node.type === "bonus-offer"),
    wallet: () => find(render(), (node) => node.type === "deposit-wallet"),
    async signup() { await settle(); await find(render(), (node) => node.type === "form" && node.props.className === "auth-form").props.onSubmit({ preventDefault() {} }); await settle(); },
    async nav(id) { find(render(), (node) => node.type === "button" && node.props["data-id"] === id).props.onClick(); await settle(); },
  };
}

test("eligible new accounts see the popup; taking the bonus opens a prefilled deposit without crediting or sending money", async () => {
  const app = appHarness(); await app.signup();
  assert.ok(app.popup()); assert.equal(app.wallet(), null);
  app.popup().props.onTake(); await app.settle();
  assert.equal(app.popup(), null); assert.equal(app.wallet().props.initialTab, "deposit");
  assert.equal(app.wallet().props.initialDepositAmount, 5000);
  assert.deepEqual(app.calls.filter((call) => call !== "eligibility"), ["signup"]);
});

test("closing the welcome popup keeps the offer available on the bonus page without repeatedly reopening it", async () => {
  const app = appHarness(); await app.signup(); app.popup().props.onClose(); await app.settle();
  assert.equal(app.wallet(), null); assert.equal(app.popup(), null);
  await app.nav("bonuses"); assert.ok(app.offer()); assert.equal(app.offer().props.unavailable, false);
  assert.equal(app.popup(), null); app.offer().props.onTake(); await app.settle();
  assert.equal(app.wallet().props.initialDepositAmount, 5000);
});

test("existing signed-in accounts do not get a signup popup; ineligible accounts cannot be offered another bonus", async () => {
  const eligible = appHarness({ loggedIn: true }); await eligible.settle(); assert.equal(eligible.popup(), null);
  await eligible.nav("bonuses"); assert.equal(eligible.offer().props.unavailable, false);
  const used = appHarness({ eligible: false }); await used.signup(); assert.equal(used.popup(), null);
  await used.nav("bonuses"); assert.equal(used.offer().props.unavailable, true); assert.equal(used.wallet(), null);
  const returning = appHarness(); await returning.settle();
  find(returning.render(), (node) => node.type === "button" && node.props.className === "auth-close").props.onClick();
  find(returning.render(), (node) => node.type === "button" && node.props.className === "guest-login-icon").props.onClick();
  await returning.settle();
  assert.ok(text(returning.render()).includes("အကောင့်ဝင်ပါ"));
  await returning.signup();
  assert.ok(returning.calls.includes("signin")); assert.equal(returning.popup(), null);
});

test("eligibility is refreshed after leaving deposits so an awarded bonus is no longer offered", async () => {
  const app = appHarness(); await app.signup(); app.popup().props.onTake(); await app.settle();
  app.control.eligible = false;
  app.wallet().props.onClose(); await app.settle(); await app.nav("bonuses");
  assert.equal(app.offer().props.unavailable, true); assert.equal(app.popup(), null);
});

test("unconfirmed eligibility never shows a welcome offer; a failed lookup can be retried", async () => {
  const loading = appHarness({ pending: true }); await loading.signup();
  assert.equal(loading.popup(), null); await loading.nav("bonuses"); assert.equal(loading.offer(), null);
  const failed = appHarness({ failed: true }); await failed.signup(); assert.equal(failed.popup(), null);
  await failed.nav("bonuses"); assert.equal(failed.offer(), null);
  failed.control.failed = false;
  find(failed.render(), (node) => node.type === "button" && text(node) === "ပြန်ဖွင့်မည်").props.onClick();
  await failed.settle(); assert.ok(failed.popup());
});

test("a guest uses the bonus page to create an account before accessing deposits", async () => {
  const app = appHarness(); await app.settle(); await app.nav("bonuses");
  assert.equal(app.offer().props.guest, true); app.offer().props.onTake(); await app.settle();
  assert.equal(app.wallet(), null); assert.ok(find(app.render(), (node) => node.type === "form" && node.props.className === "auth-form"));
  const dialog = find(app.render(), (node) => node.props?.className === "auth-box");
  const password = find(dialog, (node) => node.type === "input" && node.props.name === "password");
  assert.equal(password.props.minLength, 5); assert.equal(password.props.maxLength, 128);
  assert.equal(password.props.placeholder, "အနည်းဆုံး ၅ လုံး");
  assert.ok(text(dialog).includes("🎁")); assert.ok(text(dialog).includes("စုစုပေါင်း 10,000 ကျပ် ရယူပါ"));
  assert.ok(text(dialog).includes("ငွေသွင်း 5,000 ကျပ် + ဘောနပ်စ် 5,000 ကျပ်"));
  assert.ok(!text(dialog).includes("အကောင့်ရှိပြီးသားလား?"));
  assert.equal(find(dialog, (node) => node.props?.className === "auth-switch-line"), null);
});

const offerExports = {};
const jsx = (type, props) => typeof type === "function" ? type(props) : ({ type, props });
runInNewContext(offerCode, { exports: offerExports, require: () => ({ jsx, jsxs: jsx }) });
test("the simplified offer shows the fixed bonus and example total with working take and dismiss buttons", () => {
  let taken = 0; let closed = 0;
  const tree = offerExports.default({ onTake: () => taken++, onClose: () => closed++ });
  const content = text(tree);
  assert.ok(content.includes("🎁"));
  assert.ok(content.includes("5,000")); assert.ok(content.includes("+5,000")); assert.ok(content.includes("10,000"));
  assert.ok(!content.includes("အကောင့်တစ်ခုလျှင် တစ်ကြိမ်သာ။ သွင်းငွေ + ဘောနပ်စ်")); assert.ok(!content.includes("100%"));
  find(tree, (node) => node.type === "button" && text(node).includes("ဘောနပ်စ်ယူမည်")).props.onClick(); assert.equal(taken, 1);
  find(tree, (node) => node.type === "button" && text(node) === "နောက်မှ").props.onClick(); assert.equal(closed, 1);
  const used = offerExports.default({ onTake() {}, unavailable: true });
  assert.equal(find(used, (node) => node.type === "button" && text(node).includes("ဘောနပ်စ်ယူမည်")), null);
});
