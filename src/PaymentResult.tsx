type Props = {
  kind: "deposit" | "withdraw";
  state: "processing" | "success" | "pending" | "failed";
  amount: number;
  bonusAmount?: number;
  bank?: { name: string; image: string };
  phone?: string;
  message: string;
  onClose: () => void;
  onHistory?: () => void;
  onRetry?: () => void;
};

export default function PaymentResult({ kind, state, amount, bonusAmount = 0, bank, phone, message, onClose, onHistory, onRetry }: Props) {
  const processing = state === "processing";
  const success = state === "success";
  const title = processing
    ? kind === "deposit" ? "ငွေသွင်းမှု စစ်ဆေးနေပါသည်" : "ငွေလွှဲနေပါသည်"
    : success
      ? kind === "deposit" ? "ငွေသွင်းအောင်မြင်ပါသည်" : "ငွေထုတ်ခြင်း အောင်မြင်ပါသည်။"
      : state === "pending" ? "စစ်ဆေးနေဆဲ ဖြစ်ပါသည်"
        : kind === "deposit" ? "ငွေသွင်းမှု စစ်ဆေးမရပါ" : "ငွေထုတ်ခြင်း မအောင်မြင်ပါ";
  const label = processing ? "လုပ်ဆောင်နေသည်" : success ? "အောင်မြင်ပါသည်" : state === "pending" ? "စစ်ဆေးဆဲ" : "မအောင်မြင်ပါ";

  return (
    <section className={`payment-result ${state}`} aria-label={title} aria-busy={processing}>
      <div className="payment-result-card">
        <header className="payment-result-header">
          <span>{kind === "deposit" ? "ငွေသွင်း" : "ငွေထုတ်"}</span>
          <span className="payment-result-badge"><i aria-hidden="true" />{label}</span>
        </header>
        <div className="payment-result-body" role="status" aria-live="polite">
          <div className="payment-result-mark" aria-hidden="true">
            {processing ? <span className="payment-result-spinner" /> : (
              <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                {success ? <path className="payment-result-check" d="m8 16 5.5 5.5L24 11" />
                  : state === "pending" ? <><circle cx="16" cy="16" r="10" /><path d="M16 10v6l4 3" /></>
                    : <><path d="m11 11 10 10m0-10L11 21" /><circle cx="16" cy="16" r="11" /></>}
              </svg>
            )}
          </div>
          <h2>{title}</h2>
          <p className="payment-result-message">{message}</p>
          <div className="payment-result-amount">
            <small>{success ? kind === "deposit" ? "ဖြည့်သွင်းပြီး ပမာဏ" : "လွှဲပေးပြီး ပမာဏ" : "တောင်းဆိုထားသော ပမာဏ"}</small>
            <strong>{amount.toLocaleString("en-US")} <span>ကျပ်</span></strong>
          </div>
        </div>
        {success && kind === "deposit" && bonusAmount > 0 ? (
          <dl className="payment-result-details payment-result-bonus">
            <div><dt>သွင်းငွေ</dt><dd>{amount.toLocaleString("en-US")} ကျပ်</dd></div>
            <div><dt>ကြိုဆိုဘောနပ်စ်</dt><dd>+{bonusAmount.toLocaleString("en-US")} ကျပ်</dd></div>
            <div><dt>စုစုပေါင်း ဖြည့်သွင်းပြီးငွေ</dt><dd>{(amount + bonusAmount).toLocaleString("en-US")} ကျပ်</dd></div>
          </dl>
        ) : null}
        {bank ? (
          <dl className="payment-result-details">
            <div><dt>ငွေပေးချေမှုနည်းလမ်း</dt><dd><img src={bank.image} alt="" /><span>{bank.name}</span></dd></div>
            {phone ? <div><dt>လက်ခံမည့် ဖုန်းနံပါတ်</dt><dd className="payment-result-phone">{phone}</dd></div> : null}
          </dl>
        ) : null}
        {processing ? <p className="payment-result-wait">ခဏစောင့်ပေးပါ။</p> : (
          <footer className="payment-result-actions">
            <button type="button" className="payment-result-primary" onClick={onRetry ?? onClose}>{onRetry ? "ပြန်လည်ကြိုးစားမည်" : "ပြီးပါပြီ"}</button>
            {onHistory ? <button type="button" className="payment-result-secondary" onClick={onHistory}>မှတ်တမ်းကြည့်မည်<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M7 17 17 7M7 7h10v10" /></svg></button>
              : onRetry ? <button type="button" className="payment-result-secondary" onClick={onClose}>ပိတ်မည်</button> : null}
          </footer>
        )}
      </div>
    </section>
  );
}
