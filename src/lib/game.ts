export type GameSession = { uid: string; token: string };
export type Game = {
  id: number | string;
  game_id: number;
  room_id: number;
  name: string;
  category: "slots" | "cards" | "buffalo" | "other";
  image_url: string | null;
  gradient_start: string;
  gradient_end: string;
  players_online: number | null;
  is_popular: boolean;
  is_active: boolean;
  sort_order: number;
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

export function issueGameToken() {
  return request<GameSession>("/api/game/session", { method: "POST" });
}

export async function loadGames() {
  const payload = await request<{ games: Game[] }>("/api/games");
  return payload.games;
}

export async function launchGame(gameId: number, roomId: number) {
  const payload = await request<{ url?: string; error?: string }>("/api/game-login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ gameId, roomId }),
  });
  if (!payload.url) throw new Error(payload.error ?? "Could not open the game");
  return payload.url;
}

export function loadSlotBets(_userId?: string) {
  return request<SlotBet[]>("/api/profile/bets");
}
