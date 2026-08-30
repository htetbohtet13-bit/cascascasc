import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-payment-key, x-kbz-receiver, x-wave-receiver, x-payment-api-url",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function toAmount(value: unknown) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) ? parsed : NaN;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const authHeader = req.headers.get("Authorization");

  if (!supabaseUrl || !serviceRoleKey || !anonKey) {
    return json({ error: "Server is not configured" }, 500);
  }
  if (!authHeader) return json({ error: "Not authenticated" }, 401);

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: userData } = await userClient.auth.getUser();
  if (!userData.user) return json({ error: "Not authenticated" }, 401);

  const body = (await req.json().catch(() => ({}))) as {
    service_type?: string;
    amount?: number | string;
    phone?: string;
  };

  const serviceType = body.service_type === "wavepay" ? "wavepay" : body.service_type === "kbzpay" ? "kbzpay" : "";
  const amount = toAmount(body.amount);
  const phone = String(body.phone ?? "").replace(/\D/g, "");

  if (!serviceType) return json({ error: "Choose KBZPay or WavePay" }, 400);
  if (!Number.isFinite(amount) || amount <= 0) return json({ error: "Enter an amount" }, 400);
  if (phone.length < 8) return json({ error: "Enter the phone number to receive money" }, 400);

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await admin.rpc("apply_withdraw", {
    p_user_id: userData.user.id,
    p_order_id: `WD${crypto.randomUUID().replaceAll("-", "")}`.slice(0, 40),
    p_service_type: serviceType,
    p_amount: amount,
    p_payout_phone: phone,
  });

  if (error) return json({ error: error.message }, 400);
  const result = data as { ok?: boolean; balance?: number; message?: string };
  if (!result?.ok) return json({ error: result?.message ?? "Could not request withdraw" }, 400);

  return json({
    ok: true,
    balance: Number(result.balance ?? 0),
    message: result.message ?? "Withdraw requested",
  });
});
