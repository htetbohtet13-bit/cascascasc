import { getPool } from "./neon.mjs";

export const BANK_UNAVAILABLE_MESSAGE = "ဤဘဏ်ကို ယာယီအသုံးပြု၍မရပါ။ အခြားဘဏ်ကို ရွေးပါ သို့မဟုတ် ခဏစောင့်ပြီး ပြန်လည်ကြိုးစားပါ။";

// Hold this shared lock only for the short reservation transaction. Turning a
// bank off waits for reservations already accepted, never for a payment API call.
export async function lockBankAvailability(client, serviceType) {
  const result = await client.query(
    "select is_enabled from public.deposit_bank_settings where service_type = $1 for share", [serviceType],
  );
  if (result.rows.length !== 1 || typeof result.rows[0].is_enabled !== "boolean") throw new Error("Bank settings are unavailable");
  return result.rows[0].is_enabled;
}

export async function readDepositBanks(pool = getPool()) {
  const result = await pool.query("select service_type, is_enabled, updated_at from public.deposit_bank_settings");
  const banks = {};
  for (const row of result.rows) {
    if (!["kbzpay", "wavepay"].includes(row.service_type) || typeof row.is_enabled !== "boolean") {
      throw new Error("Invalid deposit bank settings");
    }
    banks[row.service_type] = { enabled: row.is_enabled, updated_at: row.updated_at };
  }
  // A missing row or unavailable storage must not silently reopen a paused bank.
  if (!banks.kbzpay || !banks.wavepay) throw new Error("Incomplete deposit bank settings");
  return banks;
}

export async function setDepositBank(body) {
  if (!["kbzpay", "wavepay"].includes(body?.service_type) || typeof body?.enabled !== "boolean") {
    return { status: 400, body: { error: "Choose a valid bank and an on/off value" } };
  }
  // Set an explicit state so retrying a request cannot invert the switch again.
  const result = await getPool().query(
    `update public.deposit_bank_settings set is_enabled = $2, updated_at = clock_timestamp()
      where service_type = $1 returning service_type`, [body.service_type, body.enabled],
  );
  if (result.rowCount !== 1) throw new Error("Deposit bank settings are unavailable");
  return { status: 200, body: { ok: true, banks: await readDepositBanks() } };
}
