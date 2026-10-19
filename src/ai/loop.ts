import { normalizeAlias } from "../logging/memory.js";
import type {
  IntentResult,
  LoggingBackend,
  PromptContext,
  PromptStatic,
  ReadRecord,
  StagedAction,
  UsageStore,
} from "../logging/types.js";
import { overTokenBudget, tokenUsageOf } from "./budget.js";
import { AI_BUDGET_MS, AI_MAX_TURNS } from "./constants.js";
import { AiTimeoutError } from "./errors.js";
import type { IntentModel, MessageParam } from "./model.js";
import { buildSystem } from "./prompt.js";
import { executeTool, READ_TOOLS, TOOLS } from "./tools.js";

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

/** Shown when the model's swap input does not parse. */
export const SWAP_UNREADABLE = "I couldn't read that swap. Tell me the two exercise names again.";

/** Code-built refusal texts of swaps that no later swap fixed (they are shown to the user as they are). */
export function unresolvedSwapRefusals(
  errors: { turn: number; reply: string }[],
  events: IntentEvent[],
): string[] {
  return errors
    .filter((e) => !events.some((x) => x.type === "staged" && x.kind === "swap" && x.turn > e.turn))
    .map((e) => e.reply);
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
      if (e.tool === "save_memory") return x.kind === "save_memory";
      if (e.tool === "swap_exercise") return x.kind === "swap";
      // Unknown tool name (a typo): any later staged action is the retry.
      return true;
    });
    if (!fixed) n++;
  }
  return n;
}

const isLogLike = (a: StagedAction) => a.kind === "log_sets" || a.kind === "clarify_exercise";

/** Same exercise by resolved/given slug or by the user's normalized words (as in the error matching). */
function sameExercise(a: StagedAction, b: StagedAction): boolean {
  const x = stagedEvent(a, 0);
  const y = stagedEvent(b, 0);
  if (x.type !== "staged" || y.type !== "staged") return false;
  return (x.slug !== null && x.slug === y.slug) || (x.said !== null && x.said === y.said);
}

/** Where a staged action came from, to tell a retry (replaces) from a second set (kept). */
interface StagedMeta {
  turn: number;
  input: string;
  eventIndex: number;
}

/**
 * Identity of a staged action that must not appear twice on one card, from what code resolved
 * (not the model's raw input, which differs cosmetically between retries). null = no dedupe.
 */
function dedupeKey(a: StagedAction): string | null {
  if (a.kind === "swap") {
    const r = a.resolved;
    return JSON.stringify([
      "swap",
      r.from.id,
      r.to.id ?? `new:${r.to.slug}`,
      r.scope,
      r.days,
      r.referenceDate,
      r.referenceWeekday,
    ]);
  }
  if (a.kind === "delete_group") return `delete:${a.snapshot.groupId}`;
  if (a.kind === "save_memory") return `memory:${JSON.stringify(a.input)}`;
  return null;
}

/**
 * Adds a staged action. A swap, removal or memory that repeats an already staged one (same
 * resolved target) is dropped, in any turn. A log_sets/clarify_exercise from a later turn REPLACES an earlier turn's
 * for the same exercise (the model re-called the tool with a fix), keeping its position. In the
 * same turn an exact duplicate is dropped; different inputs both stay.
 */
function addStaged(
  staged: StagedAction[],
  metas: StagedMeta[],
  events: IntentEvent[],
  action: StagedAction,
  turn: number,
  rawInput: unknown,
): void {
  const input = JSON.stringify(rawInput);
  const key = dedupeKey(action);
  if (key !== null && staged.some((s) => dedupeKey(s) === key)) return;
  if (isLogLike(action)) {
    if (staged.some((_s, i) => metas[i]?.turn === turn && metas[i]?.input === input)) return;
    const matches = staged
      .map((_s, i) => i)
      .filter((i) => {
        const s = staged[i] as StagedAction;
        return isLogLike(s) && (metas[i]?.turn ?? turn) < turn && sameExercise(s, action);
      });
    const at = matches[0];
    if (at !== undefined) {
      // Every earlier call for this exercise is superseded by the retry.
      staged[at] = action;
      const meta = metas[at] as StagedMeta;
      events[meta.eventIndex] = stagedEvent(action, turn);
      metas[at] = { ...meta, turn, input };
      for (const i of matches.slice(1).reverse()) {
        // The event stays in the list (a harmless extra "staged" for error matching).
        staged.splice(i, 1);
        metas.splice(i, 1);
      }
      return;
    }
  }
  staged.push(action);
  events.push(stagedEvent(action, turn));
  metas.push({ turn, input, eventIndex: events.length - 1 });
}

export async function runIntent(p: RunIntentParams): Promise<IntentResult> {
  const maxTurns = p.maxTurns ?? AI_MAX_TURNS;
  const budgetMs = p.budgetMs ?? AI_BUDGET_MS;

  /** Checked before every model call: a long loop can reach the cap mid-way. */
  const overBudget = () => overTokenBudget(p.usage, p.now, p);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new AiTimeoutError()), budgetMs);
  const system = buildSystem(p.promptStatic, p.promptContext);
  const messages: MessageParam[] = [{ role: "user", content: p.text }];
  const staged: StagedAction[] = [];
  const events: IntentEvent[] = [];
  const metas: StagedMeta[] = [];
  const reads: ReadRecord[] = [];
  const swapErrors: { turn: number; reply: string }[] = [];

  try {
    let turns = 0;
    while (turns < maxTurns) {
      // Nothing staged so far is written when the cap is hit: the bot only reports it.
      const cap = await overBudget();
      if (cap) return { kind: "budget_reached", cap };
      turns++;
      const res = await p.model.create({
        system,
        messages,
        tools: TOOLS,
        max_tokens: MAX_TOKENS,
        signal: controller.signal,
      });
      await p.usage.record(tokenUsageOf(p.model.name, res.usage), p.now);

      if (res.stop_reason === "max_tokens") {
        // Its tool calls may be cut off mid-input: execute none of them.
        return {
          kind: "ok",
          staged,
          replyText: null,
          turns,
          toolErrors: countUnresolvedErrors(events),
          swapRefusals: unresolvedSwapRefusals(swapErrors, events),
          truncated: true,
          reads,
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
          swapRefusals: unresolvedSwapRefusals(swapErrors, events),
          truncated: false,
          reads,
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
          addStaged(staged, metas, events, exec.staged, turns, tu.input);
        } else if (exec.isError && !READ_TOOLS.includes(tu.name)) {
          events.push({ type: "error", turn: turns, tool: tu.name, ...exerciseOf(tu.input) });
          if (tu.name === "swap_exercise") {
            // A zod-invalid swap has no code-built refusal: the user gets a fixed sentence.
            const invalid = exec.toolResultContent.startsWith("Invalid input");
            swapErrors.push({
              turn: turns,
              reply: invalid ? SWAP_UNREADABLE : exec.toolResultContent,
            });
          }
        }
        if (exec.read && !exec.isError) {
          reads.push({
            tool: tu.name,
            content: exec.toolResultContent,
            fallbackHtml: exec.read.fallbackHtml,
          });
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
      swapRefusals: unresolvedSwapRefusals(swapErrors, events),
      truncated: false,
      reads,
    };
  } finally {
    clearTimeout(timer);
  }
}
