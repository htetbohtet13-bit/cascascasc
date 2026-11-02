import { useEffect, useRef, useState, type FormEvent } from 'react';
import { formatMoney } from './lib/format-money';

type Decision = 'mark_paid' | 'refund';
type Resolution = {
  id: string; request_id: string; action: Decision; amount: string; reason: string;
  provider_reference: string | null; created_at: string;
};
type Review = {
  ok?: boolean;
  withdrawal: {
    order_id: string; phone: string; user_id: string; payout_phone: string;
    service_type: string; amount: string; status: string; provider_txn_id: string | null;
    message: string | null; wallet_balance: string; created_at: string; wait_seconds: number;
  };
  resolution: Resolution | null; canResolve: boolean; canRefund: boolean; mfaRequired: boolean;
};
const money = (amount: string) => `${formatMoney(amount)} Ks`;
const date = (value: string) => new Date(value).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Rangoon' });
function validReview(value: unknown, orderId: string): value is Review {
  const result = value as Review | null;
  return Boolean(result && result.withdrawal?.order_id === orderId && typeof result.withdrawal.amount === 'string'
    && /^\d+$/.test(result.withdrawal.amount) && typeof result.canResolve === 'boolean'
    && typeof result.canRefund === 'boolean' && typeof result.mfaRequired === 'boolean');
}

