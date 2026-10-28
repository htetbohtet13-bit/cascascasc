import { processSkmWalletCallback } from "../server/skm-wallet.mjs";
import { signedSkmResponse, verifySkmRequest } from "../server/skm-api.mjs";
import { checkedBody, readRequestBody, RequestBodyError } from "../server/request-body.mjs";

function sendSigned(res, statusCode, body) {
  try {
    const signed = signedSkmResponse(body);
    for (const [name, value] of Object.entries(signed.headers)) res.setHeader(name, value);
    res.status(statusCode);
    return res.end(signed.rawBody);
  } catch (error) {
    console.error("Unable to sign provider wallet response", error);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.status(503).end(JSON.stringify({ status: "ERROR" }));
  }
}

function responseStatus(status) {
  if (status === "OK" || status === "DUPLICATE") return 200;
  if (status === "INSUFFICIENT_FUNDS") return 409;
  if (status === "INVALID_TOKEN" || status === "TOKEN_EXPIRED") return 401;
  if (status === "ERROR") return 500;
  return 422;
}

export async function handleSkmWallet(req, res, route, providedRawBody) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return sendSigned(res, 405, { status: "ERROR", message: "POST required" });
  }

  let rawBody;
  try {
    rawBody = providedRawBody === undefined ? await readRequestBody(req, { timeoutMs: 4_000, allowParsed: false }) : checkedBody(providedRawBody);
  } catch (error) {
    console.warn("Provider wallet request rejected", error?.message);
    res.setHeader("Connection", "close");
    const status = error instanceof RequestBodyError ? error.status : 400;
    return sendSigned(res, status, { status: "ERROR", message: error instanceof RequestBodyError ? error.message : "Could not read request body" });
  }

  let verification;
  try {
    verification = verifySkmRequest({ headers: req.headers, rawBody });
  } catch (error) {
    console.error("Provider wallet authentication is not configured", error);
    return sendSigned(res, 503, { status: "ERROR", message: "Wallet authentication is not configured" });
  }
  if (!verification.ok) {
    const statusCode = verification.reason === "EXPIRED_REQUEST" ? 401 : 401;
    return sendSigned(res, statusCode, { status: "ERROR", message: verification.reason });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return sendSigned(res, 422, { status: "ERROR", message: "Invalid JSON body" });
  }

  try {
    const result = await processSkmWalletCallback(route, payload, rawBody);
    return sendSigned(res, responseStatus(result.status), result);
  } catch (error) {
    console.error(`Provider wallet ${route} failed`, error);
    return sendSigned(res, 500, { status: "ERROR", message: "Wallet request failed" });
  }
}
