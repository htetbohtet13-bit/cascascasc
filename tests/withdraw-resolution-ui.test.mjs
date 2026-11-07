import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const compile = async (path) => ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const source = await compile('../src/WithdrawalReview.tsx');
const money = {};
runInNewContext(await compile('../src/lib/format-money.ts'), { exports: money });
const orderId = 'WD00000000000040008000000000000001';
const review = (changes = {}) => ({ withdrawal: { order_id: orderId, user_id: 'local-player', phone: '+959123456789',
  payout_phone: '09123456789', service_type: 'wavepay', amount: '30000', status: 'pending', provider_txn_id: null,
  message: 'Transfer reserved', wallet_balance: '7.6', created_at: '2026-11-01T05:08:03Z', wait_seconds: 0 },
  resolution: null, canResolve: true, canRefund: true, mfaRequired: false, ...changes });
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
function find(tree, predicate) {
  if (!tree || typeof tree !== 'object') return null;
  if (Array.isArray(tree)) { for (const child of tree) { const result = find(child, predicate); if (result) return result; } return null; }
  return predicate(tree) ? tree : find(tree.props?.children, predicate);
}
function text(tree) {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  if (Array.isArray(tree)) return tree.map(text).join('');
  return tree && typeof tree === 'object' ? text(tree.props?.children) : '';
}
function harness(fetcher = async () => response(review())) {
  const states = [], effects = [], calls = []; let cursor = 0, effectIndex = 0, closed = 0, resolved = 0;
  const unauthorized = [];
  const react = {
    useState(initial) { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], (next) => { states[i] = typeof next === 'function' ? next(states[i]) : next; }]; },
    useRef(initial) { const i = cursor++; if (!(i in states)) states[i] = { current: initial }; return states[i]; },
    useEffect(callback, deps) { const i = effectIndex++; const old = effects[i]; if (!old || deps.some((v,j) => !Object.is(v,old.deps[j]))) effects[i] = { callback, deps, changed: true, cleanup: old?.cleanup }; },
  };
  const jsx = (type, props) => ({ type, props }); const exports = {};
  runInNewContext(source, { exports, crypto: { randomUUID }, fetch: async (...args) => { calls.push(args); return fetcher(...args); },
    require(name) { if (name === 'react') return react; if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }; if (name === './lib/format-money') return money; throw new Error(name); } });
  const props = { orderId, onClose: () => closed++, onResolved: () => resolved++, onUnauthorized: (required) => unauthorized.push(required) };
  const render = () => { cursor = 0; effectIndex = 0; return exports.default(props); };
  const settle = async () => { for (let i=0;i<6;i++) { render(); for (const e of effects) { if(e.changed){e.changed=false;e.cleanup?.();e.cleanup=e.callback();} } await new Promise(setImmediate); } };
  const input = (name, value) => { const node = find(render(), n => n.type === 'input' && n.props.name === name); assert.ok(node, name); node.props.onChange({ target: { value } }); };
  const prepareRefund = () => {
    find(render(), n => n.type === 'input' && n.props.value === 'refund').props.onChange();
    find(render(), n => n.type === 'textarea').props.onChange({ target: { value: 'MyanPay confirmed final failure; verified no money was sent.' } });
    find(render(), n => n.type === 'input' && n.props.type === 'checkbox').props.onChange({ target: { checked: true } });
    find(render(), n => n.type === 'form').props.onSubmit({ preventDefault() {} });
    input('confirmation_amount','30000'); input('review_password','test-only-review-password');
  };
  return { render, settle, calls, input, prepareRefund, unauthorized, counts: () => ({ closed, resolved }) };
}

test('opening and closing the review is read-only; refund needs evidence and a second confirmation', async () => {
  const app = harness(); await app.settle();
  assert.equal(app.calls.length,1); assert.ok(app.calls[0][0].includes('view=withdrawal'));
  assert.equal(find(app.render(),n=>n.type==='button'&&text(n)==='Continue').props.disabled,true);
  assert.equal(find(app.render(),n=>n.type==='input'&&n.props.name==='review_password'),null);
  app.prepareRefund();
  assert.ok(text(app.render()).includes('Refund 30,000 Ks to the game wallet?'));
  assert.equal(app.calls.length,1);
  find(app.render(),n=>n.type==='button'&&n.props['aria-label']==='Close review').props.onClick();
  assert.deepEqual(app.counts(),{closed:1,resolved:0});
});

