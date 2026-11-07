import { getPool, withTransaction } from './neon.mjs';
import { addMoney, money } from './money.mjs';
import { lockBankAvailability } from './deposit-banks.mjs';
import { payoutPolicy } from './payout-security.mjs';
import { sendReservedWithdrawal, withdrawalPayment } from './wallet-proxy.mjs';

const REVIEW_DELAY_SECONDS = 180; // Longer than the payout function's 120-second maximum.
const ORDER_RE = /^[A-Za-z0-9_-]{1,80}$/;
const REQUEST_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (status, code, error) => ({ status, body: { error, code } });

function publicResolution(row) {
  if (!row) return null;
  return {
    id: row.id, request_id: row.request_id, action: row.action, amount: String(row.amount),
    provider_reference: row.provider_reference, reason: row.reason,
    created_at: row.created_at, balance_before: String(row.balance_before),
    balance_after: String(row.balance_after), balance_minor: row.balance_minor,
  };
}

export async function readWithdrawalReview(client, orderId) {
  if (typeof orderId !== 'string' || !ORDER_RE.test(orderId)) return fail(400, 'INVALID_ORDER', 'Choose a valid withdrawal.');
  const result = await client.query(
    `select w.id, w.order_id, w.user_id, p.phone, w.service_type, w.amount, w.payout_phone,
            w.status, w.approval_state, w.approval_decided_at, w.provider_txn_id, w.message, w.created_at, w.completed_at,
            p.balance::numeric + p.balance_minor::numeric / 100 as wallet_balance,
            greatest(0, ceil($2 - extract(epoch from (clock_timestamp() - coalesce(w.approval_decided_at, w.created_at)))))::int as wait_seconds,
            to_jsonb(r) as audit
       from public.withdrawals w join public.profiles p on p.id = w.user_id
       left join public.withdrawal_resolutions r on r.withdrawal_id = w.id
      where w.order_id = $1`, [orderId, REVIEW_DELAY_SECONDS],
  );
  if (!result.rows.length) return fail(404, 'ORDER_NOT_FOUND', 'Withdrawal not found.');
  const { audit, ...row } = result.rows[0];
  return { status: 200, body: {
    withdrawal: { ...row, amount: String(row.amount), wallet_balance: String(row.wallet_balance) },
    resolution: publicResolution(audit),
    canResolve: row.status === 'pending' && row.approval_state !== 'awaiting' && row.wait_seconds === 0,
    canRefund: row.status === 'pending' && row.approval_state !== 'awaiting' && row.wait_seconds === 0 && !row.provider_txn_id,
  } };
}

export function withdrawalReviewUnavailable(error) {
  console.error('Withdrawal review unavailable', { code: error?.code ?? 'unavailable' });
  if (error?.code === '42P01') {
    return fail(503, 'REVIEW_STORAGE_UNAVAILABLE', 'Run neon/015_withdrawal_resolution.sql in Neon SQL Editor before using withdrawal review.');
  }
  if (error?.code === '23505') return fail(409, 'RESOLUTION_CONFLICT', 'This request or transaction reference was already used. Refresh the withdrawal before continuing.');
  return fail(503, 'REVIEW_UNCONFIRMED', 'The result could not be confirmed. Refresh this withdrawal before trying another action.');
}

