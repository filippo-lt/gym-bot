import type {
  IntentResult,
  LoggingBackend,
  PromptContext,
  PromptStatic,
  StagedAction,
  UsageStore,
} from "../logging/types.js";
import { AI_BUDGET_MS, AI_MAX_TURNS } from "./constants.js";
import type { IntentModel, MessageParam } from "./model.js";
import { buildSystem } from "./prompt.js";
import { executeTool, TOOLS } from "./tools.js";

export interface RunIntentParams {
  text: string;
  model: IntentModel;
  backend: LoggingBackend;
  usage: UsageStore;
  promptStatic: PromptStatic;
  promptContext: PromptContext;
  now: Date;
  dailyTokenCap: number;
  monthlyTokenCap: number;
  maxTurns?: number;
  budgetMs?: number;
}

const MAX_TOKENS = 1024;

export async function runIntent(p: RunIntentParams): Promise<IntentResult> {
  const maxTurns = p.maxTurns ?? AI_MAX_TURNS;
  const budgetMs = p.budgetMs ?? AI_BUDGET_MS;

  /** Checked before every model call: a long loop can reach the cap mid-way. */
  const overBudget = async () => {
    const totals = await p.usage.totals(p.now);
    return totals.day >= p.dailyTokenCap || totals.month >= p.monthlyTokenCap;
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("AI budget exceeded")), budgetMs);
  const system = buildSystem(p.promptStatic, p.promptContext);
  const messages: MessageParam[] = [{ role: "user", content: p.text }];
  const staged: StagedAction[] = [];

  try {
    let turns = 0;
    while (turns < maxTurns) {
      // Nothing staged so far is written when the cap is hit: the bot only reports it.
      if (await overBudget()) return { kind: "budget_reached" };
      turns++;
      const res = await p.model.create({
        system,
        messages,
        tools: TOOLS,
        max_tokens: MAX_TOKENS,
        signal: controller.signal,
      });
      await p.usage.record(
        {
          model: p.model.name,
          inputTokens: res.usage.input_tokens,
          outputTokens: res.usage.output_tokens,
          cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
        },
        p.now,
      );

      const toolUses = res.content.filter((b) => b.type === "tool_use");
      if (res.stop_reason !== "tool_use" || toolUses.length === 0) {
        const replyText =
          res.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("")
            .trim() || null;
        return { kind: "ok", staged, replyText, turns };
      }

      const results: {
        type: "tool_result";
        tool_use_id: string;
        content: string;
        is_error?: boolean;
      }[] = [];
      for (const tu of toolUses) {
        if (controller.signal.aborted) throw controller.signal.reason;
        const exec = await executeTool(tu.name, tu.input, p.backend);
        if (exec.staged) staged.push(exec.staged);
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: exec.toolResultContent,
          ...(exec.isError ? { is_error: true } : {}),
        });
      }
      messages.push(
        { role: "assistant", content: res.content },
        { role: "user", content: results },
      );
    }
    return { kind: "ok", staged, replyText: null, turns };
  } finally {
    clearTimeout(timer);
  }
}
