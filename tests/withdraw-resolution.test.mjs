import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, mock, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { adminMfaConfig, adminSessionKey, adminTotpCode, encodeAdminTotpKey } from '../server/admin-mfa.mjs';

const db = new PGlite();
let fault;
let rateError;
let sequence = 100000000;
const logs = [];
const clientFor = (connection) => ({ async query(sql, params) {
  logs.push(sql); fault?.(sql);
  const result = await connection.query(sql, params);
  return { rows: result.rows, rowCount: /^\s*select/i.test(sql) ? result.rows.length : result.affectedRows };
} });
mock.module('../server/neon.mjs', { namedExports: { getPool: () => clientFor(db), withTransaction: (fn) => db.transaction((tx) => fn(clientFor(tx))) } });
mock.module('../server/rate-limit.mjs', { namedExports: { consumeRateLimit: async () => rateError } });
const { handleAdminApi } = await import('../server/admin-api.mjs');
const { reserveWithdraw, completeWithdraw, recordWithdrawTransfer, applyVerifiedDeposit } = await import('../server/wallet.mjs');
const { resolveWithdrawal } = await import('../server/withdrawal-resolution.mjs');
const keys = ['admin_secret', 'ADMIN_SECRET', 'ADMIN_MFA_REQUIRED', 'ADMIN_TOTP_SECRET', 'WITHDRAWALS_ENABLED', 'WITHDRAW_MAX_AMOUNT_MMK', 'WITHDRAW_MAX_PER_DAY'];
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
const password = 'isolated-admin-review-password';
let paymentCalls = 0;

async function migrate(name) {
  await db.exec((await readFile(new URL(`../neon/${name}`, import.meta.url), 'utf8')).replace('create extension if not exists pgcrypto;', ''));
}
before(async () => {
  mock.method(console, 'error', () => {});
  mock.method(globalThis, 'fetch', async () => { paymentCalls++; throw new Error('Admin review must not send bank transfers'); });
  for (const file of ['001_app_schema.sql', '002_phone_auth.sql', '005_skm_seamless_wallet.sql', '006_game_display_settings.sql',
    '008_deposit_wagering.sql', '009_auth_security.sql', '010_money_constraints.sql', '012_game_minor_units.sql',
    '013_first_deposit_bonus.sql', '015_withdrawal_resolution.sql']) await migrate(file);
});
beforeEach(async () => {
  fault = undefined; rateError = null; logs.length = 0; paymentCalls = 0;
  for (const key of keys) delete process.env[key];
  process.env.admin_secret = password;
  await db.exec("truncate public.profiles cascade; truncate public.auth_admin_sessions, public.auth_rate_limits; insert into public.deposit_bonus_campaign(singleton,starts_at) values(true,'2020-01-01') on conflict(singleton) do update set starts_at=excluded.starts_at");
});
after(async () => {
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await db.close();
});
async function admin() {
  const tokenBody = `${Math.floor(Date.now() / 1000)}.${randomBytes(18).toString('hex')}`;
  const signature = createHmac('sha256', adminSessionKey(password, adminMfaConfig())).update(tokenBody).digest('hex');
  const token = `${tokenBody}.${signature}`;
  const hash = createHash('sha256').update(token).digest('hex');
  await db.query("insert into public.auth_admin_sessions(token_hash,expires_at) values($1,now()+interval '1 hour')", [hash]);
  return { cookie: `casino_admin_session=${token}`, hash };
}
async function pending({ age = true, amount = 30000, balance = 50000 } = {}) {
  const userId = randomUUID(); const orderId = `WD${randomUUID().replaceAll('-', '')}`;
  await db.query('insert into public.profiles(id,phone,balance,balance_minor) values($1,$2,$3,60)', [userId, `+959${sequence++}`, balance]);
  assert.equal((await reserveWithdraw({ userId, orderId, amount, serviceType: 'wavepay', phone: '09123456789' })).state, 'reserved');
  if (age) await db.query("update public.withdrawals set created_at=now()-interval '10 minutes' where order_id=$1", [orderId]);
  return { userId, orderId, amount };
}
const bodyFor = (order, changes = {}) => ({ action: 'resolve_withdrawal', order_id: order.orderId, request_id: randomUUID(), decision: 'refund',
  expected_amount: String(order.amount), confirmation_amount: String(order.amount), checked_provider: true,
  reason: 'Checked final gateway failure and confirmed that no funds were sent.', provider_reference: '', password, ...changes });
const req = (actor, body, changes = {}) => ({ method: 'POST', url: '/api/admin', body,
  headers: { cookie: actor?.cookie ?? '', origin: 'https://www.j777ml.com', 'content-type': 'application/json' },
  socket: { remoteAddress: '127.0.0.1' }, ...changes });
const review = (actor, order) => handleAdminApi({ ...req(actor), method: 'GET', url: `/api/admin?view=withdrawal&order_id=${order.orderId}` });
const balance = async (order) => (await db.query('select balance::text, balance_minor from public.profiles where id=$1', [order.userId])).rows[0];
const count = async () => (await db.query('select count(*)::int as total from public.withdrawal_resolutions')).rows[0].total;

