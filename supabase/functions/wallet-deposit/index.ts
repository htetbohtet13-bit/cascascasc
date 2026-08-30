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

function firstEnv(req: Request, header: string, ...names: string[]) {
  for (const name of names) {
    const value = Deno.env.get(name);
    if (value) return value;
  }
  return req.headers.get(header) ?? "";
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
    transaction_id?: string;
  };

  const serviceType = body.service_type === "wavepay" ? "wavepay" : body.service_type === "kbzpay" ? "kbzpay" : "";
  const amount = toAmount(body.amount);
  const transactionId = String(body.transaction_id ?? "").replace(/\D/g, "");

  if (!serviceType) return json({ error: "Choose KBZPay or WavePay" }, 400);
  if (!Number.isFinite(amount) || amount <= 0) return json({ error: "Enter an amount" }, 400);
  if (!/^\d{6}$/.test(transactionId)) return json({ error: "Enter the last 6 digits" }, 400);

  const apiKey = firstEnv(req, "x-payment-key", "payment_secret", "PAYMENT_SECRET");
  const apiUrl = (
    firstEnv(req, "x-payment-api-url", "PAYMENT_API_URL", "payment_api_url") ||
    "https://one-cent.mmfastticket.com"
  ).replace(/\/$/, "");
  const receiver =
    serviceType === "kbzpay"
      ? firstEnv(req, "x-kbz-receiver", "kbzreceiver", "KBZRECEIVER", "KBZ_RECEIVER")
      : firstEnv(req, "x-wave-receiver", "wavereceiver", "WAVERECEIVER", "WAVE_RECEIVER");

  if (!apiKey || !receiver) {
    return json({ error: "Payment is not configured" }, 500);
  }

  const orderId = `DEP${crypto.randomUUID().replaceAll("-", "")}`.slice(0, 40);

  const verifyRes = await fetch(`${apiUrl}/api/verify-transaction`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify({
      order_id: orderId,
      service_type: serviceType,
      transaction_id: transactionId,
      receiver,
    }),
  });

  const verified = (await verifyRes.json().catch(() => ({}))) as {
    success?: boolean;
    status?: string;
    message?: string;
    deposit_token?: string;
    transaction?: { id?: string; amount?: number | string };
  };

  if (verified.message === "Transaction ID already used.") {
    return json({ error: "This transaction was already used" }, 400);
  }

  if (!verified.success || verified.status !== "verified" || !verified.transaction) {
    return json({ error: verified.message ?? "Transaction not found" }, 400);
  }

  const paid = toAmount(verified.transaction.amount);
  if (paid !== amount) {
    return json(
      { error: `Paid amount is ${paid}, but you entered ${amount}` },
      400,
    );
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await admin.rpc("apply_verified_deposit", {
    p_user_id: userData.user.id,
    p_order_id: orderId,
    p_service_type: serviceType,
    p_amount: paid,
    p_transaction_id: transactionId,
    p_provider_txn_id: String(verified.transaction.id ?? ""),
    p_deposit_token: verified.deposit_token ?? "",
  });

  if (error) return json({ error: error.message }, 400);
  const result = data as { ok?: boolean; balance?: number; message?: string };
  if (!result?.ok) return json({ error: result?.message ?? "Could not add deposit" }, 400);

  return json({
    ok: true,
    balance: Number(result.balance ?? 0),
    message: result.message ?? "Deposit added",
  });
});
