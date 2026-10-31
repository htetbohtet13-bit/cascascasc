export function playerCountLabel(min?: number | null, max?: number | null) {
  return min == null ? "" : max == null || max === min ? String(min) : `${min}-${max}`;
}