test('refund restores only reserved whole kyat, preserves fractions and bonus wagering, and writes one audit', async () => {
  const actor = await admin(); const order = await pending();
  const depositId = randomUUID();
  await applyVerifiedDeposit({ userId: order.userId, orderId: depositId, amount: 5000, serviceType: 'kbzpay', transactionId: depositId });
  const wagerBefore = (await db.query('select * from public.wallet_wagering_events order by id')).rows;
  const result = await handleAdminApi(req(actor, bodyFor(order)));
  assert.equal(result.status, 200); assert.equal(result.body.ok, true);
  assert.equal(result.body.withdrawal.status, 'failed'); assert.equal(result.body.resolution.action, 'refund');
  assert.deepEqual(await balance(order), { balance: '60000', balance_minor: 60 });
  assert.deepEqual((await db.query('select * from public.wallet_wagering_events order by id')).rows, wagerBefore);
  assert.equal((await db.query('select count(*)::int n from public.deposits')).rows[0].n, 1);
  assert.equal(await count(), 1); assert.equal(paymentCalls, 0);
  const audit = (await db.query('select * from public.withdrawal_resolutions')).rows[0];
  assert.equal(audit.actor_session_hash, actor.hash); assert.equal(audit.client_ip, '127.0.0.1');
  assert.equal(String(audit.balance_before), '30000'); assert.equal(String(audit.balance_after), '60000');
  assert.equal(result.body.resolution.actor_session_hash, undefined);
});

test('duplicate submissions are idempotent and conflicting resolutions never refund twice', async () => {
  const actor = await admin(); const order = await pending(); const body = bodyFor(order);
  const results = await Promise.all(Array.from({ length: 5 }, () => handleAdminApi(req(actor, body))));
  assert.ok(results.every((result) => result.status === 200));
  assert.deepEqual(await balance(order), { balance: '50000', balance_minor: 60 });
  assert.equal(await count(), 1);
  assert.equal((await handleAdminApi(req(actor, bodyFor(order)))).status, 409);
  assert.equal((await handleAdminApi(req(actor, bodyFor(order, { decision: 'mark_paid', provider_reference: 'WV-something' })))).status, 409);
  assert.equal(paymentCalls, 0);
});

test('mark paid saves the external reference without moving wallet money; closed orders cannot be refunded', async () => {
  const actor = await admin(); const order = await pending();
  const result = await handleAdminApi(req(actor, bodyFor(order, { decision: 'mark_paid', provider_reference: 'WV-confirmed-123' })));
  assert.equal(result.status, 200); assert.equal(result.body.withdrawal.status, 'paid');
  assert.equal(result.body.withdrawal.provider_txn_id, 'WV-confirmed-123');
  assert.deepEqual(await balance(order), { balance: '20000', balance_minor: 60 });
  assert.equal((await handleAdminApi(req(actor, bodyFor(order)))).status, 409);
  assert.equal(await count(), 1); assert.equal(paymentCalls, 0);
});

test('transfer evidence blocks refunds and a paid reference must match saved evidence', async () => {
  const actor = await admin(); const order = await pending();
  assert.equal(await recordWithdrawTransfer({ userId: order.userId, orderId: order.orderId, providerTransactionId: 'WV-existing' }), true);
  const loaded = await review(actor, order); assert.equal(loaded.body.canRefund, false);
  assert.equal((await handleAdminApi(req(actor, bodyFor(order)))).body.code, 'TRANSFER_EVIDENCE');
  assert.equal((await handleAdminApi(req(actor, bodyFor(order, { decision: 'mark_paid', provider_reference: 'WV-wrong' })))).status, 409);
  assert.equal((await handleAdminApi(req(actor, bodyFor(order, { decision: 'mark_paid', provider_reference: 'WV-existing' })))).status, 200);
  assert.deepEqual(await balance(order), { balance: '20000', balance_minor: 60 });
});

test('recent transfers, stale amounts, missing evidence and malformed confirmation are rejected', async () => {
  const actor = await admin(); const recent = await pending({ age: false });
  assert.equal((await review(actor, recent)).body.canResolve, false);
  assert.equal((await handleAdminApi(req(actor, bodyFor(recent)))).body.code, 'STILL_PROCESSING');
  const order = await pending();
  for (const changes of [{ checked_provider: false }, { reason: 'short' }, { request_id: 'bad' },
    { expected_amount: '30001', confirmation_amount: '30001' }, { confirmation_amount: '30,000' },
    { expected_amount: true }, { provider_reference: 'WV-unresolved' }, { decision: 'delete' }]) {
    assert.ok([400,409].includes((await handleAdminApi(req(actor, bodyFor(order, changes)))).status));
  }
  assert.equal(await count(), 0); assert.deepEqual(await balance(order), { balance: '20000', balance_minor: 60 });
});