export default function WithdrawalReview({ orderId, onClose, onResolved, onUnauthorized }: {
  orderId: string; onClose: () => void; onResolved: () => void; onUnauthorized: (mfaRequired: boolean) => void;
}) {
  const [review, setReview] = useState<Review | null>(null);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [decision, setDecision] = useState<Decision>('mark_paid');
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');
  const [checked, setChecked] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [amountConfirmation, setAmountConfirmation] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const submitting = useRef(false);
  const requestId = useRef('');
  const dialog = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  const unauthorized = useRef(onUnauthorized);
  close.current = onClose; unauthorized.current = onUnauthorized;

  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    fetch(`/api/admin?view=withdrawal&order_id=${encodeURIComponent(orderId)}`, { credentials: 'include', cache: 'no-store' })
      .then(async (response) => {
        const data = await response.json();
        if (!active) return;
        if (response.status === 401) { unauthorized.current(data.mfaRequired === true); return; }
        if (!response.ok) throw new Error(data.error || 'Could not load this withdrawal.');
        if (!validReview(data, orderId)) throw new Error('Could not verify this withdrawal.');
        setReview(data); setReference(data.withdrawal.provider_txn_id ?? '');
        setConfirming(false); setChecked(false); setPassword(''); setCode('');
        setUncertain(false); requestId.current = '';
      })
      .catch((failure) => { if (active) { setReview(null); setError(failure.message || 'Could not load this withdrawal.'); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [orderId, refresh]);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const previous = document.activeElement as HTMLElement | null;
    element.querySelector<HTMLButtonElement>('button')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting.current) { event.preventDefault(); close.current(); }
      if (event.key !== 'Tab') return;
      const items = [...element.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled])')];
      if (!items.length) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0].focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); if (previous?.isConnected) previous.focus(); };
  }, []);

  const order = review?.withdrawal;
  const formValid = Boolean(!loading && review?.canResolve && checked && reason.trim().length >= 10 && reason.trim().length <= 500
    && (decision === 'refund' ? review.canRefund : /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(reference.trim())));

  function continueReview(event: FormEvent) {
    event.preventDefault();
    if (!formValid || submitting.current || uncertain) return;
    requestId.current = crypto.randomUUID();
    setError(''); setAmountConfirmation(''); setPassword(''); setCode(''); setConfirming(true);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!review || !order || !formValid || !confirming || uncertain || submitting.current
      || amountConfirmation !== order.amount || !password || (review.mfaRequired && !/^\d{6}$/.test(code))) return;
    submitting.current = true; setBusy(true); setError('');
    try {
      const response = await fetch('/api/admin', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resolve_withdrawal', order_id: orderId, request_id: requestId.current,
          decision, reason: reason.trim(), provider_reference: decision === 'mark_paid' ? reference.trim() : '',
          expected_amount: order.amount, confirmation_amount: amountConfirmation, checked_provider: checked, password, code }),
      });
      const data = await response.json();
      if (response.status === 401) { unauthorized.current(data.mfaRequired === true); return; }
      if (!response.ok) {
        if (response.status >= 500 || response.status === 409) setUncertain(true);
        setError(data.error || 'Could not confirm this action. Refresh the withdrawal.'); return;
      }
      if (!validReview(data, orderId) || data.ok !== true || data.resolution?.request_id !== requestId.current
        || data.resolution.action !== decision || data.resolution.amount !== order.amount
        || data.withdrawal.status !== (decision === 'refund' ? 'failed' : 'paid')) {
        throw new Error('Unconfirmed result');
      }
      setReview(data); setConfirming(false); onResolved();
    } catch {
      setUncertain(true); setError('The result is unconfirmed. Refresh status before taking another action.');
    } finally {
      setPassword(''); setCode(''); setBusy(false); submitting.current = false;
    }
  }

  return <div className="withdraw-review-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !submitting.current) onClose(); }}>
    <section className="withdraw-review-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="withdraw-review-title" aria-busy={busy}>
      <header><div><small>WITHDRAWAL REVIEW</small><h2 id="withdraw-review-title">{review?.resolution ? 'Resolution recorded' : 'Resolve withdrawal'}</h2></div><button type="button" aria-label="Close review" disabled={busy} onClick={onClose}>×</button></header>
      {loading ? <p role="status">Loading withdrawal…</p> : null}
      {error ? <div className="admin-error" role="alert">{error}</div> : null}
      {order ? <>
        <dl className="withdraw-review-details">
          <div className="withdraw-review-amount"><dt>Withdrawal amount</dt><dd>{money(order.amount)}</dd></div>
          <div><dt>Player</dt><dd>{order.phone}</dd></div>
          <div><dt>Method / recipient</dt><dd>{order.service_type === 'kbzpay' ? 'KBZPay' : 'WavePay'} · {order.payout_phone}</dd></div>
          <div><dt>Requested (Myanmar)</dt><dd>{date(order.created_at)}</dd></div>
          <div><dt>Order</dt><dd>{order.order_id}</dd></div>
          <div><dt>Status</dt><dd>{review?.resolution?.action === 'refund' ? 'Refunded to game wallet' : order.status}</dd></div>
          <div><dt>Provider reference</dt><dd>{order.provider_txn_id || 'Not recorded — payment outcome must be checked'}</dd></div>
          <div><dt>Last recorded message</dt><dd>{order.message || '—'}</dd></div>
          <div><dt>Current game wallet</dt><dd>{money(order.wallet_balance)}</dd></div>
        </dl>
        {review?.resolution ? <div className="withdraw-review-receipt" role="status">
          <strong>{review.resolution.action === 'refund' ? `${money(order.amount)} returned to the game wallet` : 'Completed transfer recorded as paid'}</strong>
          <p>{review.resolution.reason}</p><small>Admin action · {date(review.resolution.created_at)}</small>
          <small>Audit reference: {review.resolution.id}</small>
        </div> : order.status !== 'pending' ? <p>This withdrawal is already closed.</p>
          : uncertain ? <p>Check the current record before continuing.</p>
          : !review?.canResolve ? <p>This transfer may still be processing. Review is available after three minutes from the request. Refresh status in {order.wait_seconds} seconds.</p>
          : <>
            {!confirming ? <form className="withdraw-review-form" onSubmit={continueReview}>
              <fieldset><legend>Confirmed MyanPay outcome</legend>
                <label><input type="radio" name="decision" value="mark_paid" checked={decision === 'mark_paid'} onChange={() => { setDecision('mark_paid'); setChecked(false); }} />Money was sent — mark paid</label>
                <label><input type="radio" name="decision" value="refund" checked={decision === 'refund'} disabled={!review.canRefund} onChange={() => { setDecision('refund'); setChecked(false); }} />Failed, no money sent — refund game wallet</label>
              </fieldset>
              {!review.canRefund ? <p className="withdraw-review-note">Refund is blocked because a provider transaction is already recorded.</p> : null}
              {decision === 'mark_paid' ? <label>Completed provider transaction reference<input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={160} required autoComplete="off" /></label> : null}
              <label>Reason / provider evidence<textarea value={reason} onChange={(e) => setReason(e.target.value)} minLength={10} maxLength={500} required placeholder="Record the final provider status and how you verified it." /></label>
              <label className="withdraw-review-check"><input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />{decision === 'refund' ? 'I verified the transfer finally failed or was cancelled, and no money was sent. A missing entry or timeout alone is not confirmation.' : 'I checked MyanPay: this exact amount was sent to this recipient under the reference above.'}</label>
              <button className="withdraw-review-primary" type="submit" disabled={!formValid}>Continue</button>
            </form> : <form className="withdraw-review-form" onSubmit={(event) => void submit(event)}>
              <div className="withdraw-review-confirm"><strong>{decision === 'refund' ? `Refund ${money(order.amount)} to the game wallet?` : `Record ${money(order.amount)} as already paid?`}</strong><p>{reason}</p>{decision === 'mark_paid' ? <small>Provider reference: {reference}</small> : null}</div>
              <label>Type the amount to confirm<input name="confirmation_amount" inputMode="numeric" value={amountConfirmation} onChange={(e) => setAmountConfirmation(e.target.value)} autoComplete="off" required disabled={busy} /></label>
              <label>Admin password<input name="review_password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" maxLength={4096} required disabled={busy} /></label>
              {review.mfaRequired ? <label>Fresh authenticator code<input name="review_code" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} autoComplete="one-time-code" maxLength={6} required disabled={busy} /></label> : null}
              <div className="withdraw-review-actions"><button type="button" disabled={busy} onClick={() => { setConfirming(false); setPassword(''); setCode(''); }}>Back</button><button className="withdraw-review-primary" type="submit" disabled={busy || amountConfirmation !== order.amount || !password || (review.mfaRequired && !/^\d{6}$/.test(code))}>{busy ? 'Saving…' : decision === 'refund' ? 'Confirm refund' : 'Confirm paid'}</button></div>
            </form>}
          </>}
      </> : null}
      <footer><button type="button" disabled={busy || loading} onClick={() => setRefresh((n) => n + 1)}>Refresh status</button><button type="button" disabled={busy} onClick={onClose}>Close</button></footer>
    </section>
  </div>;
}
