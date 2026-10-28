import { randomUUID } from "node:crypto";
import { currentSession } from "./auth.mjs";
import { paymentConfig } from "./payment-env.mjs";
import { unsafeRequestError } from "./request-security.mjs";
import { consumeRateLimit } from "./rate-limit.mjs";
import { applyVerifiedDeposit, completeWithdraw, recordWithdrawTransfer, releaseWithdraw, reserveWithdraw, walletHistory, walletMethods } from "./wallet.mjs";

const amountOf = (value) => typeof value === "number" ? value : NaN;
const phoneOf = (value) => {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (digits.startsWith("95") && digits.length >= 10) digits = `0${digits.slice(2)}`;
  if (/^9\d{8,10}$/.test(digits)) digits = `0${digits}`;
  return digits;
};
const orderId = (prefix) => `${prefix}${randomUUID().replaceAll("-", "")}`.slice(0, 40);
const providerOf = (value) => value === "wavepay" ? "wave" : value;
const textId = (value) => typeof value === "string" && value.trim().length <= 160 ? value.trim() : "";

function transferMatches(data, { serviceType, amount, phone }) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  // The gateway's response example includes these fields, but does not declare
  // them mandatory. Any supplied evidence must match the reserved transfer.
  return (data.amount === undefined || (typeof data.amount === "number" && data.amount === amount)) &&
    (data.recipient === undefined || (typeof data.recipient === "string" && phoneOf(data.recipient) === phone)) &&
    (data.provider === undefined || providerOf(data.provider) === providerOf(serviceType)) &&
    (data.currency === undefined || data.currency === "MMK") &&
    (data.status === undefined || data.status === "success");
}

function hasTransferEvidence(sent) {
  // Error envelopes have no documented transfer status. Any nonempty status
  // alongside a rejection code is contradictory evidence, not proof of no send.
  const transferStatus = sent?.data?.status;
  return Boolean(sent?.data?.transaction_id) ||
    (transferStatus !== undefined && transferStatus !== null && String(transferStatus).trim() !== "") ||
    /already|duplicate|processed|pending|unknown|time.?out|transfer_success|successful|completed/i.test(String(sent?.message ?? ""));
}

function myanPayExecUrl(baseUrl) {
  const base = String(baseUrl || "https://api.myanpay.cc").replace(/\/+$/, "");
  const url = new URL(base);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || /[\s\x00-\x1f\x7f]/.test(base)) {
    throw new Error("The payment service must use a valid HTTPS URL");
  }
  if (base.endsWith("/api/v1/exec")) return base;
  if (base.endsWith("/api/v1")) return `${base}/exec`;
  return `${base}/api/v1/exec`;
}

