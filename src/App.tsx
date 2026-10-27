import { useEffect, useRef, useState, type FormEvent } from "react";
import { authenticate, getSession, signOut } from "./lib/auth";
import { launchGame, loadSlotBets, type SlotBet } from "./lib/game";
import WalletCenter from "./WalletCenter";
import AdminDashboard from "./AdminDashboard";

type Mode = "signin" | "signup";
type NavTab = "cashier" | "games" | "bonuses" | "profile";
type GameFilter = "all" | "popular" | "cards" | "buffalo";

type Profile = {
  phone: string;
  balance: number;
  game_uid: string;
  created_at: string;
};
type Session = { user: { id: string; name?: string; username?: string } };

const BANNERS = [
  "https://9blqhfvaufeml8ge.public.blob.vercel-storage.com/banners/ChatGPT%20Image%20Jul%2029%2C%202026%2C%2008_27_15%20PM.webp",
  "https://9blqhfvaufeml8ge.public.blob.vercel-storage.com/banners/ChatGPT%20Image%20Jul%2029%2C%202026%2C%2009_08_27%20PM.webp",
  "/images/JL-banner.jpg",
];

const Ic = {
  cashier: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
      <path d="M5 9h14" />
    </svg>
  ),
  games: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 7h8a4.5 4.5 0 0 1 4.3 3.2l1.1 3.8a2.9 2.9 0 0 1-5 2.6L14.8 15H9.2l-1.6 1.6a2.9 2.9 0 0 1-5-2.6l1.1-3.8A4.5 4.5 0 0 1 8 7Z" />
      <path d="M7 10.5v4M5 12.5h4M16.5 11.5h.01M18.5 13.5h.01" />
    </svg>
  ),
  gift: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 10h18v11H3zM2 6h20v4H2zM12 6v15" />
      <path d="M12 6H8.5a2.5 2.5 0 1 1 2.4-3.2L12 6Zm0 0h3.5a2.5 2.5 0 1 0-2.4-3.2L12 6Z" />
    </svg>
  ),
  profile: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="3.3" />
      <path d="M5.5 20a6.5 6.5 0 0 1 13 0" />
    </svg>
  ),
  close: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  ),
  headphones: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
      <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
    </svg>
  ),
};

