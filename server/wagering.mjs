const FIVE_TIMES_HOLD_GAMES = new Set(["shankoemee", "shankoemee3d", "bugyee", "abcd"]);

// Card games reserve up to 5x the stake. Slot feature purchases, however,
// wager the full debit amount, even when the callback also includes a base stake.
export function wageredStake(payload) {
  if (payload.reason !== "BET_HOLD") return 0;
  const amount = payload.amount;
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Invalid wager amount");
  if (!FIVE_TIMES_HOLD_GAMES.has(payload.game_code)) return amount;
  const stake = payload.stake ?? amount / 5;
  if (!Number.isSafeInteger(stake) || stake <= 0 || stake !== amount / 5) {
    throw new Error("Invalid wager stake");
  }
  return stake;
}

// Events are ordered by when the deposit or bet was accepted, not by when a
// settlement arrived. Clamping at zero stops old excess bets prepaying deposits.
export function remainingWagering(events) {
  let remaining = 0n;
  for (const event of events) {
    if (event.kind === "RESET") remaining = 0n;
    else if (event.kind === "DEPOSIT") remaining += BigInt(event.amount);
    else if (event.kind === "BET" && event.state === "SETTLED") {
      remaining = remaining > BigInt(event.amount) ? remaining - BigInt(event.amount) : 0n;
    }
  }
  return remaining;
}

export function wageringMessage(remaining) {
  return `ငွေထုတ်ရန် နောက်ထပ် ${BigInt(remaining).toLocaleString("my-MM")} ကျပ် လောင်းကစားရန် လိုအပ်ပါသည်။`;
}

// Callers hold the player's profile lock throughout this tracker's operations.
// Missing protection must stop money movement instead of silently waiving turnover.
export async function wageringTracker(client, userId) {
  const ready = await client.query("select to_regclass('public.wallet_wagering_events') is not null as enabled");
  const enabled = ready.rows[0]?.enabled === true;
  if (!enabled) {
    const error = new Error("Wagering security storage is unavailable");
    error.code = "WAGERING_STORAGE_UNAVAILABLE";
    throw error;
  }

  async function record(kind, amount, sourceId, state = "SETTLED") {
    await client.query(
      `insert into public.wallet_wagering_events (user_id, kind, amount, source_id, state)
       values ($1::uuid, $2, $3, $4, $5)
       on conflict (kind, source_id) do nothing`,
      [userId, kind, String(amount), sourceId, state],
    );
  }

  async function closeBet(debitId, state) {
    await client.query(
      `update public.wallet_wagering_events set state = $3
        where user_id = $1::uuid and kind = 'BET' and source_id = $2 and state = 'PENDING'`,
      [userId, debitId, state],
    );
  }

  async function resetIfEmpty(balance, sourceId) {
    if (BigInt(balance) !== 0n) return;
    const outstanding = await client.query(
      `select
         exists (select 1 from public.skm_wallet_transactions
                  where user_id = $1::uuid and kind = 'DEBIT' and status = 'APPLIED') as game_hold,
         exists (select 1 from public.withdrawals
                  where user_id = $1::uuid and status = 'pending') as withdrawal_hold`,
      [userId],
    );
    if (outstanding.rows[0]?.game_hold || outstanding.rows[0]?.withdrawal_hold) return;
    await record("RESET", 0, sourceId);
  }

  async function remaining() {
    const result = await client.query(
      `select kind, amount, state from public.wallet_wagering_events
        where user_id = $1::uuid
          and id > coalesce((select id from public.wallet_wagering_events
                             where user_id = $1::uuid and kind = 'RESET'
                             order by id desc limit 1), 0)
        order by id`,
      [userId],
    );
    return remainingWagering(result.rows);
  }

  return {
    addDeposit: (amount, orderId) => record("DEPOSIT", amount, orderId),
    addBet: (amount, debitId) => record("BET", amount, debitId, "PENDING"),
    settleBet: (debitId) => closeBet(debitId, "SETTLED"),
    cancelBet: (debitId) => closeBet(debitId, "CANCELLED"),
    resetIfEmpty,
    remaining,
  };
}
