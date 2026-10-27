import { randomBytes } from "node:crypto";
import { withTransaction, getPool } from "./neon.mjs";

function asInt(value, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

export async function issueGameToken(userId) {
  const profile = await getPool().query(
    "select game_uid from public.profiles where id = $1::uuid",
    [userId],
  );
  if (!profile.rowCount) throw new Error("Profile not found");

  const uid = profile.rows[0].game_uid;
  const token = randomBytes(32).toString("hex");
  const result = await getPool().query(
    `insert into public.game_tokens (uid, user_id, token, created_at, expires_at)
     values ($1, $2::uuid, $3, now(), now() + interval '24 hours')
     on conflict (user_id) do update
       set uid = excluded.uid,
           token = excluded.token,
           created_at = now(),
           expires_at = now() + interval '24 hours'
     returning uid, token`,
    [uid, userId, token],
  );
  return result.rows[0];
}

export async function getSlotBalance(uid, token) {
  uid = String(uid ?? "").trim();
  token = String(token ?? "").trim();
  if (!uid || uid.length > 50 || !token || token.length > 256) return { ok: false };

  const result = await getPool().query(
    `select p.balance
       from public.game_tokens t
       join public.profiles p on p.id = t.user_id
      where t.uid = $1 and t.token = $2
        and (t.expires_at is null or t.expires_at > now())`,
    [uid, token],
  );
  return result.rowCount ? { ok: true, balance: Number(result.rows[0].balance) } : { ok: false };
}

export async function applySlotChange(params) {
  const uid = String(params.uid ?? "").trim();
  const token = String(params.token ?? "").trim();
  const betUid = String(params.bet_uid ?? "").trim();
  const roundId = String(params.round_id ?? "").trim() || null;
  const bet = asInt(params.bet);
  const win = asInt(params.win);
  const change = asInt(params.changemoney);
  const roomId = asInt(params.roomId ?? params.roomid);
  const gameId = asInt(params.gameId ?? params.gameid);

  if (
    !uid || uid.length > 50 || !token || token.length > 256 ||
    !betUid || betUid.length > 160 || !roundId || roundId.length > 160 ||
    bet === null || win === null || change === null ||
    !Number.isSafeInteger(win - bet) || change !== win - bet ||
    roomId === null || roomId < 1 || gameId === null || gameId < 1 ||
    bet < 0 || win < 0
  ) {
    return { ok: false, message: "Invalid bet details" };
  }

  return withTransaction(async (client) => {
    const profile = await client.query(
      `select p.id, p.balance
         from public.game_tokens t
         join public.profiles p on p.id = t.user_id
        where t.uid = $1 and t.token = $2
          and (t.expires_at is null or t.expires_at > now())
        for update of p`,
      [uid, token],
    );
    if (!profile.rowCount) return { ok: false, message: "Invalid game token" };

    const previous = await client.query(
      `select user_id, uid, round_id, changemoney, bet, win, room_id, game_id, balance_after
         from public.slot_bets where bet_uid = $1`,
      [betUid],
    );
    if (previous.rowCount) {
      const row = previous.rows[0];
      if (
        row.user_id === profile.rows[0].id && row.uid === uid &&
        row.round_id === roundId && Number(row.changemoney) === change &&
        Number(row.bet) === bet && Number(row.win) === win &&
        Number(row.room_id) === roomId && Number(row.game_id) === gameId
      ) {
        return { ok: true, balance: Number(row.balance_after) };
      }
      return { ok: false, message: "Bet reference already used" };
    }

    const balance = Number(profile.rows[0].balance);
    const nextBalance = balance + change;
    if (!Number.isSafeInteger(nextBalance) || nextBalance < 0) {
      return { ok: false, message: "Insufficient balance" };
    }

    await client.query(
      "update public.profiles set balance = $2 where id = $1::uuid",
      [profile.rows[0].id, nextBalance],
    );
    await client.query(
      `insert into public.slot_bets
         (user_id, uid, round_id, bet_uid, changemoney, bet, win, room_id, game_id, balance_after)
       values ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [profile.rows[0].id, uid, roundId, betUid, change, bet, win, roomId, gameId, nextBalance],
    );
    return { ok: true, balance: nextBalance };
  });
}