test('valid session, fresh password, trusted origin and rate limit are enforced before money changes', async () => {
  const actor = await admin(); const order = await pending();
  assert.equal((await handleAdminApi(req(null, bodyFor(order)))).status, 401);
  assert.equal((await handleAdminApi(req(actor, bodyFor(order, { password: 'incorrect' })))).status, 403);
  assert.equal((await handleAdminApi(req(actor, bodyFor(order), { headers: { ...req(actor).headers, origin: 'https://hostile.example' } }))).status, 403);
  rateError = { status: 429, body: { error: 'Limited' } };
  assert.equal((await handleAdminApi(req(actor, bodyFor(order)))).status, 429); rateError = null;
  await db.query('delete from public.auth_admin_sessions where token_hash=$1', [actor.hash]);
  assert.equal((await handleAdminApi(req(actor, bodyFor(order)))).status, 401);
  assert.equal((await resolveWithdrawal({ body: bodyFor(order), actorSessionHash: actor.hash, clientIp: '127.0.0.1' })).status, 401);
  assert.equal(await count(), 0); assert.equal(paymentCalls, 0);
});

test('an audit insert failure rolls back the refund and order status together', async () => {
  const actor = await admin(); const order = await pending(); const body = bodyFor(order);
  fault = (sql) => { if (sql.includes('insert into public.withdrawal_resolutions')) throw Object.assign(new Error('private-db-details'), { code: 'TEST_FAILURE' }); };
  const result = await handleAdminApi(req(actor, body)); assert.equal(result.status, 503);
  fault = undefined;
  assert.deepEqual(await balance(order), { balance: '20000', balance_minor: 60 });
  assert.equal((await review(actor, order)).body.withdrawal.status, 'pending'); assert.equal(await count(), 0);
  assert.ok(!JSON.stringify(result).includes('private-db-details'));
  assert.equal((await handleAdminApi(req(actor, body))).status, 200);
});

test('reused request IDs and provider references roll back a different withdrawal', async () => {
  const actor = await admin(); const first = await pending(); const second = await pending(); const body = bodyFor(first);
  assert.equal((await handleAdminApi(req(actor, body))).status, 200);
  assert.equal((await handleAdminApi(req(actor, bodyFor(second, { request_id: body.request_id })))).status, 409);
  assert.deepEqual(await balance(second), { balance: '20000', balance_minor: 60 });
  const third = await pending();
  await recordWithdrawTransfer({ userId: third.userId, orderId: third.orderId, providerTransactionId: 'WV-unique' });
  await completeWithdraw({ userId: third.userId, orderId: third.orderId, providerTransactionId: 'WV-unique' });
  assert.equal((await handleAdminApi(req(actor, bodyFor(second, { decision: 'mark_paid', provider_reference: 'WV-unique' })))).status, 409);
  assert.equal((await review(actor, second)).body.withdrawal.status, 'pending');
  assert.equal(await count(), 1);
});

test('missing audit storage and overflow fail closed, preserving reserved funds', async () => {
  const actor = await admin(); const order = await pending();
  fault = (sql) => { if (sql.includes('from public.withdrawal_resolutions')) throw Object.assign(new Error('missing'), { code: '42P01' }); };
  assert.equal((await handleAdminApi(req(actor, bodyFor(order)))).body.code, 'REVIEW_STORAGE_UNAVAILABLE'); fault = undefined;
  assert.deepEqual(await balance(order), { balance: '20000', balance_minor: 60 });
  await db.query('update public.profiles set balance=9007199254740991 where id=$1', [order.userId]);
  assert.equal((await handleAdminApi(req(actor, bodyFor(order)))).status, 503);
  assert.deepEqual(await balance(order), { balance: '9007199254740991', balance_minor: 60 });
  assert.equal(await count(), 0);
});

test('configured MFA requires a fresh code; retries of the same completed intent do not repeat the action', async () => {
  process.env.ADMIN_TOTP_SECRET = encodeAdminTotpKey(Buffer.alloc(20, 7));
  const actor = await admin(); const order = await pending(); const second = await pending();
  const code = adminTotpCode(adminMfaConfig().key, Math.floor(Date.now() / 30000));
  assert.equal((await review(actor, order)).body.mfaRequired, true);
  assert.equal((await handleAdminApi(req(actor, bodyFor(order)))).status, 403);
  const body = bodyFor(order, { code });
  assert.equal((await handleAdminApi(req(actor, body))).status, 200);
  assert.equal((await handleAdminApi(req(actor, body))).status, 200);
  assert.equal((await handleAdminApi(req(actor, bodyFor(second, { code })))).body.code, 'MFA_REUSED');
  assert.equal(await count(), 1); assert.deepEqual(await balance(second), { balance: '20000', balance_minor: 60 });
});

test('migration reruns preserve existing money, orders and resolution evidence', async () => {
  const actor = await admin(); const order = await pending(); await handleAdminApi(req(actor, bodyFor(order)));
  const before = await balance(order); const audit = (await review(actor, order)).body.resolution;
  await migrate('015_withdrawal_resolution.sql'); await migrate('015_withdrawal_resolution.sql');
  assert.deepEqual(await balance(order), before); assert.deepEqual((await review(actor, order)).body.resolution, audit);
});
