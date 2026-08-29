import { supabase } from "./supabase";

type AuthAction = "signup" | "signin";

type AuthResponse = {
  session?: {
    access_token: string;
    refresh_token: string;
  };
  error?: string;
};

export async function authenticate(action: AuthAction, phone: string, password: string) {
  const { data, error } = await supabase.functions.invoke<AuthResponse>("phone-auth", {
    body: { action, phone, password },
  });

  if (data?.error) {
    throw new Error(data.error);
  }

  if (error) {
    let message = error.message;
    const response = (error as { context?: Response }).context;
    if (response) {
      try {
        const body = (await response.clone().json()) as AuthResponse;
        if (body.error) message = body.error;
      } catch {
        // keep the original message
      }
    }
    throw new Error(message);
  }

  if (!data?.session?.access_token || !data.session.refresh_token) {
    throw new Error("Could not start a session");
  }

  const { error: sessionError } = await supabase.auth.setSession({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  });

  if (sessionError) {
    throw new Error(sessionError.message);
  }
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw new Error(error.message);
}
