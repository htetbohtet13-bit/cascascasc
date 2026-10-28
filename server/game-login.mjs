import { createSkmGameSession } from "./skm-wallet.mjs";
import { callSkmApi, listProviderGames, SkmApiError } from "./skm-api.mjs";

const CURRENCY = "MMK";

export function gameLoginFailure(error) {
  if (error instanceof SkmApiError) {
    if (error.code === "CONFIG_MISSING" || error.code === "CONFIG_INVALID") {
      return { status: 503, body: { error: "Game provider or VPS gateway settings are missing or invalid" } };
    }
    if (error.status === 404) return { status: 404, body: { error: "This game or stake is not available" } };
    if (error.status >= 500 || error.status === 429) {
      return { status: 502, body: { error: "The new game provider is temporarily unavailable" } };
    }
    return { status: 400, body: { error: error.message || "The provider rejected the game request" } };
  }
  if (error?.code === "42P01" && String(error?.message ?? "").includes("skm_game_sessions")) {
    return { status: 503, body: { error: "Run neon/005_skm_seamless_wallet.sql in Neon SQL Editor first" } };
  }
  if (error?.name === "TypeError" || error?.name === "TimeoutError" || error?.code === "ETIMEDOUT") {
    return { status: 502, body: { error: "Could not reach the new game provider" } };
  }
  return { status: 500, body: { error: "Could not start the game" } };
}

export async function handleGameLogin({ userId, gameCode, tableId, device = "mobile" }) {
  if (!userId) return { status: 401, body: { error: "Not authenticated" } };
  if (typeof gameCode !== "string" || !/^[a-z0-9]+$/.test(gameCode)) {
    return { status: 400, body: { error: "Choose a valid game" } };
  }
  if (tableId != null && (typeof tableId !== "string" || tableId.length > 160)) {
    return { status: 400, body: { error: "Choose a valid stake level" } };
  }

  const games = await listProviderGames();
  const selectedGame = games.find((game) => game?.game_code === gameCode);
  if (!selectedGame) return { status: 404, body: { error: "This game is not available" } };

  const selectedTableId = String(tableId ?? "").trim();
  const pools = Array.isArray(selectedGame.pools) ? selectedGame.pools : [];
  const tables = Array.isArray(selectedGame.tables) ? selectedGame.tables : [];
  const validStake = [...pools, ...tables].some((item) =>
    item?.currency === CURRENCY && (item?.pool_id === selectedTableId || item?.table_id === selectedTableId),
  );
  if (selectedTableId && !validStake) {
    return { status: 404, body: { error: "This stake level is not available" } };
  }
  const session = await createSkmGameSession(userId);
  const payload = {
    player_id: session.player_id,
    player_name: session.player_name,
    token: session.token,
    currency: CURRENCY,
    game_code: gameCode,
    ...(selectedTableId ? { table_id: selectedTableId } : {}),
    language: "my",
    device: device === "desktop" ? "desktop" : "mobile",
  };
  const providerResult = await callSkmApi("game/launch", { method: "POST", payload });
  if (typeof providerResult?.url !== "string" || !providerResult.url.startsWith("https://")) {
    throw new SkmApiError("Provider returned an invalid game URL", { status: 502, code: "INVALID_RESPONSE" });
  }
  return { status: 200, body: { url: providerResult.url } };
}
