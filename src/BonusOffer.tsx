import { useEffect, useRef } from "react";

type Props = {
  onTake: () => void;
  onClose?: () => void;
  unavailable?: boolean;
  guest?: boolean;
  titleId?: string;
};

export function BonusPreview({ amount, bonus = 5000 }: { amount: number; bonus?: number }) {
  return (
    <dl className="bonus-preview" aria-label="ဘောနပ်စ် အကြိုကြည့်ရန်">
      <div><dt>သွင်းငွေ</dt><dd>{amount.toLocaleString("en-US")} <small>ကျပ်</small></dd></div>
      <div><dt>ဘောနပ်စ်</dt><dd>+{bonus.toLocaleString("en-US")} <small>ကျပ်</small></dd></div>
      <div><dt>စုစုပေါင်းရမည့်ငွေ</dt><dd>{(BigInt(amount) + BigInt(bonus)).toLocaleString("en-US")} <small>ကျပ်</small></dd></div>
    </dl>
  );
}

export default function BonusOffer({ onTake, onClose, unavailable = false, guest = false, titleId = "bonus-offer-title" }: Props) {
  return (
    <section className="welcome-bonus-card" aria-labelledby={titleId}>
      {onClose ? <button type="button" className="welcome-bonus-close" onClick={onClose} aria-label="ပိတ်မည်"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button> : null}
      <div className="welcome-bonus-heading"><div className="welcome-bonus-gift" aria-hidden="true">🎁</div><span className="welcome-bonus-tag">အကောင့်အသစ်အတွက်</span></div>
      <h1 id={titleId}>ကြိုဆိုဘောနပ်စ်<span>5,000 <small>ကျပ်</small></span></h1>
      <p className="welcome-bonus-sub">ပထမဆုံး ၅,၀၀၀ ကျပ်နှင့်အထက် ငွေသွင်းပြီး ရယူပါ</p>
      <BonusPreview amount={5000} />
      {unavailable ? <p className="welcome-bonus-unavailable" role="status">ဤအကောင့်အတွက် ကြိုဆိုဘောနပ်စ် ရယူခွင့်မရှိတော့ပါ။</p>
        : <button type="button" className="welcome-bonus-take" onClick={onTake}><span aria-hidden="true">🎁</span>{guest ? "အကောင့်ဖွင့်ပြီး ရယူမည်" : "ဘောနပ်စ်ယူမည်"}</button>}
      {onClose ? <button type="button" className="welcome-bonus-later" onClick={onClose}>နောက်မှ</button> : null}
    </section>
  );
}

export function WelcomeBonusModal({ onTake, onClose }: { onTake: () => void; onClose: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = dialog.current;
    element?.querySelector<HTMLButtonElement>("button")?.focus();
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key !== "Tab" || !element) return;
      const buttons = Array.from(element.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
      const first = buttons[0]; const last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    document.addEventListener("keydown", handleKey);
    return () => { document.removeEventListener("keydown", handleKey); if (previous?.isConnected) previous.focus(); };
  }, [onClose]);
  return (
    <div className="welcome-bonus-overlay" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="welcome-bonus-dialog" role="dialog" aria-modal="true" aria-labelledby="welcome-bonus-title" ref={dialog}>
        <BonusOffer onTake={onTake} onClose={onClose} titleId="welcome-bonus-title" />
      </div>
    </div>
  );
}
