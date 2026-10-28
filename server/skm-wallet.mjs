import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getPool, withTransaction } from "./neon.mjs";
import { wageredStake, wageringTracker } from "./wagering.mjs";
import { addMoney, moneyNumber, subtractMoney } from "./money.mjs";

const CURRENCY = "MMK";
const MAX_AMOUNT = Number.MAX_SAFE_INTEGER;

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function cleanText(value, maxLength = 200) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text && text.length <= maxLength ? text : "";
}

function integerAmount(value, allowZero) {
  if (typeof value !== "number") return null;
  const amount = value;
  if (!Number.isSafeInteger(amount) || amount > MAX_AMOUNT || amount < (allowZero ? 0 : 1)) return null;
  return amount;
}

function safeBalance(value) {
  try {
    return moneyNumber(value);
  } catch {
    return null;
  }
}

function commonFields(payload) {
  const playerId = cleanText(payload.player_id, 64);
  const token = cleanText(payload.token, 256);
  const currency = cleanText(payload.currency, 3);
  const roundId = cleanText(payload.round_id, 160);
  const gameCode = cleanText(payload.game_code, 80);
  const transactionId = cleanText(payload.transaction_id, 160);
  if (!playerId || !token || !currency || !transactionId || !roundId || !gameCode) return null;
  return { playerId, token, currency, roundId, gameCode, transactionId };
}

export async function createSkmGameSession(userId) {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = digest(token);
  return withTransaction(async (client) => {
    const profile = await client.query(
      "select id from public.profiles where id = $1::uuid for update",
      [userId],
    );
    if (!profile.rowCount) throw new Error("Player profile not found");
    await client.query(
      `update public.skm_game_sessions set is_active = false
        where user_id = $1::uuid and is_active = true`,
      [userId],
    );
    await client.query(
      `insert into public.skm_game_sessions (user_id, token_hash, expires_at)
       values ($1::uuid, $2, now() + interval '24 hours')`,
      [userId, tokenHash],
    );
    const playerId = String(profile.rows[0].id);
    return {
      player_id: playerId,
      player_name: `Player ${playerId.slice(-6)}`,
      token,
    };
  });
}

async function findPlayer(client, fields, { requireActive = false, lock = false } = {}) {
  const result = await client.query(
    `select p.id, p.balance, s.is_active,
            (s.expires_at <= now()) as is_expired
       from public.skm_game_sessions s
       join public.profiles p on p.id = s.user_id
      where s.user_id::text = $1 and s.token_hash = $2
      ${lock ? "for update of p" : ""}`,
    [fields.playerId, digest(fields.token)],
  );
  if (!result.rowCount) return { error: "INVALID_TOKEN" };
  const player = result.rows[0];
  if (requireActive && (!player.is_active || player.is_expired)) return { error: "TOKEN_EXPIRED", player };
  return { player };
}

function response(status, fields, extra = {}) {
  const balance = fields?.balance == null ? null : safeBalance(fields.balance);
  return {
    status,
    balance: balance === null ? undefined : balance,
    currency: CURRENCY,
    ...extra,
  };
}

function validateCurrency(fields) {
  return fields.currency === CURRENCY;
}

function eventFields(payload, kind) {
  // A rollback has the same reason/amount as its debit. Reject its reference
  // on the debit route because the provider signs the body, not the URL.
  if (kind === "DEBIT" && Object.hasOwn(payload, "debit_transaction_id")) return null;
  const common = commonFields(payload);
  const amount = integerAmount(payload.amount, kind === "CREDIT");
  const reason = cleanText(payload.reason, 40);
  const expectedReasons = kind === "DEBIT"
    ? ["BET_HOLD", "BANK_DEPOSIT"]
    : kind === "CREDIT"
      ? ["BET_SETTLE", "BANK_RETURN"]
      : ["BET_HOLD", "BANK_DEPOSIT"];
  if (!common || amount === null || !expectedReasons.includes(reason) || !validateCurrency(common)) return null;
  if (kind === "CREDIT" && payload.round_closed !== true) return null;
  if (kind !== "DEBIT" && kind !== "CREDIT" && kind !== "ROLLBACK") return null;
  const debitTransactionId = kind === "CREDIT" || kind === "ROLLBACK"
    ? cleanText(payload.debit_transaction_id, 160)
    : "";
  if ((kind === "CREDIT" || kind === "ROLLBACK") && !debitTransactionId) return null;
  return { ...common, amount, reason, debitTransactionId };
}

async function priorTransaction(client, fields) {
  return client.query(
    `select id, user_id, kind, status, payload_hash, balance_after
       from public.skm_wallet_transactions where transaction_id = $1`,
    [fields.transactionId],
  );
}

function duplicateResult(row, userId, fields, balance, expectedKind) {
  if (row.kind !== expectedKind || row.user_id !== userId || row.payload_hash !== digest(fields.rawBody)) {
    return response("ERROR", { balance }, { message: "Transaction ID was already used with different details" });
  }
  return response("DUPLICATE", { balance }, { operator_transaction_id: row.id });
}

