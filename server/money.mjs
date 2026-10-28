export const MAX_MONEY = 9007199254740991n;

// Check Postgres bigint strings before conversion to the provider's JSON number.
export function money(value) {
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("Invalid money amount");
  if (typeof value !== "bigint" && typeof value !== "number" &&
      !(typeof value === "string" && /^(0|[1-9]\d*)$/.test(value))) throw new Error("Invalid money amount");
  const result = BigInt(value);
  if (result < 0n || result > MAX_MONEY) throw new Error("Balance exceeds supported range");
  return result;
}

export function positiveMoney(value) {
  const result = money(value);
  if (result === 0n) throw new Error("Invalid money amount");
  return result;
}

export const moneyNumber = (value) => Number(money(value));
export const addMoney = (balance, amount) => moneyNumber(money(balance) + money(amount));
export const subtractMoney = (balance, amount) => moneyNumber(money(balance) - money(amount));
