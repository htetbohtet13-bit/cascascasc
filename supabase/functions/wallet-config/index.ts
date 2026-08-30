import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-payment-key, x-kbz-receiver, x-wave-receiver, x-payment-api-url",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function firstEnv(req: Request, header: string, ...names: string[]) {
  for (const name of names) {
    const value = Deno.env.get(name);
    if (value) return value;
  }
  return req.headers.get(header) ?? "";
}

async function userId(req: Request) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const authHeader = req.headers.get("Authorization");
  if (!supabaseUrl || !anonKey || !authHeader) return null;

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data } = await userClient.auth.getUser();
  return data.user?.id ?? null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const id = await userId(req);
  if (!id) return json({ error: "Not authenticated" }, 401);

  const kbz = firstEnv(req, "x-kbz-receiver", "kbzreceiver", "KBZRECEIVER", "KBZ_RECEIVER");
  const wave = firstEnv(req, "x-wave-receiver", "wavereceiver", "WAVERECEIVER", "WAVE_RECEIVER");

  return json({
    kbzpay: { label: "KBZPay", receiver: kbz },
    wavepay: { label: "WavePay", receiver: wave },
  });
});
