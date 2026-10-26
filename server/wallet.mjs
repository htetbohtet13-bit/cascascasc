import { getPool, withTransaction } from "./neon.mjs";
import { paymentConfig } from "./payment-env.mjs";

export function walletMethods() {
  const config = paymentConfig();
  return {
    kbzpay: { label: "KBZPay", receiver: config.kbzReceiver, name: config.kbzName },
    wavepay: { label: "WavePay", receiver: config.waveReceiver, name: config.waveName },
  };
}

export async function applyVerifiedDeposit({
  userId,
  orderId,
  serviceType,
  amount,
  transactionId,
  providerTransactionId,
  depositToken,
}) {
  return withTransaction(async (client) => {
    const existingOrder = await client.query(
      "select user_id, kind, status from public.wallet_orders where order_id = $1",
      [orderId],
    );
    if (existingOrder.rowCount) {
      const order = existingOrder.rows[0];
      if (order.user_id === userId && order.kind === "deposit" && order.status === "verified") {
        const balance = await client.query(
          "select balance from public.profiles where id = $1::uuid",
          [userId],
        );
        return { ok: true, balance: Number(balance.rows[0]?.balance ?? 0), message: "Deposit already added" };
      }
      return { ok: false, message: "Order already used" };
    }

    const profile = await client.query(
      "select balance from public.profiles where id = $1::uuid for update",
      [userId],
    );
    if (!profile.rowCount) return { ok: false, message: "Profile not found" };

    const balance = Number(profile.rows[0].balance) + amount;
    await client.query(
      "update public.profiles set balance = $2 where id = $1::uuid",
      [userId, balance],
    );
    await client.query(
      `insert into public.wallet_orders
         (user_id, kind, service_type, order_id, amount, transaction_id, provider_txn_id, deposit_token, status, message, completed_at)
       values ($1::uuid, 'deposit', $2, $3, $4, $5, nullif($6, ''), nullif($7, ''), 'verified', 'success', now())`,
      [userId, serviceType, orderId, amount, transactionId, providerTransactionId, depositToken],
    );
    return { ok: true, balance, message: "Deposit added" };
  });
}

export async function applyWithdraw({ userId, orderId, serviceType, amount, phone, providerTransactionId }) {
  return withTransaction(async (client) => {
    const existingOrder = await client.query(
      "select user_id, kind, status from public.wallet_orders where order_id = $1",
      [orderId],
    );
    if (existingOrder.rowCount) {
      const order = existingOrder.rows[0];
      if (order.user_id === userId && order.kind === "withdraw" && order.status === "paid") {
        const profile = await client.query(
          "select balance from public.profiles where id = $1::uuid",
          [userId],
        );
        return { ok: true, balance: Number(profile.rows[0]?.balance ?? 0), message: "Transfer Successful" };
      }
      return { ok: false, message: "Order already used" };
    }

    if (providerTransactionId) {
      const reused = await client.query(
        `select user_id, order_id from public.wallet_orders
          where kind = 'withdraw' and status = 'paid' and provider_txn_id = $1`,
        [providerTransactionId],
      );
      if (reused.rowCount) {
        const row = reused.rows[0];
        if (row.user_id === userId) {
          const profile = await client.query(
            "select balance from public.profiles where id = $1::uuid",
            [userId],
          );
          return { ok: true, balance: Number(profile.rows[0]?.balance ?? 0), message: "Transfer Successful" };
        }
        return { ok: false, message: "Transaction already used" };
      }
    }

    const profile = await client.query(
      "select balance from public.profiles where id = $1::uuid for update",
      [userId],
    );
    if (!profile.rowCount) return { ok: false, message: "Profile not found" };
    const currentBalance = Number(profile.rows[0].balance);
    if (currentBalance < amount) return { ok: false, message: "Not enough balance" };

    const balance = currentBalance - amount;
    await client.query(
      "update public.profiles set balance = $2 where id = $1::uuid",
      [userId, balance],
    );
    await client.query(
      `insert into public.wallet_orders
         (user_id, kind, service_type, order_id, amount, payout_phone, provider_txn_id, status, message, completed_at)
       values ($1::uuid, 'withdraw', $2, $3, $4, $5, nullif($6, ''), 'paid', 'Transfer Successful', now())`,
      [userId, serviceType, orderId, amount, phone, providerTransactionId],
    );
    return { ok: true, balance, message: "Transfer Successful" };
  });
}

export async function getProfile(userId) {
  const result = await getPool().query(
    "select phone, balance, game_uid, created_at from public.profiles where id = $1::uuid",
    [userId],
  );
  const profile = result.rows[0];
  return profile ? { ...profile, balance: Number(profile.balance) } : null;
}
