/**
 * Moves of the Thursday class (blackboard photo or a description), with the per-group breakdown.
 * The breakdown is computed here, never by the model (SPEC §3).
 */
import { z } from "zod";

export const CLASS_GROUPS = ["pull", "push", "legs", "core", "other"] as const;
export type ClassGroup = (typeof CLASS_GROUPS)[number];

export const classMoveSchema = z.strictObject({
  name: z.string().trim().min(1).max(60),
  sets: z.number().int().min(1).max(50).optional(),
  reps: z.number().int().min(1).max(500).optional(),
  duration_s: z.number().int().min(1).max(3600).optional(),
  /** Every group the move loads; a move counts once in each. */
  groups: z.array(z.enum(CLASS_GROUPS)).min(1).max(5),
});
export type ClassMove = z.infer<typeof classMoveSchema>;

/** Moves, written sets and how many moves had sets, per group, in CLASS_GROUPS order; groups without moves are left out. */
export function classBreakdown(
  moves: ClassMove[],
): { group: ClassGroup; moves: number; sets: number; setMoves: number }[] {
  const out: { group: ClassGroup; moves: number; sets: number; setMoves: number }[] = [];
  for (const group of CLASS_GROUPS) {
    const inGroup = moves.filter((m) => m.groups.includes(group));
    if (inGroup.length === 0) continue;
    out.push({
      group,
      moves: inGroup.length,
      // Only sets the class report wrote; moves without sets add nothing.
      sets: inGroup.reduce((sum, m) => sum + (m.sets ?? 0), 0),
      setMoves: inGroup.filter((m) => m.sets !== undefined).length,
    });
  }
  return out;
}
