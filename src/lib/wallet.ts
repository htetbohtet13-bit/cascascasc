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

export type WithdrawResult = {
  ok: boolean;
  state: "paid" | "pending" | "failed";
  balance?: number;
  message: string;
  orderId?: string;
};

export async function submitWithdraw(
  serviceType: PayMethod,
  amount: number,
  phone: string,
  requestId: string,
): Promise<WithdrawResult> {
  let response: Response;
  try {
    response = await fetch("/api/wallet/withdraw", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service_type: serviceType, amount, phone, request_id: requestId }),
    });
  } catch {
    return {
      ok: true,
      state: "pending",
      message: "We could not confirm the result. Do not submit another withdrawal; contact support to check it.",
    };
  }

  const payload = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    state?: WithdrawResult["state"];
    balance?: number;
    message?: string;
    error?: string;
    orderId?: string;
  };
  if (payload.state === "pending") {
    return {
      ok: true,
      state: "pending",
      balance: payload.balance,
      message: payload.message || "Your withdrawal is being checked. Do not submit it again; contact support if it stays pending.",
      orderId: payload.orderId,
    };
  }
  if (!response.ok || payload.error) throw new Error(payload.error || "Request failed");
  if (!payload.state || typeof payload.balance !== "number" || !payload.message) {
    throw new Error(payload.message || "Request failed");
  }
  return {
    ok: Boolean(payload.ok),
    state: payload.state,
    balance: payload.balance,
    message: payload.message,
    orderId: payload.orderId,
  };
}
