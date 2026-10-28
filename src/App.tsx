import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { authenticate, getSession, signOut } from "./lib/auth";
import { launchGame, loadGames, loadSlotBets, type Game, type SlotBet } from "./lib/game";
import WalletCenter from "./WalletCenter";
import AdminDashboard from "./AdminDashboard";

type Mode = "signin" | "signup";
type NavTab = "cashier" | "games" | "bonuses" | "profile";
type GameFilter = "popular" | "cards" | "slots" | "buffalo" | "all";

type Profile = {
  phone: string;
  balance: number;
  created_at: string;
};
type Session = { user: { id: string; name?: string; username?: string } };

type GameLaunchOption = {
  id: string;
  tableId: string;
  name: string;
  minBet?: number;
  maxBet?: number;
  tierIndex: number;
};

const GAME_CATEGORIES: ReadonlyArray<{ id: GameFilter; label: string; icon: string }> = [
  { id: "popular", label: "နာမည်ကြီး", icon: "https://cdn.myanmarshankoeme.com/build/assets/img/bf688/smt223_hot.png" },
  { id: "cards", label: "ဖဲဂိမ်း", icon: "https://cdn.myanmarshankoeme.com/build/assets/img/bf688/pok3.webp" },
  { id: "slots", label: "စလော့ဂိမ်း", icon: "https://cdn.myanmarshankoeme.com/build/assets/img/bf688/smt223_slot.png" },
  { id: "buffalo", label: "ကျွဲဂိမ်း", icon: "https://cdn.myanmarshankoeme.com/build/assets/img/bf688/smt223_buffalo2.webp" },
  { id: "all", label: "အားလုံး", icon: "https://cdn.myanmarshankoeme.com/build/assets/img/bf688/smt223_arcade.png" },
];

const GAME_PALETTES: ReadonlyArray<readonly [string, string]> = [
  ["#31200f", "#a87320"], ["#102e2b", "#168c76"], ["#30151a", "#ae3f32"],
  ["#1a2441", "#4b69a7"], ["#292014", "#8e7129"], ["#25182d", "#7950a2"],
];

const POOL_TIER_IMAGES = [
  "https://cdn.myanmarshankoeme.com/build/assets/img/bf688/%E1%80%9C%E1%80%B0%E1%80%9E%E1%80%85%E1%80%BA.png",
  "https://cdn.myanmarshankoeme.com/build/assets/img/bf688/%E1%80%82%E1%80%BB%E1%80%B0%E1%80%94%E1%80%AE%E1%80%9A%E1%80%AC.png",
  "https://cdn.myanmarshankoeme.com/build/assets/img/bf688/%E1%80%85%E1%80%AE%E1%80%94%E1%80%AE%E1%80%9A%E1%80%AC.png",
  "https://cdn.myanmarshankoeme.com/build/assets/img/bf688/%E1%80%98%E1%80%B1%E1%80%AC%E1%80%B7%E1%80%85%E1%80%BA.png",
  "https://cdn.myanmarshankoeme.com/build/assets/img/bf688/%E1%80%99%E1%80%AE%E1%80%9C%E1%80%AE%E1%80%9A%E1%80%B6%E1%80%94%E1%80%AC.png",
  "https://cdn.myanmarshankoeme.com/build/assets/img/bf688/%E1%80%98%E1%80%AE%E1%80%9C%E1%80%AE%E1%80%9A%E1%80%B6%E1%80%94%E1%80%AC.png",
];

function gamePalette(code: string): readonly [string, string] {
  const score = [...code].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return GAME_PALETTES[score % GAME_PALETTES.length];
}