export async function handleWalletProxy({ req, functionName, method = "POST", payload = {} }) {
  const requestError = unsafeRequestError(req);
  if (requestError) return requestError;
  const session = await currentSession(req);
  if (!session?.user) return { status: 401, body: { error: "Not authenticated" } };
  const userId = session.user.id;
  const config = paymentConfig();

  if (functionName === "wallet-config") {
    return { status: 200, body: walletMethods() };
  }
  if (functionName === "wallet-history") {
    try {
      return { status: 200, body: { history: await walletHistory(userId) } };
    } catch (error) {
      console.error("Wallet history lookup failed", error);
      return { status: 500, body: { error: "Could not load wallet history" } };
    }
  }

  const serviceType = ["kbzpay", "wavepay"].includes(payload.service_type) ? payload.service_type : "";
  const amount = amountOf(payload.amount);
  if (!serviceType) return { status: 400, body: { error: "Choose KBZPay or WavePay" } };
  if (!Number.isSafeInteger(amount) || amount <= 0) return { status: 400, body: { error: "Enter an amount" } };

  try {
    const paymentUrl = myanPayExecUrl(config.apiUrl);
    if (functionName === "wallet-deposit") {
      const transactionId = String(payload.transaction_id ?? "").replace(/\D/g, "");
      if (!/^\d{6}$/.test(transactionId)) return { status: 400, body: { error: "Enter the last 6 digits" } };
      const receiver = serviceType === "kbzpay" ? config.kbzReceiver : config.waveReceiver;
      if (!config.apiKey || !receiver) return { status: 500, body: { error: "Payment is not configured" } };
      const limited = await consumeRateLimit(req, "deposit-verify", userId);
      if (limited) return limited;
      let response;
      try {
        response = await fetch(paymentUrl, {
          method: "POST",
          redirect: "error",
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
        return { status: response.status >= 500 ? 502 : 400, body: { error: "Payment could not be verified. Please check your receipt or contact support." } };
      }

      const fullTransactionId = textId(verified.data.transaction_id);
      const paid = verified.data.amount;
      if (!fullTransactionId || !fullTransactionId.endsWith(transactionId) ||
          !Number.isSafeInteger(paid) || paid <= 0 || verified.data.mode !== "direct" ||
          providerOf(verified.data.provider) !== providerOf(serviceType) ||
          typeof verified.data.account !== "string" || phoneOf(verified.data.account) !== phoneOf(receiver) ||
          verified.data.currency !== "MMK") {
        return { status: 502, body: { error: "The payment service returned an incomplete verification result" } };
      }
      if (paid !== amount) return { status: 400, body: { error: "The payment details do not match. Check your receipt and try again." } };
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
      if (!/^09\d{8,10}$/.test(phone)) return { status: 400, body: { error: "Enter a valid KBZPay or WavePay number beginning with 09" } };
      const sender = phoneOf(serviceType === "kbzpay" ? config.kbzReceiver : config.waveReceiver);
      const requestId = String(payload.request_id ?? "").toLowerCase();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)) {
        return { status: 400, body: { error: "This page is out of date. Refresh it and try again." } };
      }
      if (!config.apiKey || !sender) return { status: 500, body: { error: "Payment is not configured" } };
      const withdrawOrderId = `WD${requestId.replaceAll("-", "")}`;
      const reserved = await reserveWithdraw({ userId, orderId: withdrawOrderId, serviceType, amount, phone });
      if (!reserved.ok) return {
        status: reserved.status ?? (reserved.code === "WAGERING_REQUIRED" ? 403 : 400),
        body: { error: reserved.message, code: reserved.code, remaining_wagering: reserved.remainingWagering },
      };
      if (reserved.state === "paid") return { status: 200, body: reserved };
      if (reserved.state === "pending") return { status: 202, body: reserved };

      let response;
      try {
        response = await fetch(paymentUrl, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(25000),
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            cmd: "transfer",
            provider: serviceType === "wavepay" ? "wave" : "kbzpay",
            account: sender,
            phone,
            amount,
            note: "payment",
          }),
        });
      } catch (error) {
        return {
          status: error?.name === "TimeoutError" || error?.name === "AbortError" ? 504 : 502,
          body: {
            ok: true,
            state: "pending",
            balance: reserved.balance,
            orderId: withdrawOrderId,
            message: "Your withdrawal is being checked. Do not submit it again; contact support if it stays pending.",
          },
        };
      }

      const sent = await response.json().catch(() => null);
      const message = String(sent?.message ?? "").toLowerCase();
      const code = String(sent?.code ?? "").toLowerCase();
      const definiteFailure = !hasTransferEvidence(sent) && (
        (response.status === 400 && ["bad_phone", "bad_amount", "no_pin", "pin_failed"].includes(code)) ||
        (response.status === 409 && code === "account_not_connected")
      );

      if (response.status === 200 && sent?.success === true && message === "otp_required" &&
          (!code || code === "otp_required") && sent?.data?.otp_required === true && textId(sent?.data?.tx_id) && !hasTransferEvidence(sent)) {
        const failureMessage = "This payment account requires an OTP. OTP withdrawals are not enabled, so no money was sent. Your balance has been returned.";
        const result = await releaseWithdraw({ userId, orderId: withdrawOrderId, message: failureMessage });
        if (!result.ok || result.state !== "failed") return { status: 202, body: { ok: true, state: "pending", balance: result.balance, orderId: withdrawOrderId, message: "Your withdrawal requires reconciliation. Do not submit it again." } };
        return {
          status: 200,
          body: { ok: false, state: "failed", balance: result.balance, safeToRetry: true, message: failureMessage },
        };
      }

      if (response.status === 200 && sent?.success === true && message === "transfer_success") {
        const providerTransactionId = textId(sent?.data?.transaction_id);
        if (!providerTransactionId || (code && code !== "transfer_success") || !transferMatches(sent?.data, { serviceType, amount, phone })) {
          // Preserve evidence even if other fields contradict the reservation;
          // support must reconcile this transfer before it can ever be refunded.
          if (providerTransactionId) {
            await recordWithdrawTransfer({ userId, orderId: withdrawOrderId, providerTransactionId }).catch(() => false);
          }
          return {
            status: 502,
            body: {
              ok: true, state: "pending", balance: reserved.balance, orderId: withdrawOrderId,
              message: "Your withdrawal is being checked. Do not submit it again; contact support if it stays pending.",
            },
          };
        }
        try {
          const recorded = await recordWithdrawTransfer({ userId, orderId: withdrawOrderId, providerTransactionId });
          if (!recorded) {
            return {
              status: 502,
              body: {
                ok: true, state: "pending", balance: reserved.balance, orderId: withdrawOrderId,
                message: `The transfer is being checked (${providerTransactionId}). Do not submit it again; contact support.`,
              },
            };
          }
        } catch {
          return {
            status: 502,
            body: {
              ok: true, state: "pending", balance: reserved.balance, orderId: withdrawOrderId,
              message: `The transfer is being checked (${providerTransactionId}). Do not submit it again; contact support.`,
            },
          };
        }
        let result;
        try {
          result = await completeWithdraw({ userId, orderId: withdrawOrderId, providerTransactionId });
        } catch {
          return {
            status: 502,
            body: {
              ok: true, state: "pending", balance: reserved.balance, orderId: withdrawOrderId,
              message: "The transfer is being checked. Do not submit it again; contact support.",
            },
          };
        }
        if (!result.ok) {
          return {
            status: 502,
            body: {
              ok: true, state: "pending", balance: reserved.balance, orderId: withdrawOrderId,
              message: "The transfer is being checked. Do not submit it again; contact support.",
            },
          };
        }
        return { status: 200, body: result };
      }

      if (sent?.success === false && definiteFailure) {
        const failureMessage = "The payment service rejected this transfer. Your balance has been returned.";
        const result = await releaseWithdraw({ userId, orderId: withdrawOrderId, message: failureMessage });
        if (!result.ok || result.state !== "failed") return { status: 202, body: { ok: true, state: "pending", balance: result.balance, orderId: withdrawOrderId, message: "Your withdrawal requires reconciliation. Do not submit it again." } };
        return {
          status: 200,
          body: {
            ok: false,
            state: "failed",
            balance: result.balance,
            safeToRetry: true,
            message: failureMessage,
          },
        };
      }

      // Even an error envelope can report that money moved. Save that evidence
      // so later recovery code cannot treat this as an unsent reservation.
      const reportedTransactionId = textId(sent?.data?.transaction_id);
      if (reportedTransactionId) {
        await recordWithdrawTransfer({ userId, orderId: withdrawOrderId, providerTransactionId: reportedTransactionId }).catch(() => false);
      }
      // Unknown replies are treated as ambiguous: keep the reservation to prevent a duplicate payout.
      return {
        status: 202,
        body: {
          ok: true,
          state: "pending",
          balance: reserved.balance,
          orderId: withdrawOrderId,
          message: "Your withdrawal is being checked. Do not submit it again; contact support if it stays pending.",
        },
      };
    }
    return { status: 404, body: { error: "Not found" } };
  } catch (error) {
    console.error("Wallet request failed", { code: typeof error?.code === "string" ? error.code : "unavailable" });
    return { status: 500, body: { error: "Wallet request failed. Please check your wallet history before trying again." } };
  }
}
