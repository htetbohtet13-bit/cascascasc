import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function toInt(value: string | undefined) {
  if (value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed);
}

async function parseParams(req: Request): Promise<Record<string, string>> {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await req.json()) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(body).map(([key, value]) => [key, String(value ?? "").trim()]),
    );
  }

  const text = await req.text();
  if (!text) return {};
  if (text.trim().startsWith("{")) {
    const body = JSON.parse(text) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(body).map(([key, value]) => [key, String(value ?? "").trim()]),
    );
  }

  return Object.fromEntries(
    [...new URLSearchParams(text)].map(([key, value]) => [key, value.trim()]),
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ code: 0 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ code: 0 });
  }

  const params = await parseParams(req);
  const changemoney = toInt(params.changemoney);
  const bet = toInt(params.bet) ?? 0;
  const win = toInt(params.win) ?? 0;

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await admin.rpc("slot_apply_change", {
    p_uid: (params.uid ?? "").trim(),
    p_token: (params.token ?? "").trim(),
    p_round_id: (params.round_id ?? "").trim(),
    p_bet_uid: (params.bet_uid ?? "").trim(),
    p_changemoney: changemoney ?? win - bet,
    p_bet: bet,
    p_win: win,
    p_room_id: toInt(params.roomId ?? params.roomid ?? ""),
    p_game_id: toInt(params.gameId ?? params.gameid ?? ""),
  });

  if (error) {
    return json({ code: 0 });
  }

  const result = data as { ok?: boolean; balance?: number };
  if (!result?.ok) {
    return json({ code: 0 });
  }

  return json({
    code: 1,
    msg: String(result.balance ?? 0),
  });
});