function gameLaunchOptions(game: Game): GameLaunchOption[] {
  const pools = (game.pools ?? [])
    .filter((pool) => pool.currency === "MMK")
    .map((pool) => ({
      id: `pool-${pool.pool_id}`,
      tableId: pool.pool_id,
      name: pool.name,
      minBet: pool.limits?.min_bet,
      maxBet: pool.limits?.max_bet,
    }));
  const tables = (game.tables ?? [])
    .filter((table) => table.currency === "MMK")
    .map((table) => ({
      id: `table-${table.table_id}`,
      tableId: table.table_id,
      name: table.name,
      minBet: table.limits?.min_bet,
      maxBet: table.limits?.max_bet,
    }));
  return [...pools, ...tables]
    .sort((a, b) => (a.minBet ?? Number.MAX_SAFE_INTEGER) - (b.minBet ?? Number.MAX_SAFE_INTEGER))
    .map((option, tierIndex) => ({ ...option, tierIndex }));
}

const BANNERS = [
  "https://cdn.myanmarshankoeme.com/build/assets/img/bf688/smt223_banner2.webp",
  "https://cdn.myanmarshankoeme.com/build/assets/img/bf688/smt223_banner1.webp",
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
  if (text.includes("at least 8") || text.includes("between 8 and 128")) return "စကားဝှက် ၈ လုံးမှ ၁၂၈ လုံးအတွင်း ထည့်ပါ";
  if (text.includes("too many")) return "အကြိမ်များစွာ ကြိုးစားထားပါသည်။ ခဏစောင့်ပြီး ပြန်လည်ကြိုးစားပါ။";
  if (text.includes("temporarily unavailable") || text.includes("could not complete authentication")) return "ယာယီအသုံးပြု၍ မရသေးပါ။ ခဏစောင့်ပြီး ပြန်လည်ကြိုးစားပါ။";
  if (text.includes("could not create account")) return "အကောင့်ဖွင့်၍ မရပါ။ အကောင့်ဝင်ရန် ကြိုးစားပါ သို့မဟုတ် အခြားဖုန်းနံပါတ်ကို အသုံးပြုပါ။";
  if (text.includes("enter a password")) return "စကားဝှက် ထည့်ပါ";
  if (text.includes("invalid") || text.includes("credentials") || text.includes("unauthorized") || text.includes("incorrect")) {
    return "ဖုန်းနံပါတ် သို့မဟုတ် စကားဝှက် မှားနေသည်";
  }
  return /[\u1000-\u109f]/.test(message) ? message : "မအောင်မြင်ပါ။ ထပ်ကြိုးစားပါ";
}

