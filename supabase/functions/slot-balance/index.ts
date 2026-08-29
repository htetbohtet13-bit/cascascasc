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
    return json({ code: 0, msg: "Method not allowed" });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ code: 0, msg: "Server is not configured" });
  }

  const params = await parseParams(req);
  const uid = (params.uid ?? "").trim();
  const token = (params.token ?? "").trim();

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await admin.rpc("slot_get_balance", {
    p_uid: uid,
    p_token: token,
  });

  if (error) {
    return json({ code: 0, msg: error.message });
  }

  const result = data as { ok?: boolean; balance?: number; message?: string };
  if (!result?.ok) {
    return json({ code: 0, msg: result?.message ?? "Request failed" });
  }

  return json({
    code: 1,
    msg: "success",
    balance: Number(result.balance ?? 0),
  });
});
