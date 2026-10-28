// Loss limits are server settings, never values supplied by a player.
function configuredLimit(name, fallback) {
  const value = String(process.env[name] ?? "").trim();
  if (!value) return BigInt(fallback);
  if (!/^[1-9]\d*$/.test(value) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Invalid payout security setting: ${name}`);
  }
  return BigInt(value);
}

export function payoutPolicy() {
  const enabled = String(process.env.WITHDRAWALS_ENABLED ?? "true").trim().toLowerCase();
  if (!["true", "false"].includes(enabled)) throw new Error("Invalid payout security setting: WITHDRAWALS_ENABLED");
  return {
    enabled: enabled === "true",
    maximum: configuredLimit("WITHDRAW_MAX_AMOUNT_MMK", 1000000),
    dailyCount: configuredLimit("WITHDRAW_MAX_PER_DAY", 3),
  };
}

export function payoutBlocked(code) {
  const paused = code === "WITHDRAWALS_PAUSED";
  return {
    ok: false,
    code,
    status: paused ? 503 : 403,
    message: paused
      ? "ငွေထုတ်ခြင်းကို ယာယီရပ်နားထားပါသည်။ ခဏစောင့်ပါ သို့မဟုတ် အကူအညီဌာနသို့ ဆက်သွယ်ပါ။"
      : code === "WITHDRAW_DAILY_LIMIT"
        ? "ယနေ့အတွက် ငွေထုတ်ခွင့် အကြိမ်ရေ ပြည့်သွားပါပြီ။ မနက်ဖြန်မှ ထပ်မံငွေထုတ်နိုင်ပါမည်။"
        : "ငွေထုတ်ကန့်သတ်ပမာဏ ကျော်လွန်နေပါသည်။ ပမာဏကို လျှော့ပါ သို့မဟုတ် အကူအညီဌာနသို့ ဆက်သွယ်ပါ။",
  };
}

export async function checkPayoutLimits(client, policy, userId, amount) {
  if (BigInt(amount) > policy.maximum) return payoutBlocked("WITHDRAW_LIMIT");
  // The caller holds this player's profile lock until the reservation commits.
  // Count reserved funds too: concurrent requests cannot all take the last slot.
  const result = await client.query(
    `select count(*)::text as total from public.withdrawals
      where user_id = $1::uuid and status in ('pending', 'paid')
        and created_at >= (date_trunc('day', statement_timestamp() at time zone 'Asia/Rangoon') at time zone 'Asia/Rangoon')`,
    [userId],
  );
  if (BigInt(result.rows[0].total) >= policy.dailyCount) return payoutBlocked("WITHDRAW_DAILY_LIMIT");
  return null;
}
