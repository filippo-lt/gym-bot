import type { TokenUsage, UsageStore } from "../logging/types.js";
import { CACHE_READ_WEIGHT, CACHE_WRITE_WEIGHT } from "./constants.js";
import type { IntentResponse } from "./model.js";

export type BudgetCap = "day" | "month";

/** Tokens the cost guard counts: cache writes and reads are weighted. Not rounded. */
export function countedTokens(
  u: Pick<TokenUsage, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">,
): number {
  return (
    u.inputTokens +
    u.outputTokens +
    CACHE_WRITE_WEIGHT * u.cacheWriteTokens +
    CACHE_READ_WEIGHT * u.cacheReadTokens
  );
}

/** The cap that has been reached (day first), or null when there is room. */
export async function overTokenBudget(
  usage: UsageStore,
  now: Date,
  caps: { dailyTokenCap: number; monthlyTokenCap: number },
): Promise<BudgetCap | null> {
  const totals = await usage.totals(now);
  if (totals.day >= caps.dailyTokenCap) return "day";
  if (totals.month >= caps.monthlyTokenCap) return "month";
  return null;
}

export function tokenUsageOf(model: string, u: IntentResponse["usage"]): TokenUsage {
  return {
    model,
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}
