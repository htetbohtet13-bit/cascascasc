export type PayMethod = "kbzpay" | "wavepay";

export type WalletMethods = {
  kbzpay: { label: string; receiver: string; name?: string };
  wavepay: { label: string; receiver: string; name?: string };
};

export type WalletHistoryItem = {
  kind: "deposit" | "withdraw";
  service_type: PayMethod;
  amount: number | string;
  status: "pending" | "verified" | "failed" | "paid";
  message: string | null;
  created_at: string;
  completed_at: string | null;
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

export async function loadWalletHistory() {
  const payload = await walletRequest<{ history: WalletHistoryItem[] }>("/api/wallet/history");
  return payload.history;
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

export class WalletRequestError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "WalletRequestError";
    this.code = code;
  }
}

function withdrawErrorMessage(message?: string) {
  if (message && /[\u1000-\u109f]/.test(message)) return message;
  const text = (message ?? "").toLowerCase();
  if (text.includes("not authenticated")) return "အကောင့်သို့ ပြန်လည်ဝင်ရောက်ပါ။";
  if (text.includes("not enough balance")) return "လက်ကျန်ငွေ မလုံလောက်ပါ။";
  if (text.includes("beginning with 09")) return "09 ဖြင့်စသော KBZPay သို့မဟုတ် WavePay ဖုန်းနံပါတ်ကို မှန်ကန်စွာ ထည့်ပါ။";
  if (text.includes("choose kbzpay")) return "KBZPay သို့မဟုတ် WavePay ကို ရွေးပါ။";
  if (text.includes("enter an amount")) return "ငွေပမာဏကို မှန်ကန်စွာ ထည့်ပါ။";
  if (text.includes("out of date") || text.includes("refresh")) return "စာမျက်နှာကို ပြန်ဖွင့်ပြီး ထပ်မံကြိုးစားပါ။";
  if (text.includes("already used")) return "ဤငွေထုတ်တောင်းဆိုမှုကို အသုံးပြုပြီးဖြစ်ပါသည်။ စာမျက်နှာကို ပြန်ဖွင့်ပါ။";
  return "ငွေထုတ်ခြင်း မအောင်မြင်ပါ။ ခဏစောင့်ပြီး ပြန်လည်ကြိုးစားပါ။";
}

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
      message: "ငွေထုတ်မှုရလဒ်ကို အတည်မပြုနိုင်သေးပါ။ ထပ်မံငွေမထုတ်ဘဲ အကူအညီဌာနသို့ ဆက်သွယ်စစ်ဆေးပါ။",
    };
  }

  const payload = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    state?: WithdrawResult["state"];
    balance?: number;
    message?: string;
    error?: string;
    code?: string;
    orderId?: string;
  };
  if (payload.state === "pending") {
    return {
      ok: true,
      state: "pending",
      balance: payload.balance,
      message: "ငွေထုတ်တောင်းဆိုမှုကို စစ်ဆေးနေပါသည်။ ထပ်မံငွေမထုတ်ဘဲ ခဏစောင့်ပါ။ ကြာမြင့်နေပါက အကူအညီဌာနသို့ ဆက်သွယ်ပါ။",
      orderId: payload.orderId,
    };
  }
  if (!response.ok || payload.error) throw new WalletRequestError(withdrawErrorMessage(payload.error), payload.code);
  if (!payload.state || typeof payload.balance !== "number" || !payload.message) {
    throw new WalletRequestError(withdrawErrorMessage(payload.message));
  }
  return {
    ok: Boolean(payload.ok),
    state: payload.state,
    balance: payload.balance,
    message: payload.state === "paid"
      ? "ငွေထုတ်ခြင်း အောင်မြင်ပါသည်။"
      : "ငွေထုတ်ခြင်း မအောင်မြင်ပါ။ သင့်လက်ကျန်ငွေကို ပြန်လည်ဖြည့်ပေးထားပါသည်။",
    orderId: payload.orderId,
  };
}