function friendlyAuthError(message: string) {
  const text = message.toLowerCase();
  if (text.includes("already registered")) return "ဤဖုန်းနံပါတ် ရှိပြီးသား ဖြစ်သည်";
  if (text.includes("valid phone")) return "ဖုန်းနံပါတ် မှန်အောင် ရိုက်ပါ";
  if (text.includes("at least 6")) return "စကားဝှက် အနည်းဆုံး ၆ လုံး ထည့်ပါ";
  if (text.includes("enter a password")) return "စကားဝှက် ထည့်ပါ";
  if (text.includes("invalid") || text.includes("credentials") || text.includes("unauthorized")) {
    return "ဖုန်းနံပါတ် သို့မဟုတ် စကားဝှက် မှားနေသည်";
  }
  return message || "မအောင်မြင်ပါ။ ထပ်ကြိုးစားပါ";
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [bets, setBets] = useState<SlotBet[]>([]);
  const [ready, setReady] = useState(false);
  const [authOpen, setAuthOpen] = useState(true);
  const [mode, setMode] = useState<Mode>("signup");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copiedUid, setCopiedUid] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [walletOpen, setWalletOpen] = useState(false);
  const [walletMode, setWalletMode] = useState<"deposit" | "withdraw">("deposit");
  const [navTab, setNavTab] = useState<NavTab>("games");
  const [gameFilter, setGameFilter] = useState<GameFilter>("popular");
  const [bannerIdx, setBannerIdx] = useState(0);
  const [bannerFailed, setBannerFailed] = useState<Record<number, boolean>>({});
  const [scrolled, setScrolled] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getSession().then((data) => setSession(data?.user ? data as Session : null))
      .catch(() => setSession(null))
      .finally(() => setReady(true));
  }, []);

  useEffect(() => {
    if (!session) {
      setProfile(null);
      setBets([]);
      return;
    }

    fetch("/api/me", { credentials: "include" })
      .then((response) => response.ok ? response.json() : null)
      .then((data) => setProfile(data?.profile ?? null));

    loadSlotBets(session.user.id)
      .then(setBets)
      .catch(() => setBets([]));
  }, [session]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setBannerIdx((current) => (current + 1) % BANNERS.length);
    }, 4200);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => setScrolled(el.scrollTop > 8);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [session, navTab]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");

    setBusy(true);
    try {
      await authenticate(mode, phone, password);
      const nextSession = await getSession();
      setSession(nextSession?.user ? nextSession as Session : null);
      setPassword("");
    } catch (err) {
      setError(friendlyAuthError(err instanceof Error ? err.message : ""));
    } finally {
      setBusy(false);
    }
  }

  async function onSignOut() {
    setBusy(true);
    setError("");
    try {
      await signOut();
      setSession(null);
      setProfile(null);
      setNavTab("games");
      setWalletOpen(false);
      setMode("signup");
      setAuthOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign out");
    } finally {
      setBusy(false);
    }
  }

  async function onPlayBuffalo() {
    if (!session) {
      openAuth("signup");
      return;
    }

    setPlaying(true);
    setError("");
    try {
      const url = await launchGame(23, 1);
      window.location.assign(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open the game");
      setPlaying(false);
    }
  }

  async function onCopyGameUid() {
    const uid = profile?.game_uid;
    if (!uid) return;
    try {
      await navigator.clipboard.writeText(uid);
      setCopiedUid(true);
    } catch {
      setError("Game ID ကို ကူးယူ၍မရပါ");
    }
  }

  function openAuth(nextMode: Mode = "signup") {
    setMode(nextMode);
    setError("");
    setAuthOpen(true);
  }

  function openWallet(nextMode: "deposit" | "withdraw" = "deposit") {
    if (!session) {
      openAuth("signup");
      return;
    }
    setWalletMode(nextMode);
    setWalletOpen(true);
    setNavTab("cashier");
  }

  function handleNav(id: NavTab) {
    if (!session && (id === "cashier" || id === "profile")) {
      openAuth("signup");
      return;
    }
    if (id === "cashier") {
      openWallet("deposit");
      return;
    }
    setWalletOpen(false);
    setNavTab(id);
    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }

  if (!ready) {
    return (
      <div className="loading-screen">
        <div className="spinner" />
      </div>
    );
  }

  const signingIn = mode === "signin";
  const authDialog = !session && authOpen ? (
    <div className="auth-overlay" role="presentation">
      <div className="auth-topbar">
        <img src="/images/brand-logo.png" alt="JL Win777" />
        <button
          type="button"
          className="auth-close"
          aria-label="ပိတ်မည်"
          onClick={() => {
            setAuthOpen(false);
            setError("");
          }}
        >
          {Ic.close}
        </button>
      </div>
      <section className="auth-box" role="dialog" aria-modal="true" aria-labelledby="auth-title">
        <h1 id="auth-title">{signingIn ? "အကောင့်ဝင်ပါ" : "အကောင့်အသစ်ဖွင့်ပါ"}</h1>
        <p className="auth-switch-line">
          {signingIn ? "အကောင့်မရှိသေးဘူးလား?" : "အကောင့်ရှိပြီးသားလား?"}{" "}
          <button
            type="button"
            onClick={() => {
              setMode(signingIn ? "signup" : "signin");
              setError("");
            }}
          >
            {signingIn ? "အကောင့်ဖွင့်ပါ" : "ဝင်မည်"}
          </button>
        </p>

        <form className="auth-form" onSubmit={onSubmit}>
          <label>
            {signingIn ? "ဖုန်းနံပါတ်" : "သင့်ဖုန်းနံပါတ်"}
            <input
              type="tel"
              name="phone"
              autoComplete="tel"
              inputMode="numeric"
              placeholder="09xxxxxxxxx"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              required
            />
          </label>
          <label>
            {signingIn ? "စကားဝှက်" : "နှစ်သက်ရာ စကားဝှက်"}
            <input
              type="text"
              name="password"
              autoComplete={signingIn ? "current-password" : "new-password"}
              minLength={6}
              placeholder={signingIn ? "စကားဝှက် ရိုက်ပါ" : "အနည်းဆုံး ၆ လုံး"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          {error ? <p className="error">{error}</p> : null}
          <button className="gold-btn" type="submit" disabled={busy}>
            {busy ? "ခဏစောင့်ပါ…" : signingIn ? "ဝင်မည်" : "အကောင့်ဖွင့်မည်"}
          </button>
        </form>
      </section>
    </div>
  ) : null;

  const phoneNumber =
    profile?.phone ??
    session?.user.name ??
    "—";
  const balance = profile?.balance ?? 0;
  const showBuffalo = gameFilter !== "cards";
  const sectionTitle =
    gameFilter === "all"
      ? "အားလုံးဂိမ်းများ"
      : gameFilter === "popular"
        ? "ရေပန်းစားသော ဂိမ်းများ"
        : gameFilter === "cards"
          ? "ကတ်ဂိမ်းများ"
          : "ကျွဲဂိမ်းများ";
  const bannerSrc = bannerFailed[bannerIdx] ? "/images/JL-banner.jpg" : BANNERS[bannerIdx];

  if (window.location.pathname.replace(/\/+$/, "") === "/admin") {
    return <AdminDashboard />;
  }

  return (
    <div className="telegram-app-root">
      <div className="telegram-app-content">
        <div className="shell">
          <header className={`app-top-bar${scrolled ? " scrolled" : ""}`}>
            <img className="brand-logo" src="/images/brand-logo.png" alt="JL Win777" />
            {session ? (
              <div className="balance-chip">
                <div className="balance-value">
                  <strong>{balance.toLocaleString("en-US")}</strong>
                  <span>Ks</span>
                </div>
                <div className="balance-divider" />
                <button type="button" className="topup-chip" onClick={() => openWallet("deposit")}>
                  <span>+</span>
                  ငွေဖြည့်
                </button>
                <button type="button" className="withdraw-chip" onClick={() => openWallet("withdraw")}>
                  ငွေထုတ်
                </button>
              </div>
            ) : null}
            {!session ? (
              <button type="button" className="guest-sign-in" onClick={() => openAuth("signup")}>
                အကောင့်ဖွင့်
              </button>
            ) : null}
          </header>

          <div className="body-scroll" ref={scrollRef}>
            {navTab === "profile" ? (
              <section className="profile-page">
                <div className="profile-heading">
                  <div className="profile-kicker">အကောင့်</div>
                  <h1>ကျွန်ုပ်၏ အကောင့်</h1>
                  <p>သင့်အကောင့်နှင့် ငွေလက်ကျန်ကို စီမံပါ</p>
                </div>

                <section className="profile-account-card" aria-label="Account information">
                  <div className="profile-account-top">
                    <div className="profile-mark">{Ic.profile}</div>
                    <div className="profile-account-name">
                      <strong>{phoneNumber}</strong>
                      <span>J777 အဖွဲ့ဝင်</span>
                    </div>
                  </div>
                  <div className="profile-uid-row">
                    <span>ဂိမ်းအကောင့် ID</span>
                    <strong>{profile?.game_uid ?? "—"}</strong>
                    <button type="button" onClick={onCopyGameUid} disabled={!profile?.game_uid}>
                      {copiedUid ? "ကူးပြီးပါပြီ" : "ကူးယူရန်"}
                    </button>
                  </div>
                </section>

                <section className="profile-balance-card" aria-label="Wallet balance">
                  <div className="profile-balance-heading">
                    <span>လက်ကျန်ငွေ</span>
                    <strong>{balance.toLocaleString("en-US")} <small>Ks</small></strong>
                  </div>
                  <div className="profile-wallet-actions">
                    <button type="button" className="profile-topup-action" onClick={() => openWallet("deposit")}>
                      <span aria-hidden="true">＋</span> ငွေဖြည့်
                    </button>
                    <button type="button" className="profile-withdraw-action" onClick={() => openWallet("withdraw")}>
                      <span aria-hidden="true">↓</span> ငွေထုတ်
                    </button>
                  </div>
                </section>

                <section className="profile-activity-section">
                  <div className="profile-section-heading">
                    <h2>နောက်ဆုံးကစားမှု</h2>
                    <span>{bets.length ? `${bets.length} ကြိမ်` : ""}</span>
                  </div>
                  {bets.length ? (
                    <div className="profile-activity-list">
                      {bets.slice(0, 5).map((bet) => (
                        <div className="profile-activity-row" key={bet.bet_uid}>
                          <div className="profile-activity-game">
                            <span className="profile-activity-icon">{Ic.games}</span>
                            <span>
                              <strong>{bet.game_id ? `Game ${bet.game_id}` : "ဂိမ်း"}</strong>
                              <small>{bet.created_at ? new Date(bet.created_at).toLocaleDateString("en-US") : ""}</small>
                            </span>
                          </div>
                          <div className="profile-activity-amounts">
                            <span>လောင်း {Number(bet.bet).toLocaleString("en-US")} Ks</span>
                            <strong className={Number(bet.win) > 0 ? "won" : ""}>
                              {Number(bet.win) > 0 ? "+" : ""}{Number(bet.win).toLocaleString("en-US")} Ks
                            </strong>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="profile-activity-empty">
                      <p>ကစားမှုမှတ်တမ်း မရှိသေးပါ</p>
                      <button type="button" onClick={() => handleNav("games")}>ဂိမ်းကြည့်ရန်</button>
                    </div>
                  )}
                </section>

                {error ? <p className="error profile-error">{error}</p> : null}
                <button type="button" className="sign-out" onClick={onSignOut} disabled={busy}>
                  {busy ? "ထွက်နေသည်…" : "အကောင့်မှ ထွက်ရန်"}
                </button>
              </section>
            ) : navTab === "bonuses" ? (
              <div className="placeholder-panel">ဘောနပ်စ် မရှိသေးပါ</div>
            ) : (
              <>
                <div className="banner-wrap">
                  <div className="banner">
                    <img
                      src={bannerSrc}
                      alt=""
                      onError={() => setBannerFailed((current) => ({ ...current, [bannerIdx]: true }))}
                    />
                    <div className="banner-dots">
                      {BANNERS.map((_, index) => (
                        <button
                          key={index}
                          type="button"
                          className={index === bannerIdx ? "active" : ""}
                          onClick={() => setBannerIdx(index)}
                        />
                      ))}
                    </div>
                  </div>
                </div>

                <div className="chips">
                  {(
                    [
                      ["all", "အားလုံး"],
                      ["popular", "ရေပန်းစား"],
                      ["cards", "ကတ်ဂိမ်း"],
                      ["buffalo", "ကျွဲဂိမ်း"],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      className={`chip${gameFilter === id ? " active" : ""}`}
                      onClick={() => setGameFilter(id)}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <div className="games-section">
                  <p className="games-title">{sectionTitle}</p>
                  {showBuffalo ? (
                    <div className="games-grid">
                      <button type="button" className="game-tile" onClick={onPlayBuffalo} disabled={playing}>
                        <div className="game-art">
                          <img src="/images/buffalo.png" alt="Buffalo" />
                        </div>
                      </button>
                    </div>
                  ) : (
                    <div className="games-empty">ဂိမ်းမရှိသေးပါ</div>
                  )}
                </div>

                <div className="fab-wrap">
                  <button type="button" className="fab" aria-label="Support">
                    {Ic.headphones}
                  </button>
                </div>
              </>
            )}
          </div>

          <nav className={`bottom-navigation${walletOpen ? " hidden" : ""}`}>
            {(
              [
                ["cashier", "ငွေ", Ic.cashier],
                ["games", "ဂိမ်း", Ic.games],
                ["bonuses", "ဘောနပ်စ်", Ic.gift],
                ["profile", "အကောင့်", Ic.profile],
              ] as const
            ).map(([id, label, icon]) => (
              <button
                key={id}
                type="button"
                data-id={id}
                className={`nav-item${navTab === id ? " active" : ""}`}
                onClick={() => handleNav(id)}
              >
                <span className="nav-icon">{icon}</span>
                <span className="nav-label">{label}</span>
              </button>
            ))}
          </nav>

          {walletOpen ? (
            <WalletCenter
              initialTab={walletMode}
              balance={balance}
              defaultPhone={phoneNumber === "—" ? "" : phoneNumber}
              onClose={() => {
                setWalletOpen(false);
                setNavTab("games");
              }}
              onBalance={(next) =>
                setProfile((current) => (current ? { ...current, balance: next } : current))
              }
            />
          ) : null}
        </div>
      </div>
      {authDialog}
    </div>
  );
}
