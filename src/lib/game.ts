export type GamePool = {
  pool_id: string;
  name: string;
  currency: string;
  max_seats: number;
  tables_open?: number;
  max_tables?: number;
  limits?: { min_bet?: number; max_bet?: number; required_amount?: number };
};
export type GameTable = {
  table_id: string;
  name: string;
  currency: string;
  max_seats: number;
  limits?: { min_bet?: number; max_bet?: number; required_amount?: number };
};
export type Game = {
  game_code: string;
  name: string;
  pools?: GamePool[];
  tables?: GameTable[];
  image_url?: string | null;
  manual_test?: boolean;
};
export type SlotBet = {
  bet_uid: string;
  round_id: string | null;
  bet: number;
  win: number;
  changemoney: number;
  balance_after: number;
  game_id: number | null;
  created_at: string;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "include", ...init });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Request failed");
  return payload as T;
}

export async function loadGames() {
  const payload = await request<{ games: Game[] }>("/api/games");
  return payload.games;
}

export async function launchGame(gameCode: string, tableId: string) {
  const payload = await request<{ url?: string; error?: string }>("/api/game-login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ game_code: gameCode, table_id: tableId }),
  });
  if (!payload.url) throw new Error(payload.error ?? "Could not open the game");
  return payload.url;
}

export function loadSlotBets(_userId?: string) {
  return request<SlotBet[]>("/api/profile/bets");
}
