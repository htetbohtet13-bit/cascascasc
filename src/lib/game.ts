import { supabase } from "./supabase";

export type GameSession = {
  uid: string;
  token: string;
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

export async function issueGameToken(): Promise<GameSession> {
  const { data, error } = await supabase.functions.invoke<GameSession | { error?: string }>(
    "issue-game-token",
  );

  if (data && "error" in data && data.error) {
    throw new Error(data.error);
  }

  if (error) {
    throw new Error(error.message);
  }

  const session = data as GameSession | null;
  if (!session?.uid || !session.token) {
    throw new Error("Could not create a game session");
  }

  return session;
}

export async function launchGame(gameId: number, roomId: number) {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    throw new Error("Not authenticated");
  }

  const response = await fetch("/api/game-login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ gameId, roomId }),
  });

  const payload = (await response.json()) as { url?: string; error?: string };
  if (!payload.url) {
    throw new Error(payload.error ?? "Could not open the game");
  }

  return payload.url;
}

export async function loadSlotBets(userId: string): Promise<SlotBet[]> {
  const { data, error } = await supabase
    .from("slot_bets")
    .select("bet_uid, round_id, bet, win, changemoney, balance_after, game_id, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(8);

  if (error) throw new Error(error.message);
  return data ?? [];
}
