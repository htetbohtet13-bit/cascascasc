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
const providerOf = (value) => {
  const provider = typeof value === "string" ? value.trim().toLowerCase() : "";
  return provider === "wavepay" ? "wave" : provider;
};
const textId = (value) => typeof value === "string" && value.trim().length <= 160 ? value.trim() : "";
const depositCurrencyOf = (value) => {
  if (typeof value !== "string" || value.length > 32) return "";
  // Ignore display-only direction/zero-width marks, never currency letters,
  // punctuation or internal whitespace. Unknown and missing currencies fail.
  const currency = value.replace(/[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g, "").trim().toUpperCase();
  // MyanPay's live verified receipts label Myanmar kyat as "Ks".
  return currency === "KS" ? "MMK" : currency;
};

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

export async function handleWalletProxy({ req, functionName, method = "POST", payload = {}, traceId }) {
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
      const trace = traceId ?? randomUUID();
      const startedAt = Date.now();
      const log = (event, details = {}) => console.info("Deposit processing", { trace_id: trace, event, duration_ms: Date.now() - startedAt, ...details });
      const failure = (status, code, error) => ({ status, body: { error, code, trace_id: trace } });
      const transactionId = String(payload.transaction_id ?? "").replace(/\D/g, "");
      if (!/^\d{6}$/.test(transactionId)) return { status: 400, body: { error: "Enter the last 6 digits" } };
      const receiver = serviceType === "kbzpay" ? config.kbzReceiver : config.waveReceiver;
      if (!config.apiKey || !receiver) return { status: 500, body: { error: "Payment is not configured" } };
      const limited = await consumeRateLimit(req, "deposit-verify", userId);
      if (limited) return limited;
      let response;
      try {
        log("verification_started");
        response = await fetch(paymentUrl, {
          method: "POST",
          redirect: "error",
          // Bank history verification can outlive 30 seconds. Leave headroom
          // inside the 120-second function budget to commit the wallet credit.
          signal: AbortSignal.timeout(90000),
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
        // Log only allowlisted failure categories, never gateway messages,
        // credentials, phone numbers, sender names or transaction identifiers.
        const causes = ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"];
        const cause = causes.includes(error?.cause?.code) ? error.cause.code : "unavailable";
        log("verification_connection_failed", { timed_out: timedOut, cause });
        return failure(timedOut ? 504 : 502, timedOut ? "PAYMENT_CHECK_TIMEOUT" : "PAYMENT_SERVICE_UNREACHABLE", timedOut
              ? "Payment check timed out. Please check the transaction before trying again."
              : "Could not reach the payment service. Please try again.");
      }

      let decoded;
      try { decoded = await response.json(); } catch { decoded = null; }
      const verified = decoded && typeof decoded === "object" && !Array.isArray(decoded) ? decoded : {};
      const tag = String(verified.code ?? verified.message ?? "").trim().toLowerCase();
      const knownTags = ["verified", "not_found", "account_not_connected", "already_verified", "already_processed", "duplicate", "pending", "processing"];
      log("verification_response", { upstream_status: response.status, valid_json_object: decoded !== null && decoded === verified,
        success: verified.success === true, response_tag: knownTags.includes(tag) ? tag : "unrecognized" });
      if (decoded !== verified) {
        return failure(502, "PAYMENT_REPLY_INVALID", "The payment service returned an invalid verification response");
      }
      if (
        !response.ok ||
        verified.success !== true ||
        String(verified.message ?? "").trim().toLowerCase() !== "verified" ||
        !verified.data
      ) {
        const code = String(verified.code ?? verified.message ?? "").toLowerCase();
        if (code === "not_found" || code.includes("not found")) {
          return failure(400, "PAYMENT_NOT_FOUND", "Payment not found. Check the transaction digits and try again.");
        }
        if (code === "account_not_connected") {
          return failure(400, "PAYMENT_ACCOUNT_NOT_CONNECTED", "This payment account is not connected. Please contact support.");
        }
        return failure(response.status >= 500 ? 502 : 400, "PAYMENT_VERIFICATION_REJECTED", "Payment could not be verified. Please check your receipt or contact support.");
      }

      const fullTransactionId = textId(verified.data.transaction_id);
      const paid = verified.data.amount;
      const invalidFields = [];
      if (!fullTransactionId) invalidFields.push("transaction_id_type_or_missing");
      else if (!fullTransactionId.endsWith(transactionId)) invalidFields.push("transaction_id_suffix");
      if (!Number.isSafeInteger(paid) || paid <= 0) invalidFields.push("amount_type_or_range");
      if (typeof verified.data.mode !== "string" || verified.data.mode.trim().toLowerCase() !== "direct") invalidFields.push("mode");
      if (providerOf(verified.data.provider) !== providerOf(serviceType)) invalidFields.push("provider");
      if (typeof verified.data.account !== "string" || phoneOf(verified.data.account) !== phoneOf(receiver)) invalidFields.push("account");
      if (depositCurrencyOf(verified.data.currency) !== "MMK") invalidFields.push("currency");
      if (invalidFields.length) {
        log("verification_fields_rejected", { invalid_fields: invalidFields, field_types: {
          transaction_id: typeof verified.data.transaction_id, amount: typeof paid,
          mode: typeof verified.data.mode, provider: typeof verified.data.provider,
          account: typeof verified.data.account, currency: typeof verified.data.currency,
        }, ...(invalidFields.includes("currency") && typeof verified.data.currency === "string" ? {
          currency_code_points: Array.from(verified.data.currency).slice(0, 16).map((character) => `U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`),
          currency_truncated: Array.from(verified.data.currency).length > 16,
        } : {}) });
        return failure(502, "PAYMENT_VERIFICATION_INCOMPLETE", "The payment service returned an incomplete verification result");
      }
      if (paid !== amount) {
        log("verification_amount_mismatch");
        return failure(400, "PAYMENT_AMOUNT_MISMATCH", "The payment details do not match. Check your receipt and try again.");
      }
      let result;
      try {
        log("wallet_credit_started");
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
        const databaseCodes = ["23505", "23514", "22003", "42501", "42P01", "42703", "40P01", "40001", "57014", "08006"];
        log("wallet_credit_failed", { database_code: databaseCodes.includes(error?.code) ? error.code : "unavailable" });
        if (error?.code === "23505") {
          return { status: 400, body: { error: "This payment has already been added" } };
        }
        return failure(500, "DEPOSIT_CREDIT_FAILED", "Wallet request failed. Please check your wallet history before trying again.");
      }
      log(result.ok ? "wallet_credit_completed" : "wallet_credit_rejected");
      return result.ok ? { status: 200, body: result } : failure(400, "DEPOSIT_CREDIT_REJECTED", result.message);
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
