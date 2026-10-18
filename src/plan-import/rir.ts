import type { CatalogExercise, Modifier } from "./types.js";

export interface RirInput {
  options: Pick<CatalogExercise, "type" | "is_main_lift">[];
  modifiers: Modifier[];
  weekIsDeload: boolean;
}

/** RIR from rules only. Notes are never read. */
export function computeRir(input: RirInput): { rir_min: number | null; rir_max: number | null } {
  const { options, modifiers, weekIsDeload } = input;
  const loadMath = options.some((o) => o.type === "weighted" || o.type === "bodyweight_plus");
  if (!loadMath) return { rir_min: null, rir_max: null };
  if (modifiers.includes("test")) return { rir_min: 0, rir_max: 1 };
  if (
    weekIsDeload ||
    modifiers.includes("easy") ||
    modifiers.includes("light") ||
    modifiers.includes("deload")
  ) {
    return { rir_min: 3, rir_max: 4 };
  }
  if (options.some((o) => o.is_main_lift)) return { rir_min: 1, rir_max: 2 };
  return { rir_min: 1, rir_max: 3 };
}
