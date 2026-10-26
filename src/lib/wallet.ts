export type PayMethod = "kbzpay" | "wavepay";

export type WalletMethods = {
  kbzpay: { label: string; receiver: string; name?: string };
  wavepay: { label: string; receiver: string; name?: string };
};

async function walletRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
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

export async function submitWithdraw(serviceType: PayMethod, amount: number, phone: string) {
  const response = await fetch("/api/wallet/withdraw", {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      service_type: serviceType,
      amount,
      phone,
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    balance?: number;
    message?: string;
    error?: string;
  };
  if (response.status === 504 || response.status === 408) {
    throw new Error(
      payload.error || "Transfer timed out. Do not try again yet — check KBZPay or WavePay first.",
    );
  }
  if (!response.ok || payload.error) {
    throw new Error(payload.error || "Request failed");
  }
  if (!payload.ok || typeof payload.balance !== "number") {
    throw new Error(payload.message || "Request failed");
  }
  return payload as { ok: boolean; balance: number; message: string };
}
