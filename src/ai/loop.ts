import { normalizeAlias } from "../logging/memory.js";
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

const MAX_TOKENS = 2048;

/** What happened to each write tool call, in order, for counting errors nobody fixed. */
export type IntentEvent =
  | { type: "error"; turn: number; tool: string; said: string | null; slug: string | null }
  | {
      type: "staged";
      turn: number;
      said: string | null;
      slug: string | null;
      /** The staged action's kind. */
      kind: StagedAction["kind"];
    };

const norm = (v: unknown): string | null =>
  typeof v === "string" && normalizeAlias(v) ? normalizeAlias(v) : null;

function exerciseOf(input: unknown): { said: string | null; slug: string | null } {
  const ex = (input as { exercise?: { said?: unknown; slug?: unknown } } | null)?.exercise;
  return { said: norm(ex?.said), slug: typeof ex?.slug === "string" ? ex.slug : null };
}

export function stagedEvent(a: StagedAction, turn: number): IntentEvent {
  if (a.kind === "log_sets") {
    return {
      type: "staged",
      turn,
      said: norm(a.input.exercise.said),
      slug: a.resolved.exercise.slug,
      kind: a.kind,
    };
  }
  if (a.kind === "clarify_exercise") {
    return {
      type: "staged",
      turn,
      said: norm(a.said),
      slug: a.input.exercise.slug ?? null,
      kind: a.kind,
    };
  }
  return { type: "staged", turn, said: null, slug: null, kind: a.kind };
}

/**
 * Tool errors that nothing fixed. A fix has to come in a LATER turn (the model saw the error
 * and tried again): a log_sets error is fixed by a later log_sets/clarify with the same words
 * or slug; an edit/undo error only by a later edit or delete (a log never fixes it).
 */
export function countUnresolvedErrors(events: IntentEvent[]): number {
  let n = 0;
  for (const e of events) {
    if (e.type !== "error") continue;
    const later = events.filter((x) => x.type === "staged" && x.turn > e.turn);
    const fixed = later.some((x) => {
      if (x.type !== "staged") return false;
      if (e.tool === "log_sets") {
        return (
          (x.kind === "log_sets" || x.kind === "clarify_exercise") &&
          ((e.said !== null && x.said === e.said) || (e.slug !== null && x.slug === e.slug))
        );
      }
      if (e.tool === "edit_last_entry" || e.tool === "undo_last_entry") {
        return x.kind === "edit_group" || x.kind === "delete_group";
      }
      // Unknown tool name (a typo): any later staged action is the retry.
      return true;
    });
    if (!fixed) n++;
  }
  return n;
}

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
  const events: IntentEvent[] = [];

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

      if (res.stop_reason === "max_tokens") {
        // Its tool calls may be cut off mid-input: execute none of them.
        return {
          kind: "ok",
          staged,
          replyText: null,
          turns,
          toolErrors: countUnresolvedErrors(events),
          truncated: true,
        };
      }
      const toolUses = res.content.filter((b) => b.type === "tool_use");
      if (res.stop_reason !== "tool_use" || toolUses.length === 0) {
        const replyText =
          res.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("")
            .trim() || null;
        return {
          kind: "ok",
          staged,
          replyText,
          turns,
          toolErrors: countUnresolvedErrors(events),
          truncated: false,
        };
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
        if (exec.staged) {
          staged.push(exec.staged);
          events.push(stagedEvent(exec.staged, turns));
        } else if (exec.isError && tu.name !== "get_session") {
          events.push({ type: "error", turn: turns, tool: tu.name, ...exerciseOf(tu.input) });
        }
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
    return {
      kind: "ok",
      staged,
      replyText: null,
      turns,
      toolErrors: countUnresolvedErrors(events),
      truncated: false,
    };
  } finally {
    clearTimeout(timer);
  }
}
