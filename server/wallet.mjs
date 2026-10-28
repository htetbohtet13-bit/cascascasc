import { getPool, withTransaction } from "./neon.mjs";
import { paymentConfig } from "./payment-env.mjs";

export function walletMethods() {
  const config = paymentConfig();
  return {
    kbzpay: { label: "KBZPay", receiver: config.kbzReceiver, name: config.kbzName },
    wavepay: { label: "WavePay", receiver: config.waveReceiver, name: config.waveName },
  };
}

export async function walletHistory(userId) {
  const result = await getPool().query(
    `select 'deposit'::text as kind, service_type, amount, status, message, created_at, completed_at
       from public.deposits where user_id = $1::uuid
     union all
     select 'withdraw'::text as kind, service_type, amount, status, message, created_at, completed_at
       from public.withdrawals where user_id = $1::uuid
      order by created_at desc
      limit 50`,
    [userId],
  );
  return result.rows;
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
      "select user_id, status from public.deposits where order_id = $1 for update",
      [orderId],
    );
    if (existingOrder.rowCount) {
      const order = existingOrder.rows[0];
      if (order.user_id === userId && order.status === "verified") {
        const balance = await client.query(
          "select balance from public.profiles where id = $1::uuid",
          [userId],
        );
        return { ok: true, balance: Number(balance.rows[0]?.balance ?? 0), message: "Deposit already added" };
      }
      return { ok: false, message: "Order already used" };
    }

    const existingTransaction = await client.query(
      "select user_id from public.deposits where transaction_id = $1",
      [transactionId],
    );
    if (existingTransaction.rowCount) return { ok: false, message: "This payment has already been added" };

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
      `insert into public.deposits
         (user_id, service_type, order_id, amount, transaction_id, provider_txn_id, deposit_token, status, message, completed_at)
       values ($1::uuid, $2, $3, $4, $5, nullif($6, ''), nullif($7, ''), 'verified', 'success', now())`,
      [userId, serviceType, orderId, amount, transactionId, providerTransactionId, depositToken],
    );
    return { ok: true, balance, message: "Deposit added" };
  });
}

async function currentBalance(client, userId) {
  const result = await client.query(
    "select balance from public.profiles where id = $1::uuid",
    [userId],
  );
  return Number(result.rows[0]?.balance ?? 0);
}

export async function reserveWithdraw({ userId, orderId, serviceType, amount, phone }) {
  return withTransaction(async (client) => {
    const existingOrder = await client.query(
      `select user_id, service_type, amount, payout_phone, status
         from public.withdrawals where order_id = $1 for update`,
      [orderId],
    );
    if (existingOrder.rowCount) {
      const order = existingOrder.rows[0];
      if (
        order.user_id !== userId ||
        order.service_type !== serviceType || Number(order.amount) !== amount ||
        order.payout_phone !== phone
      ) return { ok: false, message: "This withdrawal request reference was already used" };

      const balance = await currentBalance(client, userId);
      if (order.status === "paid") return { ok: true, state: "paid", balance, message: "Transfer Successful" };
      if (order.status === "pending") return { ok: true, state: "pending", balance, message: "This withdrawal is still being checked", orderId };
      return { ok: false, state: "failed", balance, message: "This withdrawal was not completed. Please submit it again." };
    }

    const profile = await client.query(
      "select balance from public.profiles where id = $1::uuid for update",
      [userId],
    );
    if (!profile.rowCount) return { ok: false, message: "Profile not found" };

    // Another request with this same id may have reserved while we waited on the profile lock.
    const retriedOrder = await client.query(
      `select user_id, service_type, amount, payout_phone, status
         from public.withdrawals where order_id = $1 for update`,
      [orderId],
    );
    if (retriedOrder.rowCount) {
      const order = retriedOrder.rows[0];
      if (
        order.user_id !== userId ||
        order.service_type !== serviceType || Number(order.amount) !== amount ||
        order.payout_phone !== phone
      ) return { ok: false, message: "This withdrawal request reference was already used" };
      const balance = Number(profile.rows[0].balance);
      if (order.status === "paid") return { ok: true, state: "paid", balance, message: "Transfer Successful" };
      if (order.status === "pending") return { ok: true, state: "pending", balance, message: "This withdrawal is still being checked", orderId };
      return { ok: false, state: "failed", balance, message: "This withdrawal was not completed. Please submit it again." };
    }

    // Serialize each player's reservations so a second payout cannot race an unresolved one.
    const pending = await client.query(
      `select order_id from public.withdrawals
        where user_id = $1::uuid and status = 'pending'
        order by created_at desc limit 1`,
      [userId],
    );
    if (pending.rowCount) {
      return {
        ok: true,
        state: "pending",
        balance: Number(profile.rows[0].balance),
        message: "A withdrawal is still being checked. Do not submit another one.",
        orderId: pending.rows[0].order_id,
      };
    }

    const currentBalance = Number(profile.rows[0].balance);
    if (currentBalance < amount) return { ok: false, message: "Not enough balance" };

    const balance = currentBalance - amount;
    await client.query(
      "update public.profiles set balance = $2 where id = $1::uuid",
      [userId, balance],
    );
    await client.query(
      `insert into public.withdrawals
         (user_id, service_type, order_id, amount, payout_phone, status, message)
       values ($1::uuid, $2, $3, $4, $5, 'pending', 'Transfer reserved')`,
      [userId, serviceType, orderId, amount, phone],
    );
    return { ok: true, state: "reserved", balance, orderId };
  });
}

