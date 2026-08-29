import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function normalizePhone(input: string): string | null {
  const trimmed = input.trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");

  if (digits.length < 8 || digits.length > 15) return null;

  if (digits.startsWith("09") && digits.length >= 10 && digits.length <= 12) {
    return `+95${digits.slice(1)}`;
  }

  if (digits.startsWith("959") && digits.length >= 11) {
    return `+${digits}`;
  }

  if (hasPlus) return `+${digits}`;
  return `+${digits}`;
}

function phoneToEmail(phone: string) {
  return `${phone.replace(/\D/g, "")}@phone.local`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");

  if (!supabaseUrl || !serviceRoleKey || !anonKey) {
    return json({ error: "Server is not configured" }, 500);
  }

  let payload: { action?: string; phone?: string; password?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const action = payload.action;
  const phone = normalizePhone(payload.phone ?? "");
  const password = payload.password ?? "";

  if (action !== "signup" && action !== "signin") {
    return json({ error: "Unknown action" }, 400);
  }

  if (!phone) {
    return json({ error: "Enter a valid phone number" }, 400);
  }

  if (password.length < 6) {
    return json({ error: "Password must be at least 6 characters" }, 400);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const anon = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  if (action === "signup") {
    const { data: existing } = await admin
      .from("profiles")
      .select("id")
      .eq("phone", phone)
      .maybeSingle();

    if (existing) {
      return json({ error: "This phone number is already registered" }, 409);
    }

    const phoneCreate = await admin.auth.admin.createUser({
      phone,
      password,
      phone_confirm: true,
      user_metadata: { phone },
    });

    let loginWith: { phone?: string; email?: string } = { phone };

    if (phoneCreate.error) {
      const emailCreate = await admin.auth.admin.createUser({
        email: phoneToEmail(phone),
        password,
        email_confirm: true,
        user_metadata: { phone },
      });

      if (emailCreate.error) {
        const message = emailCreate.error.message.toLowerCase();
        if (message.includes("already") || message.includes("registered")) {
          return json({ error: "This phone number is already registered" }, 409);
        }
        return json({ error: emailCreate.error.message }, 400);
      }

      loginWith = { email: phoneToEmail(phone) };
    }

    const signIn = await anon.auth.signInWithPassword({
      ...loginWith,
      password,
    } as { phone?: string; email?: string; password: string });

    if (signIn.error || !signIn.data.session) {
      return json(
        { error: signIn.error?.message ?? "Account created. Please sign in." },
        400,
      );
    }

    return json({ session: signIn.data.session });
  }

  const phoneSignIn = await anon.auth.signInWithPassword({ phone, password });
  if (!phoneSignIn.error && phoneSignIn.data.session) {
    return json({ session: phoneSignIn.data.session });
  }

  const emailSignIn = await anon.auth.signInWithPassword({
    email: phoneToEmail(phone),
    password,
  });

  if (emailSignIn.error || !emailSignIn.data.session) {
    return json({ error: "Invalid phone number or password" }, 401);
  }

  return json({ session: emailSignIn.data.session });
});