export default function App() {
  const isAdminRoute = window.location.pathname.replace(/\/+$/, "") === "/admin";
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
  const [playing, setPlaying] = useState(false);
  const [selectedGame, setSelectedGame] = useState<Game | null>(null);
  const [games, setGames] = useState<Game[]>([]);
  const [gamesLoading, setGamesLoading] = useState(true);
  const [failedGameImages, setFailedGameImages] = useState<Record<string, boolean>>({});
  const [failedPoolTierImages, setFailedPoolTierImages] = useState<Record<number, boolean>>({});
  const [walletOpen, setWalletOpen] = useState(false);
  const [walletMode, setWalletMode] = useState<"deposit" | "withdraw">("deposit");
  const [navTab, setNavTab] = useState<NavTab>("games");
  const [gameFilter, setGameFilter] = useState<GameFilter>("popular");
  const [bannerIdx, setBannerIdx] = useState(0);
  const [bannerFailed, setBannerFailed] = useState<Record<number, boolean>>({});
  const [scrolled, setScrolled] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isAdminRoute) {
      setReady(true);
      return;
    }
    getSession().then((data) => setSession(data?.user ? data as Session : null))
      .catch(() => setSession(null))
      .finally(() => setReady(true));
  }, []);

  useEffect(() => {
    if (isAdminRoute) return;
    let active = true;
    loadGames()
      .then((items) => {
        if (active) setGames(items.filter((game) =>
          (game.pools ?? []).some((pool) => pool.currency === "MMK") ||
          (game.tables ?? []).some((table) => table.currency === "MMK"),
        ));
      })
      .catch(() => {
        if (active) setGames([]);
      })
      .finally(() => {
        if (active) setGamesLoading(false);
      });
    return () => {
      active = false;
    };
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
      setSelectedGame(null);
      setMode("signup");
      setAuthOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign out");
    } finally {
      setBusy(false);
    }
  }

  function onPlayGame(game: Game) {
    if (!session) {
      setSelectedGame(game);
      openAuth("signup");
      return;
    }
    setError("");
    const launchOptions = gameLaunchOptions(game);
    if (launchOptions.length === 1) {
      void onSelectStake(game, launchOptions[0].tableId);
      return;
    }
    setSelectedGame(game);
  }

  async function onSelectStake(game: Game, tableId: string) {
    setPlaying(true);
    setError("");
    try {
      const url = await launchGame(game.game_code, tableId);
      window.location.assign(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open the game");
      setPlaying(false);
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
              minLength={signingIn ? 1 : 8}
              maxLength={128}
              placeholder={signingIn ? "စကားဝှက် ရိုက်ပါ" : "အနည်းဆုံး ၈ လုံး"}
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
  const visibleGames = games
    .filter((game) => {
      const isBuffalo = game.name.toLowerCase().includes("buffalo");
      const mmkPoolCount = (game.pools ?? []).filter((pool) => pool.currency === "MMK").length;
      if (gameFilter === "popular") return game.is_hot === true;
      if (gameFilter === "cards") return !isBuffalo && mmkPoolCount > 1;
      if (gameFilter === "slots") return !isBuffalo && mmkPoolCount <= 1;
      if (gameFilter === "buffalo") return isBuffalo;
      return true;
    })
    .sort((a, b) => {
      if (gameFilter === "popular") {
        return (b.players_online ?? 0) - (a.players_online ?? 0) || (a.sort_order ?? 0) - (b.sort_order ?? 0);
      }
      return (a.sort_order ?? 0) - (b.sort_order ?? 0);
    });
  const sectionTitle = GAME_CATEGORIES.find((category) => category.id === gameFilter)?.label ?? "အားလုံး";
  const bannerSrc = bannerFailed[bannerIdx] ? BANNERS[(bannerIdx + 1) % BANNERS.length] : BANNERS[bannerIdx];
  const stakeOptions = selectedGame ? gameLaunchOptions(selectedGame) : [];

  if (isAdminRoute) return <AdminDashboard />;

  return (
    <div className="telegram-app-root">
      <div className="telegram-app-content">
        <div className="shell">
          <header className={`app-top-bar${scrolled ? " scrolled" : ""}`}>
            <img className="brand-logo" src="/images/brand-logo.png" alt="JL Win777" />
            {session ? (
              <div className="balance-chip">
                <div className="balance-value">
                  <img className="balance-coin" src="/images/balance-coin.png" alt="" aria-hidden="true" />
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
                  {GAME_CATEGORIES.map(({ id, label, icon }) => (
                    <button
                      key={id}
                      type="button"
                      className={`chip${gameFilter === id ? " active" : ""}`}
                      aria-pressed={gameFilter === id}
                      onClick={() => setGameFilter(id)}
                    >
                      <img src={icon} alt="" aria-hidden="true" />
                      <span>{label}</span>
                    </button>
                  ))}
                </div>

                <div className="games-section">
                  <p className="games-title">{sectionTitle}</p>
                  {visibleGames.length ? (
                    <div className="games-grid">
                      {visibleGames.map((game, index) => {
                        const [gradientStart, gradientEnd] = gamePalette(game.game_code);
                        const artStyle = {
                          "--game-glow": `${gradientStart}47`,
                          "--game-glow-hover": `${gradientStart}66`,
                          backgroundImage: `linear-gradient(155deg, ${gradientStart}, ${gradientEnd})`,
                          animationDelay: `${index * 0.03}s`,
                        } as CSSProperties;
                        const gameKey = game.game_code;
                        return (
                          <button key={gameKey} type="button" className="game-tile" onClick={() => onPlayGame(game)} disabled={playing}>
                            <div
                              className="game-art"
                              style={artStyle}
                              onMouseMove={(event) => {
                                const rect = event.currentTarget.getBoundingClientRect();
                                const x = (event.clientX - rect.left) / rect.width - 0.5;
                                const y = (event.clientY - rect.top) / rect.height - 0.5;
                                event.currentTarget.style.setProperty("--game-tilt-x", `${-y * 18}deg`);
                                event.currentTarget.style.setProperty("--game-tilt-y", `${x * 18}deg`);
                              }}
                              onMouseLeave={(event) => {
                                event.currentTarget.style.setProperty("--game-tilt-x", "0deg");
                                event.currentTarget.style.setProperty("--game-tilt-y", "0deg");
                              }}
                            >
                              {game.image_url && !failedGameImages[gameKey] ? (
                                <img src={game.image_url} alt={game.name} onError={() => setFailedGameImages((current) => ({ ...current, [gameKey]: true }))} />
                              ) : (
                                <span className="game-art-placeholder">{game.name}</span>
                              )}
                            </div>
                            {game.players_online != null ? <span className="game-players"><i />{Number(game.players_online).toLocaleString("en-US")}ယောက်</span> : null}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="games-empty">{gamesLoading ? "ဂိမ်းဖွင့်နေသည်…" : "ဂိမ်းမရှိသေးပါ"}</div>
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

          {selectedGame && session ? (
            <div className="game-stake-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !playing) setSelectedGame(null); }}>
              <section className="game-stake-sheet" role="dialog" aria-modal="true" aria-labelledby="game-stake-title">
                <button className="game-stake-close" type="button" onClick={() => { if (!playing) setSelectedGame(null); }} aria-label="Close">{Ic.close}</button>
                <span className="game-stake-kicker">ကစားရန်</span>
                <h2 id="game-stake-title">{selectedGame.name}</h2>
                <p>လောင်းကြေးအဆင့် ရွေးပါ</p>
                <div className={`game-stake-options${stakeOptions.length > 1 ? " pool-tier-grid" : ""}`}>
                  {stakeOptions.map((option) => {
                    const tierImage = POOL_TIER_IMAGES[option.tierIndex];
                    const showTierImage = Boolean(tierImage && !failedPoolTierImages[option.tierIndex]);
                    const amount = option.minBet != null ? `${Number(option.minBet).toLocaleString("en-US")} Ks` : "MMK";
                    const range = option.maxBet != null
                      ? `${amount} – ${Number(option.maxBet).toLocaleString("en-US")} Ks`
                      : amount;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        className={showTierImage ? "pool-tier-card" : "pool-tier-card pool-tier-fallback"}
                        aria-label={`${option.name}, ${range}`}
                        title={`${option.name} · ${range}`}
                        disabled={playing}
                        onClick={() => void onSelectStake(selectedGame, option.tableId)}
                      >
                        {showTierImage ? <img src={tierImage} alt="" aria-hidden="true" onError={() => setFailedPoolTierImages((current) => ({ ...current, [option.tierIndex]: true }))} /> : <span className="pool-tier-fallback-copy"><strong>{option.name}</strong><small>{range}</small></span>}
                      </button>
                    );
                  })}
                  {!stakeOptions.length ? <div className="games-empty">ယခုအချိန်တွင် MMK လောင်းကြေးအဆင့် မရှိသေးပါ</div> : null}
                </div>
                {error ? <p className="error game-stake-error">{error}</p> : null}
              </section>
            </div>
          ) : null}

          {playing ? (
            <div className="game-launch-loading" role="status" aria-live="polite">
              <span className="game-launch-spinner" aria-hidden="true" />
              <strong>ဂိမ်းဖွင့်နေပါသည်</strong>
              <span>ခဏစောင့်ပေးပါ…</span>
            </div>
          ) : null}

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