export async function releaseWithdraw({ userId, orderId, message }) {
  return withTransaction(async (client) => {
    const order = await client.query(
      `select user_id, amount, status from public.withdrawals
        where order_id = $1 for update`,
      [orderId],
    );
    if (!order.rowCount || order.rows[0].user_id !== userId) {
      return { ok: false, message: "Withdrawal request not found" };
    }
    if (order.rows[0].status === "failed") {
      return { ok: true, state: "failed", balance: await currentBalance(client, userId) };
    }
    if (order.rows[0].status === "paid") {
      return { ok: false, state: "paid", balance: await currentBalance(client, userId) };
    }

    const restored = await client.query(
      `update public.profiles set balance = balance + $2
        where id = $1::uuid returning balance`,
      [userId, Number(order.rows[0].amount)],
    );
    await client.query(
      `update public.withdrawals
          set status = 'failed', message = $2, completed_at = now()
        where order_id = $1`,
      [orderId, message],
    );
    return { ok: true, state: "failed", balance: Number(restored.rows[0]?.balance ?? 0) };
  });
}

export async function recordWithdrawTransfer({ userId, orderId, providerTransactionId }) {
  return withTransaction(async (client) => {
    const order = await client.query(
      `select user_id, status from public.withdrawals
        where order_id = $1 for update`,
      [orderId],
    );
    if (!order.rowCount || order.rows[0].user_id !== userId) return false;
    if (order.rows[0].status === "paid") return true;
    if (order.rows[0].status !== "pending") return false;
    await client.query(
      `update public.withdrawals
          set provider_txn_id = nullif($2, ''), message = 'Provider confirmed transfer; wallet update pending'
        where order_id = $1`,
      [orderId, providerTransactionId],
    );
    return true;
  });
}

export async function completeWithdraw({ userId, orderId, providerTransactionId }) {
  return withTransaction(async (client) => {
    const order = await client.query(
      `select user_id, status from public.withdrawals
        where order_id = $1 for update`,
      [orderId],
    );
    if (!order.rowCount || order.rows[0].user_id !== userId) {
      return { ok: false, message: "Withdrawal request not found" };
    }
    if (order.rows[0].status === "paid") {
      return { ok: true, state: "paid", balance: await currentBalance(client, userId), message: "Transfer Successful" };
    }
    if (order.rows[0].status !== "pending") {
      return { ok: false, state: order.rows[0].status, message: "Withdrawal is no longer pending" };
    }
    await client.query(
      `update public.withdrawals
          set status = 'paid', provider_txn_id = nullif($2, ''),
              message = 'Transfer Successful', completed_at = now()
        where order_id = $1`,
      [orderId, providerTransactionId],
    );
    return {
      ok: true,
      state: "paid",
      balance: await currentBalance(client, userId),
      message: "Transfer Successful",
    };
  });
}

export async function getProfile(userId) {
  const result = await getPool().query(
    "select phone, balance, created_at from public.profiles where id = $1::uuid",
    [userId],
  );
  const profile = result.rows[0];
  return profile ? { ...profile, balance: Number(profile.balance) } : null;
}