async function recordTransaction(client, fields, kind, status, balanceAfter) {
  const id = randomUUID();
  await client.query(
    `insert into public.skm_wallet_transactions
       (id, transaction_id, user_id, player_id, currency, kind, reason, amount,
        round_id, game_code, debit_transaction_id, payload_hash, status, balance_after)
     values ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10, nullif($11, ''), $12, $13, $14)`,
    [id, fields.transactionId, fields.userId, fields.playerId, fields.currency, kind,
      fields.reason, fields.amount, fields.roundId, fields.gameCode, fields.debitTransactionId ?? "",
      digest(fields.rawBody), status, balanceAfter],
  );
  return id;
}

async function balanceRequest(payload) {
  const fields = {
    playerId: cleanText(payload.player_id, 64),
    token: cleanText(payload.token, 256),
    currency: cleanText(payload.currency, 3),
  };
  if (!fields.playerId || !fields.token || !fields.currency || !validateCurrency(fields)) {
    return response("ERROR", null, { message: "Invalid balance request" });
  }
  const result = await getPool().query(
    `select p.id, p.balance, s.is_active, (s.expires_at <= now()) as is_expired
       from public.skm_game_sessions s
       join public.profiles p on p.id = s.user_id
      where s.user_id::text = $1 and s.token_hash = $2`,
    [fields.playerId, digest(fields.token)],
  );
  if (!result.rowCount) return response("INVALID_TOKEN", null);
  const player = result.rows[0];
  if (!player.is_active || player.is_expired) return response("TOKEN_EXPIRED", player);
  const balance = safeBalance(player.balance);
  if (balance === null) return response("ERROR", null, { message: "Balance exceeds supported range" });
  return response("OK", { balance });
}

async function debitRequest(payload, rawBody) {
  const fields = eventFields(payload, "DEBIT");
  if (!fields) return response("ERROR", null, { message: "Invalid debit request" });
  let stake;
  try {
    stake = wageredStake({ ...payload, game_code: fields.gameCode, reason: fields.reason, amount: fields.amount });
  } catch {
    return response("ERROR", null, { message: "Invalid wager stake" });
  }
  fields.rawBody = rawBody;
  return withTransaction(async (client) => {
    const identity = await findPlayer(client, fields, { requireActive: true, lock: true });
    if (!identity.player) return response(identity.error, null);
    const player = identity.player;
    if (player.is_expired || !player.is_active) return response("TOKEN_EXPIRED", player);

    const prior = await priorTransaction(client, fields);
    if (prior.rowCount) return duplicateResult(prior.rows[0], player.id, fields, player.balance, "DEBIT");
    const rolledBackFirst = await client.query(
      `select id from public.skm_wallet_transactions
        where debit_transaction_id = $1 and kind = 'ROLLBACK' and status = 'TOMBSTONE'
        limit 1`,
      [fields.transactionId],
    );
    if (rolledBackFirst.rowCount) return response("ERROR", player, { message: "Debit was rolled back before it arrived" });

    const balance = safeBalance(player.balance);
    if (balance === null) return response("ERROR", null, { message: "Balance exceeds supported range" });
    if (balance < fields.amount) return response("INSUFFICIENT_FUNDS", player);
    const nextBalance = subtractMoney(balance, fields.amount);
    await client.query("update public.profiles set balance = $2 where id = $1::uuid", [player.id, nextBalance]);
    fields.userId = player.id;
    const transactionId = await recordTransaction(client, fields, "DEBIT", "APPLIED", nextBalance);
    if (stake > 0) {
      const wagering = await wageringTracker(client, player.id);
      await wagering.addBet(stake, fields.transactionId);
    }
    return response("OK", { balance: nextBalance }, { operator_transaction_id: transactionId });
  });
}

