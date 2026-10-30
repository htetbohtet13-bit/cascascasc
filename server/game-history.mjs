// Read-only reporting over the authoritative wallet ledger. One row per
// accepted debit, regardless of repeated settlement/rollback callbacks.
// unit_scale records the wallet units used at the time; never rewrite history.
export const GAME_ACTIVITY_CTE = `with provider_activity as (
  select d.user_id, 'skm:' || d.transaction_id as bet_uid,
         d.transaction_id, 'skm'::text as source, d.round_id, d.game_code,
         null::integer as game_id, null::integer as room_id,
         case when d.reason = 'BANK_DEPOSIT' then 'banker' else 'bet' end as activity_type,
         case when d.status = 'SETTLED' and c.kind = 'CREDIT' then 'settled'
              when d.status = 'ROLLED_BACK' and c.kind = 'ROLLBACK' then 'cancelled'
              else 'pending' end as status,
         d.amount::numeric / d.unit_scale as held_amount,
         case when d.reason = 'BANK_DEPOSIT' then 0::numeric
              when w.id is not null then w.amount::numeric / w.amount_scale
              when d.game_code in ('shankoemee','shankoemee3d','bugyee','abcd')
                then d.amount::numeric / d.unit_scale / 5
              else d.amount::numeric / d.unit_scale end as stake,
         c.amount::numeric / c.unit_scale as returned_amount,
         case when (d.status = 'SETTLED' and c.kind = 'CREDIT')
                     or (d.status = 'ROLLED_BACK' and c.kind = 'ROLLBACK')
              then c.balance_after::numeric / c.unit_scale
              else d.balance_after::numeric / d.unit_scale end as balance_after,
         d.created_at,
         case when (d.status = 'SETTLED' and c.kind = 'CREDIT')
                     or (d.status = 'ROLLED_BACK' and c.kind = 'ROLLBACK')
              then c.created_at end as settled_at
    from public.skm_wallet_transactions d
    left join public.wallet_wagering_events w
      on w.kind = 'BET' and w.source_id = d.transaction_id and w.user_id = d.user_id
    left join public.skm_wallet_transactions c
      on c.debit_transaction_id = d.transaction_id and c.user_id = d.user_id
     and c.round_id = d.round_id and c.game_code = d.game_code
     and c.currency = d.currency and c.unit_scale = d.unit_scale and c.status = 'APPLIED'
     and ((c.kind = 'CREDIT' and c.reason = case when d.reason = 'BANK_DEPOSIT' then 'BANK_RETURN' else 'BET_SETTLE' end)
       or (c.kind = 'ROLLBACK' and c.reason = d.reason and c.amount = d.amount))
   where d.kind = 'DEBIT' and d.status in ('APPLIED','SETTLED','ROLLED_BACK')
), game_activity as (
  select user_id, bet_uid, transaction_id, source, round_id, game_code, game_id, room_id,
         activity_type, status, stake as bet,
         case when status = 'settled' and activity_type = 'bet'
              then returned_amount - (held_amount - stake) end as win,
         case when status = 'settled' then returned_amount - held_amount
              when status = 'cancelled' then 0::numeric end as changemoney,
         held_amount,
         case when status <> 'pending' then returned_amount end as returned_amount,
         balance_after, created_at, settled_at, coalesce(settled_at, created_at) as reported_at
    from provider_activity
  union all
  select user_id, 'legacy:' || bet_uid, bet_uid, 'legacy', round_id,
         null::text, game_id, room_id, 'bet', 'settled', bet::numeric, win::numeric,
         changemoney::numeric, bet::numeric, win::numeric, balance_after::numeric,
         created_at, created_at, created_at
    from public.slot_bets
)`;

export async function playerGameHistory(pool, userId, limit = 8) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid history limit");
  const result = await pool.query(
    `${GAME_ACTIVITY_CTE}
     select bet_uid, transaction_id, source, round_id, game_code, game_id, room_id,
            activity_type, status, bet, win, changemoney, held_amount, returned_amount,
            balance_after, created_at, settled_at
       from game_activity where user_id = $1::uuid
      order by created_at desc, bet_uid desc limit $2`, [userId, limit],
  );
  return result.rows;
}

export async function adminGameHistory(pool, { page, limit, offset, search }) {
  const params = [search, `%${search}%`];
  const where = `($1 = '' or p.phone ilike $2 or a.user_id::text ilike $2
    or a.transaction_id ilike $2 or a.round_id ilike $2 or a.game_code ilike $2)`;
  const [rows, count] = await Promise.all([
    pool.query(`${GAME_ACTIVITY_CTE}
      select a.*, p.phone from game_activity a join public.profiles p on p.id = a.user_id
       where ${where} order by a.created_at desc, a.bet_uid desc limit $3 offset $4`, [...params, limit, offset]),
    pool.query(`${GAME_ACTIVITY_CTE}
      select count(*) as total from game_activity a join public.profiles p on p.id = a.user_id
       where ${where}`, params),
  ]);
  return { bets: rows.rows, total: Number(count.rows[0]?.total ?? 0), page, pageSize: limit };
}
