export const DEPOSIT_BONUS = 5000;
export const BONUS_MIN_DEPOSIT = 5000;
export const BONUS_MULTIPLIER = 30;

// All decisions use server-owned records. The caller locks the profile before
// crediting; the partial unique index also prevents a second lifetime award.
export async function depositBonusEligibility(client, userId) {
  const query = `select campaign.starts_at <= clock_timestamp() and not exists (
       select 1 from public.deposits where user_id = $1::uuid and bonus_amount > 0
     ) and not exists (
       select 1 from public.deposits where user_id = $1::uuid and status = 'verified'
         and coalesce(completed_at, created_at) < campaign.starts_at
     ) as eligible
     from public.deposit_bonus_campaign campaign where singleton = true`;
  let result = await client.query(query, [userId]);
  if (!result.rows.length) {
    // Launch once with the new app, rather than while the SQL is being prepared.
    // The singleton PK serializes concurrent first requests. The runtime role
    // can create this record but cannot update/delete it or restart the offer.
    await client.query("insert into public.deposit_bonus_campaign(singleton) values(true) on conflict(singleton) do nothing");
    result = await client.query(query, [userId]);
  }
  if (!result.rows.length) throw new Error("Deposit bonus launch configuration is unavailable");
  return {
    eligible: result.rows[0].eligible === true,
    bonus: DEPOSIT_BONUS,
    minimum: BONUS_MIN_DEPOSIT,
    multiplier: BONUS_MULTIPLIER,
  };
}

export function depositCreditDetails(amount, bonus = 0) {
  const depositAmount = BigInt(amount);
  const bonusAmount = BigInt(bonus);
  const credited = depositAmount + bonusAmount;
  return {
    depositAmount: Number(depositAmount), bonusAmount: Number(bonusAmount),
    creditedAmount: Number(credited),
    // Requirements can exceed JS's safe integer range. Keep them exact as text.
    wageringRequired: (credited * (bonusAmount > 0n ? 30n : 1n)).toString(),
  };
}