async function creditRequest(payload, rawBody) {
  const fields = eventFields(payload, "CREDIT");
  if (!fields) return response("ERROR", null, { message: "Invalid credit request" });
  fields.rawBody = rawBody;
  return withTransaction(async (client) => {
    const identity = await findPlayer(client, fields, { lock: true });
    if (!identity.player) return response(identity.error, null);
    const player = identity.player;
    const prior = await priorTransaction(client, fields);
    if (prior.rowCount) return duplicateResult(prior.rows[0], player.id, fields, player.balance, "CREDIT");

    const debit = await client.query(
      `select id, user_id, amount, status, reason, round_id, game_code, currency
         from public.skm_wallet_transactions
        where transaction_id = $1 and kind = 'DEBIT' and user_id = $2::uuid
        for update`,
      [fields.debitTransactionId, player.id],
    );
    if (!debit.rowCount || debit.rows[0].user_id !== player.id || debit.rows[0].status !== "APPLIED") {
      return response("ERROR", player, { message: "Debit transaction is missing or already closed" });
    }
    const original = debit.rows[0];
    if (original.round_id !== fields.roundId || original.game_code !== fields.gameCode || original.currency !== fields.currency ||
        (original.reason === "BET_HOLD" ? "BET_SETTLE" : "BANK_RETURN") !== fields.reason) {
      return response("ERROR", player, { message: "Settlement details do not match the debit" });
    }
    const closed = await client.query(
      `select id from public.skm_wallet_transactions
        where debit_transaction_id = $1 and kind in ('CREDIT', 'ROLLBACK') limit 1`,
      [fields.debitTransactionId],
    );
    if (closed.rowCount) return response("ERROR", player, { message: "Debit transaction is already closed" });

    const balance = safeBalance(player.balance);
    if (balance === null) return response("ERROR", null, { message: "Balance exceeds supported range" });
    let nextBalance;
    try { nextBalance = addMoney(balance, fields.amount); }
    catch { return response("ERROR", player, { message: "Balance exceeds supported range" }); }
    await client.query("update public.profiles set balance = $2 where id = $1::uuid", [player.id, nextBalance]);
    await client.query(
      `update public.skm_wallet_transactions set status = 'SETTLED' where id = $1::uuid`,
      [debit.rows[0].id],
    );
    fields.userId = player.id;
    const transactionId = await recordTransaction(client, fields, "CREDIT", "APPLIED", nextBalance);
    const wagering = await wageringTracker(client, player.id);
    await wagering.settleBet(fields.debitTransactionId);
    await wagering.resetIfEmpty(nextBalance, `credit:${fields.transactionId}`);
    return response("OK", { balance: nextBalance }, { operator_transaction_id: transactionId });
  });
}

async function rollbackRequest(payload, rawBody) {
  const fields = eventFields(payload, "ROLLBACK");
  if (!fields) return response("ERROR", null, { message: "Invalid rollback request" });
  fields.rawBody = rawBody;
  return withTransaction(async (client) => {
    const identity = await findPlayer(client, fields, { lock: true });
    if (!identity.player) return response(identity.error, null);
    const player = identity.player;
    const prior = await priorTransaction(client, fields);
    if (prior.rowCount) return duplicateResult(prior.rows[0], player.id, fields, player.balance, "ROLLBACK");

    const closed = await client.query(
      `select id from public.skm_wallet_transactions
        where debit_transaction_id = $1 and kind in ('CREDIT', 'ROLLBACK') limit 1`,
      [fields.debitTransactionId],
    );
    if (closed.rowCount) return response("ERROR", player, { message: "Debit transaction is already closed" });

    const debit = await client.query(
      `select id, user_id, amount, status, reason, round_id, game_code, currency
         from public.skm_wallet_transactions
        where transaction_id = $1 and kind = 'DEBIT'
        for update`,
      [fields.debitTransactionId],
    );
    if (debit.rowCount && (
      debit.rows[0].user_id !== player.id || debit.rows[0].status !== "APPLIED" ||
      moneyNumber(debit.rows[0].amount) !== fields.amount || debit.rows[0].reason !== fields.reason ||
      debit.rows[0].round_id !== fields.roundId || debit.rows[0].game_code !== fields.gameCode || debit.rows[0].currency !== fields.currency
    )) {
      return response("ERROR", player, { message: "Debit transaction cannot be rolled back" });
    }

    let nextBalance = safeBalance(player.balance);
    if (nextBalance === null) return response("ERROR", null, { message: "Balance exceeds supported range" });
    let status = "TOMBSTONE";
    if (debit.rowCount) {
      try { nextBalance = addMoney(nextBalance, fields.amount); }
      catch { return response("ERROR", player, { message: "Balance exceeds supported range" }); }
      await client.query("update public.profiles set balance = $2 where id = $1::uuid", [player.id, nextBalance]);
      await client.query(
        "update public.skm_wallet_transactions set status = 'ROLLED_BACK' where id = $1::uuid",
        [debit.rows[0].id],
      );
      status = "APPLIED";
    }
    fields.userId = player.id;
    const transactionId = await recordTransaction(client, fields, "ROLLBACK", status, nextBalance);
    const wagering = await wageringTracker(client, player.id);
    await wagering.cancelBet(fields.debitTransactionId);
    await wagering.resetIfEmpty(nextBalance, `rollback:${fields.transactionId}`);
    return response("OK", { balance: nextBalance }, { operator_transaction_id: transactionId });
  });
}

export async function processSkmWalletCallback(route, payload, rawBody) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return response("ERROR", null, { message: "Invalid JSON body" });
  }
  if (route === "balance") return balanceRequest(payload);
  if (route === "debit") return debitRequest(payload, rawBody);
  if (route === "credit") return creditRequest(payload, rawBody);
  if (route === "rollback") return rollbackRequest(payload, rawBody);
  return response("ERROR", null, { message: "Unknown wallet operation" });
}
