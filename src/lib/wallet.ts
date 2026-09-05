import { supabase } from "./supabase";

export type PayMethod = "kbzpay" | "wavepay";

export type WalletMethods = {
  kbzpay: { label: string; receiver: string; name?: string };
  wavepay: { label: string; receiver: string; name?: string };
};

async function authHeader() {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error("Not authenticated");
  return `Bearer ${session.access_token}`;
}

async function walletRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: await authHeader(),
      ...(init?.headers ?? {}),
    },
  });
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok || (payload && typeof payload === "object" && "error" in payload && payload.error)) {
    throw new Error(
      (payload && typeof payload === "object" && payload.error) || "Request failed",
    );
  }
  return payload;
}

export function loadWalletMethods() {
  return walletRequest<WalletMethods>("/api/wallet/config");
}

export function submitDeposit(serviceType: PayMethod, amount: number, transactionId: string) {
  return walletRequest<{ ok: boolean; balance: number; message: string }>("/api/wallet/deposit", {
    method: "POST",
    body: JSON.stringify({
      service_type: serviceType,
      amount,
      transaction_id: transactionId,
    }),
  });
}

export function submitWithdraw(serviceType: PayMethod, amount: number, phone: string) {
  return walletRequest<{ ok: boolean; balance: number; message: string }>("/api/wallet/withdraw", {
    method: "POST",
    body: JSON.stringify({
      service_type: serviceType,
      amount,
      phone,
    }),
  });
}