test('large withdrawal decisions use amount and password confirmation and display the resulting payout or refund', async () => {
  for (const decision of ['approve', 'decline']) {
    const withdrawal = { ...review().withdrawal, amount: '400001', approval_state: 'awaiting' };
    const app = harness(async (_url, init) => {
      if (!init?.method) return response(review({ withdrawal, canResolve: false, canRefund: false }));
      const sent = JSON.parse(init.body);
      assert.equal(sent.decision, decision);
      assert.equal(sent.confirmation_amount, '400001');
      assert.equal(sent.reason, '');
      return response(review({ ok: true, canResolve: false, canRefund: false, withdrawal: {
        ...withdrawal, status: decision === 'approve' ? 'paid' : 'failed',
        approval_state: decision === 'approve' ? 'approved' : 'declined',
      } }));
    });
    await app.settle();
    assert.equal(find(app.render(), node => node.type === 'textarea'), null);
    find(app.render(), node => node.type === 'input' && node.props.value === decision).props.onChange();
    find(app.render(), node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    const submit = find(app.render(), node => node.type === 'form').props.onSubmit;
    submit({ preventDefault() {} }); await app.settle();
    assert.equal(app.calls.length, 1);
    app.input('confirmation_amount', '400001');
    app.input('review_password', 'test-only-review-password');
    find(app.render(), node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    await app.settle();
    assert.equal(app.counts().resolved, 1);
    assert.ok(text(app.render()).includes(decision === 'approve' ? 'paid' : 'Declined · Refunded'));
  }
});

test('double submit sends one admin request, clears credentials and shows the recorded refund', async () => {
  let complete; let submitted;
  const app=harness(async (url, init) => {
    if(!init?.method)return response(review());
    submitted=JSON.parse(init.body);return new Promise(resolve=>{complete=resolve;});
  });
  await app.settle();app.prepareRefund();
  const submit=find(app.render(),n=>n.type==='form').props.onSubmit;
  submit({preventDefault(){}});submit({preventDefault(){}});await app.settle();
  assert.equal(app.calls.filter(c=>c[1]?.method==='POST').length,1);
  assert.equal(submitted.action,'resolve_withdrawal');assert.equal(submitted.decision,'refund');
  assert.equal(submitted.expected_amount,'30000');assert.equal(submitted.confirmation_amount,'30000');
  assert.equal(submitted.checked_provider,true);assert.equal(submitted.provider_reference,'');
  complete(response(review({ok:true,canResolve:false,canRefund:false,
    withdrawal:{...review().withdrawal,status:'failed',wallet_balance:'30007.6'},
    resolution:{id:'audit-1',request_id:submitted.request_id,action:'refund',amount:'30000',reason:submitted.reason,provider_reference:null,created_at:'2026-11-02T00:00:00Z'}})));
  await app.settle();
  assert.equal(app.counts().resolved,1);assert.ok(text(app.render()).includes('30,000 Ks returned to the game wallet'));
  assert.equal(find(app.render(),n=>n.type==='input'&&n.props.name==='review_password'),null);
});

test('an uncertain response blocks more actions until status is refreshed, without automatically retrying', async () => {
  let sent;
  const app=harness(async (url,init)=>{
    if(init?.method){sent=JSON.parse(init.body);throw new Error('Connection lost after save');}
    if(sent)return response(review({canResolve:false,canRefund:false,
      withdrawal:{...review().withdrawal,status:'failed'},
      resolution:{id:'saved-refund',request_id:sent.request_id,action:'refund',amount:'30000',reason:sent.reason,provider_reference:null,created_at:'2026-11-02T00:00:00Z'}}));
    return response(review());
  });
  await app.settle();app.prepareRefund();find(app.render(),n=>n.type==='form').props.onSubmit({preventDefault(){}});await app.settle();
  assert.ok(text(app.render()).includes('The result is unconfirmed'));
  assert.equal(find(app.render(),n=>n.type==='form'),null);
  assert.equal(app.calls.filter(c=>c[1]?.method==='POST').length,1);
  find(app.render(),n=>n.type==='button'&&text(n)==='Refresh status').props.onClick();await app.settle();
  assert.ok(text(app.render()).includes('Resolution recorded'));
  assert.equal(app.calls.filter(c=>c[1]?.method==='POST').length,1);
});

test('recorded transfer evidence disables refund; recent requests expose no action form', async () => {
  const withProof=harness(async()=>response(review({canRefund:false,withdrawal:{...review().withdrawal,provider_txn_id:'WV-existing'}})));
  await withProof.settle();assert.equal(find(withProof.render(),n=>n.type==='input'&&n.props.value==='refund').props.disabled,true);
  const recent=harness(async()=>response(review({canResolve:false,canRefund:false,withdrawal:{...review().withdrawal,wait_seconds:160}})));
  await recent.settle();assert.equal(find(recent.render(),n=>n.type==='form'),null);assert.ok(text(recent.render()).includes('160 seconds'));
});

test('wrong-order data fails closed and expired admin sessions return to login', async () => {
  const wrong=harness(async()=>response(review({withdrawal:{...review().withdrawal,order_id:'someone-else'}})));
  await wrong.settle();assert.equal(find(wrong.render(),n=>n.type==='form'),null);assert.ok(text(wrong.render()).includes('Could not verify'));
  const expired=harness(async()=>response({error:'Login again',mfaRequired:true},401));
  await expired.settle();assert.deepEqual(expired.unauthorized,[true]);
});

test('MFA is shown only when configured, and incorrect reauthentication keeps the action unconfirmed', async () => {
  const app=harness(async(url,init)=>init?.method?response({error:'Incorrect admin password'},403):response(review({mfaRequired:true})));
  await app.settle();app.prepareRefund();
  assert.ok(find(app.render(),n=>n.type==='input'&&n.props.name==='review_code'));
  assert.equal(find(app.render(),n=>n.type==='button'&&text(n)==='Confirm refund').props.disabled,true);
  app.input('review_code','012345');find(app.render(),n=>n.type==='form').props.onSubmit({preventDefault(){}});await app.settle();
  assert.ok(text(app.render()).includes('Incorrect admin password'));
  assert.equal(find(app.render(),n=>n.type==='input'&&n.props.name==='review_password').props.value,'');
  assert.equal(find(app.render(),n=>n.type==='input'&&n.props.name==='review_code').props.value,'');
  assert.equal(app.counts().resolved,0);
});
