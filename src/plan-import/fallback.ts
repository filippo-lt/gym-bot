import type { FallbackPrescription } from "./types.js";

export const PULL_UP_FALLBACK: FallbackPrescription = {
  if_bw_max_gte: 4,
  // biome-ignore lint/suspicious/noThenProperty: field name is fixed by the FallbackPrescription contract
  then: { sets: 4, reps_min: 4, reps_max: 6, mode: "bodyweight" },
  else: { sets: 4, reps_min: 6, reps_max: 6, mode: "assisted" },
};

export function fallbackFor(optionSlugs: string[]): FallbackPrescription | null {
  return optionSlugs.includes("pull_up") ? structuredClone(PULL_UP_FALLBACK) : null;
}
