const MYANMAR_OFFSET = 390 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const RANGES = new Set(["today", "yesterday", "week", "month", "all"]);

export function overviewWindow(value = "today", now = new Date()) {
  if (!RANGES.has(value) || !Number.isFinite(now.getTime())) return null;
  if (value === "all") return { id: value, start: null, end: null, timeZone: "Asia/Rangoon" };
  const local = new Date(now.getTime() + MYANMAR_OFFSET);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  let start = midnight;
  let end = midnight + DAY;
  if (value === "yesterday") { start -= DAY; end -= DAY; }
  if (value === "week") { start -= ((local.getUTCDay() + 6) % 7) * DAY; end = start + 7 * DAY; }
  if (value === "month") {
    start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1);
    end = Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1);
  }
  return { id: value, start: new Date(start - MYANMAR_OFFSET).toISOString(), end: new Date(end - MYANMAR_OFFSET).toISOString(), timeZone: "Asia/Rangoon" };
}

// Only fixed internal column expressions reach this helper. Dates are bound
// parameters, and half-open ranges avoid counting midnight twice.
const inRange = (column) => `($1::timestamptz is null or ${column} >= $1::timestamptz) and ($2::timestamptz is null or ${column} < $2::timestamptz)`;

export async function readAdminOverview(pool, range) {
  const params = [range.start, range.end];
  const result = await pool.query(
    `with player_summary as (
       select count(*) as users, count(*) filter (where ${inRange("created_at")}) as new_users,
              coalesce(sum(balance + balance_minor::numeric / 100), 0) as total_balance
         from public.profiles
     ), deposit_summary as (
       select count(*) as deposit_count, coalesce(sum(amount), 0) as deposit_total
         from public.deposits where status = 'verified' and ${inRange("coalesce(completed_at, created_at)")}
     ), withdrawal_summary as (
       select count(*) filter (where ${inRange("created_at")}) as withdrawal_count,
              count(*) filter (where status = 'pending' and ${inRange("created_at")}) as pending_withdrawals,
              count(*) filter (where status = 'failed' and ${inRange("created_at")}) as failed_withdrawals,
              coalesce(sum(amount) filter (where status = 'paid' and ${inRange("coalesce(completed_at, created_at)")}), 0) as withdrawal_total
         from public.withdrawals
     ), bet_summary as (
       select count(*) as bet_count, coalesce(sum(bet), 0) as bet_total, coalesce(sum(win), 0) as win_total
         from public.slot_bets where ${inRange("created_at")}
     )
     select p.*, d.*, w.*, b.*, d.deposit_total - w.withdrawal_total as net_cash_flow
       from player_summary p cross join deposit_summary d cross join withdrawal_summary w cross join bet_summary b`,
    params,
  );
  const [latestWithdrawals, latestBets] = await Promise.all([
    pool.query(
      `select w.order_id, w.user_id, p.phone, w.service_type, w.amount, w.status, w.created_at
         from public.withdrawals w join public.profiles p on p.id = w.user_id
        where ${inRange("coalesce(w.completed_at, w.created_at)")}
        order by coalesce(w.completed_at, w.created_at) desc, w.order_id limit 8`, params,
    ),
    pool.query(
      `select b.bet_uid, b.round_id, b.bet, b.win, b.created_at, p.id as user_id, p.phone
         from public.slot_bets b join public.profiles p on p.id = b.user_id
        where ${inRange("b.created_at")} order by b.created_at desc, b.bet_uid limit 8`, params,
    ),
  ]);
  return { summary: result.rows[0], latestWithdrawals: latestWithdrawals.rows, latestBets: latestBets.rows, range };
}
