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

function myanPayExecUrl(baseUrl) {
  const base = String(baseUrl || "https://api.myanpay.cc").replace(/\/+$/, "");
  if (base.endsWith("/api/v1/exec")) return base;
  if (base.endsWith("/api/v1")) return `${base}/exec`;
  return `${base}/api/v1/exec`;
}

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
      let response;
      try {
        response = await fetch(myanPayExecUrl(config.apiUrl), {
          method: "POST",
          signal: AbortSignal.timeout(30000),
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            cmd: "verify_direct",
            provider: serviceType === "wavepay" ? "wave" : "kbzpay",
            account: phoneOf(receiver),
            digits: transactionId,
          }),
        });
      } catch (error) {
        const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
        return {
          status: timedOut ? 504 : 502,
          body: {
            error: timedOut
              ? "Payment check timed out. Please check the transaction before trying again."
              : "Could not reach the payment service. Please try again.",
          },
        };
      }

      const verified = await response.json().catch(() => ({}));
      if (
        !response.ok ||
        verified.success !== true ||
        String(verified.message ?? "").toLowerCase() !== "verified" ||
        !verified.data
      ) {
        const code = String(verified.code ?? verified.message ?? "").toLowerCase();
        if (code === "not_found" || code.includes("not found")) {
          return { status: 400, body: { error: "Payment not found. Check the transaction digits and try again." } };
        }
        if (code === "account_not_connected") {
          return { status: 400, body: { error: "This payment account is not connected. Please contact support." } };
        }
        return { status: response.status >= 500 ? 502 : 400, body: { error: verified.message ?? "Payment could not be verified" } };
      }

      const fullTransactionId = String(verified.data.transaction_id ?? "").trim();
      const paid = amountOf(verified.data.amount);
      if (!fullTransactionId || !Number.isSafeInteger(paid) || paid <= 0) {
        return { status: 502, body: { error: "The payment service returned an incomplete verification result" } };
      }
      if (paid !== amount) return { status: 400, body: { error: `Paid amount is ${paid}, but you entered ${amount}` } };
      let result;
      try {
        result = await applyVerifiedDeposit({
          userId,
          orderId: orderId("DEP"),
          serviceType,
          amount: paid,
          transactionId: fullTransactionId,
          providerTransactionId: fullTransactionId,
          depositToken: "",
        });
      } catch (error) {
        if (error?.code === "23505") {
          return { status: 400, body: { error: "This payment has already been added" } };
        }
        throw error;
      }
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
