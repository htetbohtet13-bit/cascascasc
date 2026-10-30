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

function paymentErrorMessage(message?: string) {
  if (message && /[\u1000-\u109f]/.test(message)) return message;
  const text = (message ?? "").toLowerCase();
  if (text.includes("too many")) return "အကြိမ်များစွာ စစ်ဆေးထားပါသည်။ ခဏစောင့်ပြီး ပြန်လည်ကြိုးစားပါ။";
  if (text.includes("temporarily unavailable")) return "ငွေပေးချေမှုကို ယာယီစစ်ဆေး၍ မရသေးပါ။ ခဏစောင့်ပြီး ပြန်လည်ကြိုးစားပါ။";
  if (text.includes("not authenticated")) return "အကောင့်သို့ ပြန်လည်ဝင်ရောက်ပါ။";
  if (text.includes("last 6")) return "ငွေလွှဲနံပါတ်၏ နောက်ဆုံး ၆ လုံးကို ထည့်ပါ။";
  if (text.includes("already been added") || text.includes("already used")) return "ဤငွေလွှဲမှုကို အသုံးပြုပြီးဖြစ်ပါသည်။";
  if (text.includes("not found") || text.includes("do not match")) return "ငွေလွှဲမှုအချက်အလက်များ မကိုက်ညီပါ။ ပြေစာကို စစ်ဆေးပြီး ပြန်လည်ကြိုးစားပါ။";
  if (text.includes("choose kbzpay")) return "KBZPay သို့မဟုတ် WavePay ကို ရွေးပါ။";
  if (text.includes("enter an amount")) return "ငွေပမာဏကို မှန်ကန်စွာ ထည့်ပါ။";
  return "ငွေပေးချေမှုကို အတည်မပြုနိုင်ပါ။ ပြေစာကို စစ်ဆေးပါ သို့မဟုတ် အကူအညီဌာနသို့ ဆက်သွယ်ပါ။";
}

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
      paymentErrorMessage((payload && typeof payload === "object" && payload.error) || undefined),
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

export class DepositVerificationPendingError extends Error {
  constructor() {
    super("ငွေသွင်းမှုရလဒ်ကို အတည်မပြုနိုင်သေးပါ။ ငွေထပ်မလွှဲဘဲ မှတ်တမ်းကို စစ်ဆေးပါ။");
    this.name = "DepositVerificationPendingError";
  }
}

export async function submitDeposit(serviceType: PayMethod, amount: number, transactionId: string) {
  let response: Response;
  try {
    response = await fetch("/api/wallet/deposit", {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service_type: serviceType, amount, transaction_id: transactionId }),
    });
  } catch {
    throw new DepositVerificationPendingError();
  }
  let decoded: unknown;
  try { decoded = await response.json(); } catch { throw new DepositVerificationPendingError(); }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded) || response.status >= 500) {
    throw new DepositVerificationPendingError();
  }
  const result = decoded as { ok?: boolean; balance?: number; error?: string };
  if (!response.ok || result.error) throw new Error(paymentErrorMessage(result.error));
  if (result.ok !== true || typeof result.balance !== "number" || !Number.isSafeInteger(result.balance) || result.balance < 0) {
    throw new DepositVerificationPendingError();
  }
  return { ok: true, balance: result.balance, message: "ငွေဖြည့်သွင်းပြီးပါပြီ။" };
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
  if (text.includes("too many") || text.includes("temporarily unavailable")) return paymentErrorMessage(message);
  if (text.includes("not authenticated")) return "အကောင့်သို့ ပြန်လည်ဝင်ရောက်ပါ။";
  if (text.includes("not enough balance")) return "လက်ကျန်ငွေ မလုံလောက်ပါ။";
  if (text.includes("beginning with 09")) return "09 ဖြင့်စသော KBZPay သို့မဟုတ် WavePay ဖုန်းနံပါတ်ကို မှန်ကန်စွာ ထည့်ပါ။";
  if (text.includes("choose kbzpay")) return "KBZPay သို့မဟုတ် WavePay ကို ရွေးပါ။";
  if (text.includes("enter an amount")) return "ငွေပမာဏကို မှန်ကန်စွာ ထည့်ပါ။";
  if (text.includes("out of date") || text.includes("refresh")) return "စာမျက်နှာကို ပြန်ဖွင့်ပြီး ထပ်မံကြိုးစားပါ။";
  if (text.includes("already used")) return "ဤငွေထုတ်တောင်းဆိုမှုကို အသုံးပြုပြီးဖြစ်ပါသည်။ စာမျက်နှာကို ပြန်ဖွင့်ပါ။";
  return "ငွေထုတ်ခြင်း မအောင်မြင်ပါ။ ခဏစောင့်ပြီး ပြန်လည်ကြိုးစားပါ။";
}

function pendingWithdrawal(balance?: unknown, orderId?: unknown): WithdrawResult {
  return {
    ok: true, state: "pending",
    balance: typeof balance === "number" && Number.isSafeInteger(balance) && balance >= 0 ? balance : undefined,
    orderId: typeof orderId === "string" && orderId.length <= 80 ? orderId : undefined,
    message: "ငွေထုတ်မှုရလဒ်ကို အတည်မပြုနိုင်သေးပါ။ ထပ်မံငွေမထုတ်ဘဲ မှတ်တမ်းကို စစ်ဆေးပါ။ ကြာမြင့်နေပါက အကူအညီဌာနသို့ ဆက်သွယ်ပါ။",
  };
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
    return pendingWithdrawal();
  }

  let decoded: unknown;
  try { decoded = await response.json(); } catch { return pendingWithdrawal(); }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return pendingWithdrawal();
  const payload = decoded as {
    ok?: boolean;
    state?: WithdrawResult["state"];
    balance?: number;
    message?: string;
    error?: string;
    code?: string;
    orderId?: string;
    safeToRetry?: boolean;
  };
  if (payload.state === "pending") return pendingWithdrawal(payload.balance, payload.orderId);
  // A broken response can arrive after the bank sent the money. Do not label
  // it failed, claim a refund, or offer a second transfer.
  if (response.status >= 500) return pendingWithdrawal();
  if (!response.ok || payload.error) {
    if (typeof payload.error !== "string" || !payload.error) return pendingWithdrawal();
    throw new WalletRequestError(withdrawErrorMessage(payload.error), typeof payload.code === "string" ? payload.code : undefined);
  }
  const safeBalance = typeof payload.balance === "number" && Number.isSafeInteger(payload.balance) && payload.balance >= 0;
  const paid = payload.state === "paid" && payload.ok === true;
  const failed = payload.state === "failed" && payload.ok === false && payload.safeToRetry === true;
  if (!safeBalance || (!paid && !failed)) return pendingWithdrawal();
  return {
    ok: paid,
    state: paid ? "paid" : "failed",
    balance: payload.balance,
    message: payload.state === "paid"
      ? "ငွေထုတ်ခြင်း အောင်မြင်ပါသည်။"
      : "ငွေထုတ်ခြင်း မအောင်မြင်ပါ။ သင့်လက်ကျန်ငွေကို ပြန်လည်ဖြည့်ပေးထားပါသည်။",
    orderId: payload.orderId,
  };
}
