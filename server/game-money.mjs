import { money, moneyNumber } from "./money.mjs";

// The app and payment gateway use whole kyat. The game API uses 100 minor
// units per kyat. Persist the remainder separately; never round a settlement.
export const GAME_MONEY_SCALE = 100n;

export function gameBalance(kyat, remainder = 0) {
  const fraction = money(remainder);
  if (fraction >= GAME_MONEY_SCALE) throw new Error("Invalid kyat remainder");
  return moneyNumber(money(kyat) * GAME_MONEY_SCALE + fraction);
}

export function splitGameBalance(minor) {
  const amount = money(minor);
  return { balance: Number(amount / GAME_MONEY_SCALE), balance_minor: Number(amount % GAME_MONEY_SCALE) };
}