export async function resolveWithdrawal({ body, actorSessionHash, clientIp, claimSecondFactor }) {
  const { order_id: orderId, request_id: requestId, decision, reason, provider_reference: rawReference } = body ?? {};
  const approvalDecision = decision === 'approve' || decision === 'decline';
  if (typeof orderId !== 'string' || !ORDER_RE.test(orderId) || typeof requestId !== 'string' || !REQUEST_RE.test(requestId)
    || (!approvalDecision && !['mark_paid', 'refund'].includes(decision))) return fail(400, 'INVALID_REVIEW', 'Choose a valid withdrawal and action.');
  const cleanReason = typeof reason === 'string' ? reason.trim() : '';
  if (!approvalDecision && (cleanReason.length < 10 || cleanReason.length > 500 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(cleanReason)
    || body.checked_provider !== true)) return fail(400, 'EVIDENCE_REQUIRED', 'Confirm the final provider outcome and enter a reason of 10–500 characters.');
  const reference = typeof rawReference === 'string' ? rawReference.trim() : '';
  if ((decision === 'mark_paid' && (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(reference)))
    || (decision === 'refund' && reference)) return fail(400, 'INVALID_REFERENCE', 'Enter the completed provider transaction reference for a paid transfer.');
  let expectedAmount;
  try { expectedAmount = money(body.expected_amount); } catch { return fail(400, 'INVALID_AMOUNT', 'Refresh the withdrawal amount.'); }
  if (typeof body.confirmation_amount !== 'string' || body.confirmation_amount !== expectedAmount.toString()) {
    return fail(400, 'CONFIRMATION_REQUIRED', 'Type the withdrawal amount exactly to confirm.');
  }
  if (!/^[0-9a-f]{64}$/.test(actorSessionHash ?? '') || typeof clientIp !== 'string' || !clientIp || clientIp.length > 80) {
    return fail(401, 'ADMIN_REQUIRED', 'Sign in to admin again.');
  }

  try {
    const result = await withTransaction(async (client) => {
      const found = await client.query('select user_id from public.withdrawals where order_id = $1', [orderId]);
      if (!found.rows.length) return fail(404, 'ORDER_NOT_FOUND', 'Withdrawal not found.');
      // Match every other money writer: profile first, then withdrawal. No bank calls in this transaction.
      const profileResult = await client.query('select balance, balance_minor from public.profiles where id = $1::uuid for update', [found.rows[0].user_id]);
      const orderResult = await client.query(
        `select *, (coalesce(approval_decided_at, created_at) <= clock_timestamp() - ($2 * interval '1 second')) as old_enough
           from public.withdrawals where order_id = $1 for update`, [orderId, REVIEW_DELAY_SECONDS],
      );
      const order = orderResult.rows[0];
      if (!profileResult.rows.length || !order || order.user_id !== found.rows[0].user_id || money(order.amount) !== expectedAmount) {
        return fail(409, 'REVIEW_CHANGED', 'Withdrawal details changed. Refresh before continuing.');
      }
      // Keep logout/revocation from racing a money action after its initial API check.
      const session = await client.query(
        'select 1 from public.auth_admin_sessions where token_hash = $1 and expires_at > clock_timestamp() for share', [actorSessionHash],
      );
      if (!session.rows.length) return fail(401, 'ADMIN_REQUIRED', 'Sign in to admin again.');
      if (approvalDecision) {
        if (order.approval_state !== 'awaiting' || order.status !== 'pending' || order.provider_txn_id) {
          return fail(409, 'APPROVAL_CLOSED', 'This withdrawal no longer awaits approval. Refresh to view its status.');
        }
        const approve = decision === 'approve';
        let payment;
        if (approve) {
          const policy = payoutPolicy();
          if (!policy.enabled || expectedAmount > policy.maximum) return fail(409, 'PAYOUT_PAUSED', 'The current payout limits block this withdrawal.');
          if (!await lockBankAvailability(client, order.service_type)) return fail(409, 'BANK_UNAVAILABLE', 'This bank is off. Turn it on before approving the payout.');
          payment = withdrawalPayment(order.service_type);
          if (!payment) return fail(503, 'PAYMENT_UNAVAILABLE', 'Payment is not configured for this bank.');
        }
        if (claimSecondFactor && !await claimSecondFactor(client)) return fail(403, 'MFA_REUSED', 'This authenticator code was already used. Enter a fresh code.');
        const before = profileResult.rows[0].balance;
        if (!approve) {
          await client.query('update public.profiles set balance = $2 where id = $1::uuid', [order.user_id, addMoney(before, order.amount)]);
        }
        await client.query(
          `update public.withdrawals set approval_state = $2, approval_decided_at = clock_timestamp(), approval_admin_hash = $3,
             status = $4, message = $5, completed_at = case when $4 = 'failed' then clock_timestamp() else null end
            where id = $1::uuid`,
          [order.id, approve ? 'approved' : 'declined', actorSessionHash, approve ? 'pending' : 'failed',
            approve ? 'Approved for payout' : 'ငွေထုတ်တောင်းဆိုမှု ပယ်ချပြီး လက်ကျန်ငွေ ပြန်ဖြည့်ပေးထားပါသည်။'],
        );
        if (approve) {
          return { transfer: {
            userId: order.user_id, serviceType: order.service_type, amount: Number(expectedAmount), phone: order.payout_phone,
            reserved: { orderId, balance: Number(money(before)) }, payment,
            log: (event, details) => console.info('Approved withdrawal', { orderId, event, ...details }),
          } };
        }
        const review = await readWithdrawalReview(client, orderId);
        return { ...review, body: { ...review.body, ok: true } };
      }
      if (order.approval_state === 'awaiting') return fail(409, 'APPROVAL_REQUIRED', 'Approve or decline this request before reconciling any payout.');
      const prior = await client.query('select * from public.withdrawal_resolutions where withdrawal_id = $1::uuid', [order.id]);
      if (prior.rows.length) {
        const audit = prior.rows[0];
        if (audit.request_id !== requestId.toLowerCase() || audit.action !== decision || audit.reason !== cleanReason
          || (audit.provider_reference ?? '') !== reference) return fail(409, 'ALREADY_RESOLVED', 'This withdrawal was already resolved. Refresh to view its outcome.');
        const review = await readWithdrawalReview(client, orderId);
        return { ...review, body: { ...review.body, ok: true } };
      }
      if (order.status !== 'pending') return fail(409, 'ALREADY_RESOLVED', 'Only pending withdrawals can be resolved.');
      if (!order.old_enough) return fail(409, 'STILL_PROCESSING', 'This transfer may still be processing. Wait three minutes from its request time, then refresh.');
      if (decision === 'refund' && order.provider_txn_id) return fail(409, 'TRANSFER_EVIDENCE', 'A provider transaction is recorded. Refund is blocked; verify and reconcile that transfer first.');
      if (decision === 'mark_paid' && order.provider_txn_id && order.provider_txn_id !== reference) {
        return fail(409, 'REFERENCE_MISMATCH', 'The reference must match the provider transaction already recorded.');
      }
      if (claimSecondFactor && !await claimSecondFactor(client)) return fail(403, 'MFA_REUSED', 'This authenticator code was already used. Enter a fresh code.');

      const profile = profileResult.rows[0];
      const before = money(profile.balance);
      const after = decision === 'refund' ? addMoney(before, order.amount) : before.toString();
      if (decision === 'refund') {
        await client.query('update public.profiles set balance = $2 where id = $1::uuid', [order.user_id, String(after)]);
      }
      await client.query(
        `update public.withdrawals set status = $2, provider_txn_id = nullif($3, ''), message = $4, completed_at = clock_timestamp()
          where id = $1::uuid`,
        [order.id, decision === 'refund' ? 'failed' : 'paid', reference,
          decision === 'refund' ? 'ငွေထုတ်မအောင်မြင်ပါ။ သင့်ဂိမ်းအကောင့်သို့ ငွေပြန်ထည့်ပြီးပါပြီ။' : 'Transfer Successful'],
      );
      await client.query(
        `insert into public.withdrawal_resolutions
           (withdrawal_id, user_id, request_id, action, amount, provider_reference, reason, checked_provider,
            actor_session_hash, client_ip, balance_before, balance_after, balance_minor)
         values ($1::uuid,$2::uuid,$3::uuid,$4,$5,nullif($6,''),$7,true,$8,$9,$10,$11,$12)`,
        [order.id, order.user_id, requestId.toLowerCase(), decision, String(order.amount), reference, cleanReason,
          actorSessionHash, clientIp, before.toString(), String(after), profile.balance_minor],
      );
      const review = await readWithdrawalReview(client, orderId);
      return { ...review, body: { ...review.body, ok: true } };
    });
    if (!result.transfer) return result;
    // Only the transaction that claimed approval can send. If the process
    // stops after the claim, reconcile the pending transfer before any refund.
    await sendReservedWithdrawal(result.transfer);
    const review = await readWithdrawalReview(getPool(), orderId);
    return { ...review, body: { ...review.body, ok: true } };
  } catch (error) { return withdrawalReviewUnavailable(error); }
}
