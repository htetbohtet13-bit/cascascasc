import { useEffect, useState } from "react";
import DepositFlow from "./DepositFlow";
import Wallet from "./Wallet";
import { loadWalletHistory, type WalletHistoryItem } from "./lib/wallet";

type WalletTab = "deposit" | "withdraw" | "history";

type Props = {
  initialTab: "deposit" | "withdraw";
  balance: number;
  defaultPhone: string;
  onClose: () => void;
  onBalance: (balance: number) => void;
};

const TABS: { id: WalletTab; label: string }[] = [
  { id: "deposit", label: "ငွေသွင်း" },
  { id: "withdraw", label: "ငွေထုတ်" },
  { id: "history", label: "မှတ်တမ်း" },
];

function WalletHistory() {
  const [items, setItems] = useState<WalletHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    loadWalletHistory()
      .then((history) => {
        if (active) setItems(history);
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : "မှတ်တမ်းကို ဖွင့်မရပါ");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  if (loading) return <div className="wallet-history-message">မှတ်တမ်းကို ဖွင့်နေသည်…</div>;
  if (error) return <div className="wallet-history-message error">{error}</div>;
  if (!items.length) return <div className="wallet-history-message">ငွေသွင်း၊ ငွေထုတ် မှတ်တမ်း မရှိသေးပါ</div>;

  return (
    <div className="wallet-history-list">
      {items.map((item, index) => {
        const isDeposit = item.kind === "deposit";
        const status =
          item.status === "paid" || item.status === "verified"
            ? "ပြီးပါပြီ"
            : item.status === "failed"
              ? "မအောင်မြင်ပါ"
              : "စစ်ဆေးနေသည်";
        const stamp = new Date(item.created_at);
        return (
          <article className="wallet-history-row" key={`${item.created_at}-${item.kind}-${index}`}>
            <span className={`wallet-history-mark${isDeposit ? " deposit" : " withdraw"}`} aria-hidden="true">
              {isDeposit ? "＋" : "−"}
            </span>
            <div className="wallet-history-main">
              <strong>{isDeposit ? "ငွေသွင်း" : "ငွေထုတ်"} · {item.service_type === "kbzpay" ? "KBZPay" : "WavePay"}</strong>
              <span>{Number.isNaN(stamp.getTime()) ? "" : stamp.toLocaleString("my-MM", { dateStyle: "medium", timeStyle: "short" })}</span>
            </div>
            <div className="wallet-history-amount">
              <strong>{isDeposit ? "+" : "−"}{Number(item.amount).toLocaleString("en-US")} Ks</strong>
              <span className={`wallet-history-status ${item.status}`}>{status}</span>
            </div>
          </article>
        );
      })}
    </div>
  );
}

export default function WalletCenter({ initialTab, balance, defaultPhone, onClose, onBalance }: Props) {
  const [activeTab, setActiveTab] = useState<WalletTab>(initialTab);
  const [depositFullscreen, setDepositFullscreen] = useState(false);
  const fullscreen = activeTab === "deposit" && depositFullscreen;

  return (
    <section className={`wallet-center${fullscreen ? " deposit-fullscreen" : ""}`} aria-label={fullscreen ? "ငွေသွင်း" : "ငွေကြေးစီမံရန်"}>
      {!fullscreen ? (
        <>
          <header className="wallet-center-header">
            <h1>ပိုက်ဆံအိတ်</h1>
            <button type="button" className="wallet-center-close" onClick={onClose} aria-label="ပိတ်ရန်">
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round">
                <path d="m18 6-12 12M6 6l12 12" />
              </svg>
            </button>
          </header>

          <div className="wallet-center-tabs" role="tablist" aria-label="ပိုက်ဆံအိတ် အပိုင်းများ">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                className={activeTab === tab.id ? "active" : ""}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </>
      ) : null}

      <div className="wallet-center-content">
        {activeTab === "deposit" ? <DepositFlow embedded onFullscreenChange={setDepositFullscreen} onHistory={() => setActiveTab("history")} onClose={onClose} onBalance={onBalance} /> : null}
        {activeTab === "withdraw" ? (
          <Wallet embedded balance={balance} defaultPhone={defaultPhone} onClose={onClose} onBalance={onBalance} />
        ) : null}
        {activeTab === "history" ? (
          <div className="wallet-history-view">
            <h2>ငွေစာရင်းမှတ်တမ်း</h2>
            <p>သင့်ငွေသွင်းနှင့် ငွေထုတ်မှုများ</p>
            <WalletHistory />
          </div>
        ) : null}
      </div>
    </section>
  );
}
