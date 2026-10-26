import { randomUUID } from "node:crypto";
import { currentSession } from "./auth.mjs";
import { paymentConfig } from "./payment-env.mjs";
import { applyVerifiedDeposit, applyWithdraw, getProfile, walletMethods } from "./wallet.mjs";

const amountOf = (value) => Math.trunc(Number(value));
const phoneOf = (value) => {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (digits.startsWith("95") && digits.length >= 10) digits = `0${digits.slice(2)}`;
  if (/^9\d{8,10}$/.test(digits)) digits = `0${digits}`;
  return digits;
};
const orderId = (prefix) => `${prefix}${randomUUID().replaceAll("-", "")}`.slice(0, 40);

export async function handleWalletProxy({ req, functionName, method = "POST", payload = {} }) {
  const session = await currentSession(req);
  if (!session?.user) return { status: 401, body: { error: "Not authenticated" } };
  const userId = session.user.id;
  const config = paymentConfig();

  if (functionName === "wallet-config") {
    return { status: 200, body: walletMethods() };
  }

  const serviceType = ["kbzpay", "wavepay"].includes(payload.service_type) ? payload.service_type : "";
  const amount = amountOf(payload.amount);
  if (!serviceType) return { status: 400, body: { error: "Choose KBZPay or WavePay" } };
  if (!Number.isSafeInteger(amount) || amount <= 0) return { status: 400, body: { error: "Enter an amount" } };

  try {
    if (functionName === "wallet-deposit") {
      const transactionId = String(payload.transaction_id ?? "").replace(/\D/g, "");
      if (!/^\d{6}$/.test(transactionId)) return { status: 400, body: { error: "Enter the last 6 digits" } };
      const receiver = serviceType === "kbzpay" ? config.kbzReceiver : config.waveReceiver;
      if (!config.apiKey || !receiver) return { status: 500, body: { error: "Payment is not configured" } };
      const id = orderId("DEP");
      const response = await fetch(`${config.apiUrl}/api/verify-transaction`, {
        method: "POST", signal: AbortSignal.timeout(25000),
        headers: { "Content-Type": "application/json", "X-API-Key": config.apiKey },
        body: JSON.stringify({ order_id: id, service_type: serviceType, transaction_id: transactionId, receiver }),
      });
      const verified = await response.json().catch(() => ({}));
      if (verified.message === "Transaction ID already used.") return { status: 400, body: { error: "This transaction was already used" } };
      if (!verified.success || verified.status !== "verified" || !verified.transaction) return { status: 400, body: { error: verified.message ?? "Transaction not found" } };
      const paid = amountOf(verified.transaction.amount);
      if (paid !== amount) return { status: 400, body: { error: `Paid amount is ${paid}, but you entered ${amount}` } };
      const result = await applyVerifiedDeposit({
        userId, orderId: id, serviceType, amount: paid, transactionId,
        providerTransactionId: String(verified.transaction.id ?? ""), depositToken: verified.deposit_token ?? "",
      });
      return result.ok ? { status: 200, body: result } : { status: 400, body: { error: result.message } };
    }

    if (functionName === "wallet-withdraw") {
      const phone = phoneOf(payload.phone);
      if (phone.length < 8) return { status: 400, body: { error: "Enter your KBZPay or WavePay number" } };
      const sender = phoneOf(serviceType === "kbzpay" ? config.kbzReceiver : config.waveReceiver);
      const pin = serviceType === "kbzpay" ? config.kbzPin : config.wavePin;
      if (!config.apiKey || !sender || !pin) return { status: 500, body: { error: "Payment is not configured" } };
      const profile = await getProfile(userId);
      if (!profile) return { status: 400, body: { error: "Profile not found" } };
      if (Number(profile.balance) < amount) return { status: 400, body: { error: "Not enough balance" } };
      let sent;
      try {
        const response = await fetch(`${config.apiUrl}/api/send-money`, {
          method: "POST", signal: AbortSignal.timeout(95000),
          headers: { "Content-Type": "application/json", "X-API-Key": config.apiKey },
          body: JSON.stringify({ serviceType, sender, receiver: phone, amount, pin, description: "J777 withdraw" }),
        });
        sent = await response.json().catch(() => ({}));
      } catch (error) {
        return { status: error?.name === "TimeoutError" || error?.name === "AbortError" ? 504 : 400,
          body: { error: error?.name === "TimeoutError" || error?.name === "AbortError"
            ? "Transfer timed out. Do not try again yet — check KBZPay or WavePay first."
            : "Could not send money" } };
      }
      if (!sent?.success) return { status: 400, body: { error: sent?.message ?? "Transfer failed" } };
      const result = await applyWithdraw({
        userId, orderId: orderId("WD"), serviceType, amount, phone, providerTransactionId: sent.transactionId ?? "",
      });
      if (!result.ok) {
        return { status: 400, body: { error: sent.transactionId
          ? `Money was sent (${sent.transactionId}) but balance was not updated. Do not withdraw again — contact support.`
          : "Transfer sent but balance was not updated" } };
      }
      return { status: 200, body: result };
    }
    return { status: 404, body: { error: "Not found" } };
  } catch (error) {
    return { status: 500, body: { error: error instanceof Error ? error.message : "Wallet request failed" } };
  }
}
