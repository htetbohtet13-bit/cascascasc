import { randomInt } from "node:crypto";

export function parsePlayerCount(value) {
  if (value == null || value === "") return { min: null, max: null };
  if (typeof value !== "string" && typeof value !== "number") return null;
  const input = String(value).trim();
  if (!input) return { min: null, max: null };
  const match = /^(\d{1,10})(?:\s*[-–]\s*(\d{1,10}))?$/.exec(input);
  if (!match) return null;
  const min = Number(match[1]); const max = match[2] === undefined ? min : Number(match[2]);
  if (min > 1_000_000_000 || max > 1_000_000_000 || max < min) return null;
  return { min, max: max === min ? null : max };
}

export function displayedPlayerCount(min, max, randomInteger = randomInt) {
  if (min == null) return null;
  return max == null || max === min ? min : randomInteger(min, max + 1);
}
