/** Wall-clock budget for one intent loop (all model calls and tool executions). */
export const AI_BUDGET_MS = 40_000;
export const AI_BUDGET_S = AI_BUDGET_MS / 1000;
/** Maximum model calls per user message. */
export const AI_MAX_TURNS = 6;
/** Cost guard weights vs. a plain input token (Anthropic prices: write 1.25x, read 0.1x). */
export const CACHE_WRITE_WEIGHT = 1.25;
export const CACHE_READ_WEIGHT = 0.1;
