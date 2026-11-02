# Admin withdrawal review

## Deployment

1. Run the full `neon/015_withdrawal_resolution.sql` file in the production Neon SQL Editor.
2. Confirm the result says **Withdrawal review storage is ready; existing balances and orders were preserved**.
3. Deploy the app update. This does not resolve or refund any existing order automatically.

The migration adds an audit table and grants the runtime role read/insert access.
It does not change existing balances, withdrawal statuses, bonus claims or wagering.
Re-running `neon/011_runtime_role.sql` preserves these restricted audit permissions.

## Resolve an order

Open **Admin → Withdrawals → Resolve**. The same review is available from the overview
and the player's withdrawal list. Review closed orders with **Details**.

Check the amount, recipient, account, request time and gateway reference against
MyanPay's final transfer record. The supplied payment API guide has no documented
transfer-status lookup, so this update does not invent one or send another transfer.

- **Money was sent → Mark paid:** enter the completed gateway transaction reference.
  This records a completed bank transfer; it does not move the player's game balance.
- **Finally failed/cancelled, no money sent → Refund game wallet:** restore the reserved
  amount once and close the order as failed. Missing history, a timeout or no saved
  transaction reference alone does not establish failure.
- **Uncertain:** close the review and leave the order pending. Do not refund or resend.

Enter a reason describing the provider evidence and confirm it was checked. On the
confirmation screen, type the exact amount and re-enter the admin password. A fresh
authenticator code is required when existing admin MFA is configured.

## Protections

- Review is locked for the first three minutes, beyond the payout function's
  120-second maximum runtime. This delay is not proof that a transfer failed.
- Paid/failed orders cannot be changed through review. An exact retry of a completed
  request returns its existing result without another money change.
- A stored provider transaction blocks refunds. Mark-paid references must match
  saved evidence and cannot belong to another withdrawal.
- All resolutions require the authenticated admin session, fresh password,
  trusted request origin and a shared reauthentication rate limit.
- The session is rechecked inside the money transaction, and MFA consumption,
  wallet update, order closure and audit insertion commit together.
- Profile then withdrawal row locks match other wallet writers. Repeated clicks,
  competing actions and duplicate request IDs cannot issue two refunds.
- Fractional kyat, other wallet activity, deposit wagering and bonus eligibility are
  preserved. A refund is not a new deposit and awards no bonus.
- Completed decisions record the amount, action, reason, provider reference,
  before/after wallet amounts, admin-session hash, client IP and timestamp.
  The restricted runtime role cannot update or delete these audit records.
- A lost or unclear response requires **Refresh status**. The UI does not automatically
  retry a money action. Never manually edit the database to resolve an uncertain send.

The admin password is shared, so the audit identifies an admin session rather than
an individually named staff account. These controls cannot independently prove a
manual provider-history check; the operator must verify the actual final outcome.
