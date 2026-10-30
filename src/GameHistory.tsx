import type { ReactNode } from "react";
import type { Game, SlotBet } from "./lib/game";
import { formatMoney } from "./lib/format-money";

export default function GameHistory({ bets, games, icon }: { bets: SlotBet[]; games: Game[]; icon: ReactNode }) {
  return <div className="profile-activity-list">{bets.slice(0, 5).map((bet) => {
    const banker = bet.activity_type === "banker";
    const status = bet.status ?? "settled";
    const settled = status === "settled";
    const name = games.find((game) => game.game_code === bet.game_code)?.name ?? bet.game_code ?? (bet.game_id ? `Game ${bet.game_id}` : "ဂိမ်း");
    const stateLabel = status === "pending" ? "စစ်ဆေးဆဲ" : status === "cancelled" ? "ပယ်ဖျက်ပြီး" : "ပြီးဆုံးပြီး";
    return <div className="profile-activity-row" key={bet.bet_uid}>
      <div className="profile-activity-game">
        <span className="profile-activity-icon">{icon}</span>
        <span><strong title={name}>{name}{banker ? " · ဘဏ်ကိုင်" : ""}</strong>
          <small>{bet.created_at ? new Date(bet.created_at).toLocaleString("my-MM", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Rangoon" }) : ""} · {stateLabel}</small>
        </span>
      </div>
      <div className="profile-activity-amounts">
        <span>{banker ? "သီးသန့်ငွေ" : "လောင်းကြေး"} {formatMoney(banker ? bet.held_amount : bet.bet)} ကျပ်</span>
        {!banker && status === "pending" && Number(bet.held_amount) > Number(bet.bet) ? <span>သီးသန့်ငွေ {formatMoney(bet.held_amount)} ကျပ်</span> : null}
        <strong className={settled && Number(bet.changemoney) > 0 ? "won" : settled && Number(bet.changemoney) < 0 ? "lost" : ""}>
          {settled ? `${formatMoney(bet.changemoney, true)} ကျပ်` : stateLabel}
        </strong>
      </div>
    </div>;
  })}</div>;
}
