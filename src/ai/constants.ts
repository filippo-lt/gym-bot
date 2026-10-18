/** Wall-clock budget for one intent loop (all model calls and tool executions). */
export const AI_BUDGET_MS = 40_000;
export const AI_BUDGET_S = AI_BUDGET_MS / 1000;
/** Maximum model calls per user message. */
export const AI_MAX_TURNS = 6;
