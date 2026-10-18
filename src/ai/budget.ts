import type { TokenUsage, UsageStore } from "../logging/types.js";
import type { IntentResponse } from "./model.js";

/** True when today's or this month's token total has reached its cap. */
export async function overTokenBudget(
  usage: UsageStore,
  now: Date,
  caps: { dailyTokenCap: number; monthlyTokenCap: number },
): Promise<boolean> {
  const totals = await usage.totals(now);
  return totals.day >= caps.dailyTokenCap || totals.month >= caps.monthlyTokenCap;
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
