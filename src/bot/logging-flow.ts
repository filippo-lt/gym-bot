/**
 * Text logging flow (M3): free text -> Claude stages -> code decides (SPEC 3, 5.6d) -> echo,
 * confirm card or "which exercise?" buttons; plus the callbacks for every button.
 * All numbers in replies are formatted by log-format.ts from DB or parsed values.
 */
import { eq } from "drizzle-orm";
import { type Context, InlineKeyboard } from "grammy";
import { runIntent } from "../ai/loop.js";
import type { IntentModel } from "../ai/model.js";
import { plannedItems } from "../db/schema/plan.js";
import type { Db } from "../db/seed-plan.js";
import { trainingDate } from "../domain/calendar.js";
import { appendMessage } from "../logging/conversation.js";
import {
  executeActions,
  ledgerResults,
  setGroupClean,
  setLastSetRir,
  undoEdit,
  undoGroup,
} from "../logging/execute.js";
import { groupSnapshot, lastBotGroup } from "../logging/groups.js";
import { deactivateMemory, listMemory, normalizeAlias, saveAlias } from "../logging/memory.js";
import {
  cancelPending,
  createPending,
  getOpenPending,
  getPending,
  getPendingBySourceUpdate,
  markAwaitingEdit,
  type Pending,
  type PendingKind,
  replacePendingActions,
  setPendingMessageId,
} from "../logging/pending.js";
import { decidePolicy } from "../logging/policy.js";
import { buildPromptContext, buildPromptStatic } from "../logging/prompt-context.js";
import { createLoggingBackend, resolveClarified } from "../logging/resolve.js";
import type { LedgerResult, PromptStatic, StagedAction } from "../logging/types.js";
import { createUsageStore } from "../logging/usage.js";
import { type CallbackAction, parseCallback } from "./callbacks.js";
import { esc } from "./format.js";
import {
  aliasSaved,
  BUDGET_REACHED,
  clarifyCard,
  confirmCard,
  DIDNT_GET_IT,
  deleteQuestion,
  type EchoView,
  EXPIRED,
  echoMessage,
  editEchoMessage,
  type Keyboard,
  type Message,
  memoryList,
  NO_AI_KEY,
  type Place,
  removedText,
  summarize,
  viewFromSnapshot,
} from "./log-format.js";

export interface AiConfig {
  model: IntentModel;
  dailyTokenCap: number;
  monthlyTokenCap: number;
}
/** A function so the key is only read when free text arrives; it may throw when not configured. */
export type AiSource = AiConfig | (() => AiConfig);

export interface FlowDeps {
  db: Db;
  now: () => Date;
  ai?: AiSource;
}

export interface Flow {
  text(ctx: Context): Promise<void>;
  callback(ctx: Context): Promise<void>;
  undoCommand(ctx: Context): Promise<void>;
  memoryCommand(ctx: Context): Promise<void>;
}

const HTML = { parse_mode: "HTML" as const };

function markup(kb: Keyboard): InlineKeyboard {
  const k = new InlineKeyboard();
  kb.forEach((row, i) => {
    for (const b of row) k.text(b.text, b.data);
    if (i < kb.length - 1) k.row();
  });
  return k;
}

function opts(m: { keyboard: Keyboard }) {
  return m.keyboard.length ? { ...HTML, reply_markup: markup(m.keyboard) } : HTML;
}

/** Sends a message and returns its id (undefined when the API result carries none). */
async function send(ctx: Context, m: Message | string): Promise<number | undefined> {
  const msg = typeof m === "string" ? { text: m, keyboard: [] } : m;
  const sent = (await ctx.reply(msg.text, opts(msg))) as { message_id?: number } | undefined;
  return sent?.message_id;
}

function isNotModified(error: unknown): boolean {
  const d = (error as { description?: unknown } | null)?.description;
  return typeof d === "string" && d.includes("message is not modified");
}

/** Edits the message a button sits on. A keyboard-less message drops its buttons. */
async function edit(ctx: Context, m: Message | string): Promise<void> {
  const msg = typeof m === "string" ? { text: m, keyboard: [] } : m;
  try {
    await ctx.editMessageText(msg.text, opts(msg));
  } catch (error) {
    if (!isNotModified(error)) throw error;
  }
}

function plainSummary(actions: StagedAction[]): string {
  return summarize(actions);
}

export function createFlow(deps: FlowDeps): Flow {
  const { db } = deps;
  let staticPrompt: Promise<PromptStatic> | undefined;

  function aiConfig(): AiConfig | null {
    if (!deps.ai) return null;
    try {
      return typeof deps.ai === "function" ? deps.ai() : deps.ai;
    } catch (error) {
      console.error(`ai: not configured (${error instanceof Error ? error.name : "error"})`);
      return null;
    }
  }

  function promptStatic(): Promise<PromptStatic> {
    staticPrompt ??= buildPromptStatic(db);
    staticPrompt.catch(() => {
      staticPrompt = undefined;
    });
    return staticPrompt;
  }

  // -------------------------------------------------------------------------
  // Echo

  async function loadEchoView(groupId: number): Promise<EchoView | null> {
    const snap = await groupSnapshot(db, groupId);
    if (!snap) return null;
    let place: Place = { kind: "extra" };
    let hasRirTarget = false;
    if (snap.plannedItemId !== null) {
      const [p] = await db
        .select({
          weekday: plannedItems.weekday,
          week: plannedItems.week,
          rirMin: plannedItems.rirMin,
          rirMax: plannedItems.rirMax,
        })
        .from(plannedItems)
        .where(eq(plannedItems.id, snap.plannedItemId));
      if (p) {
        hasRirTarget = p.rirMin !== null || p.rirMax !== null;
        place =
          trainingDate(new Date(snap.performedAt)) === snap.sessionDate
            ? { kind: "today", weekday: p.weekday, week: p.week }
            : { kind: "makeup", weekday: p.weekday, date: snap.sessionDate };
      }
    }
    return {
      ...viewFromSnapshot(snap),
      place,
      groupId,
      needsClean: snap.exercise.type === "bodyweight_plus" || snap.exercise.type === "skill_ladder",
      hasRirTarget,
    };
  }

  /** One message per saved group (or edit, or delete). */
  async function echoes(
    sourceKey: string,
    actions: StagedAction[],
    results: LedgerResult[],
  ): Promise<Message[]> {
    const out: Message[] = [];
    for (const [i, r] of results.entries()) {
      const a = actions[i];
      if (r.kind === "log") {
        const view = await loadEchoView(r.groupId);
        if (view) out.push(echoMessage(view));
      } else if (r.kind === "edit") {
        out.push(
          a?.kind === "edit_group"
            ? editEchoMessage(a, sourceKey, i)
            : { text: "Changed ✓", keyboard: [] },
        );
      } else {
        out.push({ text: removedText(r.snapshot), keyboard: [] });
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Pending cards

  function renderPending(p: Pending, replacedSummary: string | null): Message {
    if (p.kind === "clarify_exercise") {
      const d = decidePolicy(p.actions);
      const a = d.mode === "clarify" ? p.actions[d.index] : undefined;
      if (a?.kind === "clarify_exercise") {
        return clarifyCard({ id: p.id, said: a.said, candidates: a.candidates, replacedSummary });
      }
    }
    return confirmCard({
      id: p.id,
      kind: p.kind,
      actions: p.actions,
      reasons: p.reasons,
      replacedSummary,
    });
  }

  async function presentPending(
    ctx: Context,
    args: {
      kind: PendingKind;
      actions: StagedAction[];
      reasons: string[];
      updateId: number | null;
      now: Date;
    },
  ): Promise<Pending> {
    const chatId = (ctx.chat as { id: number }).id;
    const { pending, replaced, reused } = await createPending(db, {
      chatId,
      kind: args.kind,
      actions: args.actions,
      reasons: args.reasons,
      sourceUpdateId: args.updateId,
      now: args.now,
    });
    // The handler ran twice for one update: the first run already sent (or finished) the card.
    if (reused && (pending.messageId !== null || pending.status !== "open")) return pending;
    // An older request being corrected (✏️) is replaced silently; any other one is announced.
    const notice = replaced && !replaced.awaitingEdit ? plainSummary(replaced.actions) : null;
    const id = await send(ctx, renderPending(pending, notice));
    if (id !== undefined) await setPendingMessageId(db, pending.id, id);
    return pending;
  }

  /** A direct log answers the user's correction too: an open ✏️ request is dropped silently. */
  async function dropAwaitingEdit(chatId: number): Promise<void> {
    const open = await getOpenPending(db, chatId, deps.now());
    if (open?.awaitingEdit) await cancelPending(db, open.id);
  }

  // -------------------------------------------------------------------------
  // Free text

  async function text(ctx: Context): Promise<void> {
    const body = ctx.message?.text;
    const chatId = ctx.chat?.id;
    if (body === undefined || chatId === undefined) return;
    const ai = aiConfig();
    if (!ai) {
      await send(ctx, NO_AI_KEY);
      return;
    }
    const updateId = ctx.update.update_id;
    const key = `u:${updateId}`;
    const now = deps.now();

    // The inbox can run a handler twice. Never ask the model again for work already done.
    const prior = await ledgerResults(db, key);
    if (prior.length > 0) {
      for (const m of await echoes(key, [], prior)) await send(ctx, m);
      return;
    }
    const existing = await getPendingBySourceUpdate(db, chatId, updateId);
    if (existing) {
      if (existing.status === "open" && existing.messageId === null) {
        const id = await send(ctx, renderPending(existing, null));
        if (id !== undefined) await setPendingMessageId(db, existing.id, id);
      }
      return;
    }

    const [staticBlock, context] = await Promise.all([
      promptStatic(),
      buildPromptContext(db, chatId, now),
    ]);
    await appendMessage(db, chatId, "user", body);

    let result: Awaited<ReturnType<typeof runIntent>>;
    try {
      result = await runIntent({
        text: body,
        model: ai.model,
        backend: createLoggingBackend(db, now),
        usage: createUsageStore(db),
        promptStatic: staticBlock,
        promptContext: context,
        now,
        dailyTokenCap: ai.dailyTokenCap,
        monthlyTokenCap: ai.monthlyTokenCap,
      });
    } catch (error) {
      // Timeouts and API errors: tell the user once instead of burning the inbox retries.
      console.error(`ai: intent failed (${error instanceof Error ? error.name : "error"})`);
      const reply = "Sorry, I couldn't process that. Please try again.";
      await send(ctx, reply);
      await appendMessage(db, chatId, "assistant", reply);
      return;
    }

    if (result.kind === "budget_reached") {
      await send(ctx, BUDGET_REACHED);
      return;
    }

    const staged = result.staged;
    if (staged.length === 0) {
      const reply = result.replyText ?? DIDNT_GET_IT;
      await send(ctx, { text: esc(reply), keyboard: [] });
      await appendMessage(db, chatId, "assistant", reply);
      return;
    }

    const decision = decidePolicy(staged);
    if (decision.mode === "direct") {
      await dropAwaitingEdit(chatId);
      const r = await executeActions(db, key, staged, { now });
      if (r.status === "done") {
        for (const m of await echoes(key, staged, r.results)) await send(ctx, m);
      }
      await appendMessage(db, chatId, "assistant", `Saved: ${plainSummary(staged)}`);
    } else if (decision.mode === "clarify") {
      await presentPending(ctx, {
        kind: "clarify_exercise",
        actions: staged,
        reasons: [],
        updateId,
        now,
      });
      const a = staged[decision.index];
      await appendMessage(
        db,
        chatId,
        "assistant",
        `Asked which exercise "${a?.kind === "clarify_exercise" ? a.said : "?"}" is.`,
      );
    } else {
      const kind: PendingKind = staged.some((a) => a.kind === "delete_group")
        ? "delete"
        : "confirm";
      await presentPending(ctx, {
        kind,
        actions: staged,
        reasons: decision.reasons,
        updateId,
        now,
      });
      await appendMessage(db, chatId, "assistant", `Asked to confirm: ${plainSummary(staged)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Commands

  async function undoCommand(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const snap = await lastBotGroup(db);
    if (!snap) {
      await send(ctx, "Nothing to undo.");
      return;
    }
    const now = deps.now();
    const { pending, replaced, reused } = await createPending(db, {
      chatId,
      kind: "delete",
      actions: [{ kind: "delete_group", snapshot: snap }],
      reasons: ["delete"],
      sourceUpdateId: ctx.update.update_id,
      now,
    });
    if (reused && (pending.messageId !== null || pending.status !== "open")) return;
    const card = deleteQuestion(snap, pending.id, now);
    if (replaced && !replaced.awaitingEdit) {
      card.text = `Previous request cancelled: ${esc(plainSummary(replaced.actions))}\n\n${card.text}`;
    }
    const id = await send(ctx, card);
    if (id !== undefined) await setPendingMessageId(db, pending.id, id);
  }

  async function memoryCommand(ctx: Context): Promise<void> {
    await send(ctx, memoryList(await listMemory(db)));
  }

  // -------------------------------------------------------------------------
  // Callbacks

  async function callback(ctx: Context): Promise<void> {
    let answered = false;
    const answer = async (text?: string) => {
      if (answered) return;
      answered = true;
      try {
        await ctx.answerCallbackQuery(text ? { text } : undefined);
      } catch {
        // a slow or repeated answer must not fail the update
      }
    };
    try {
      const action = parseCallback(ctx.callbackQuery?.data ?? "");
      if (!action) {
        await answer("That button is no longer valid.");
        return;
      }
      await dispatch(ctx, action, answer);
    } finally {
      await answer();
    }
  }

  type Answer = (text?: string) => Promise<void>;

  async function dispatch(ctx: Context, a: CallbackAction, answer: Answer): Promise<void> {
    const now = deps.now();
    switch (a.t) {
      case "pa":
        return pendingButton(ctx, a.id, a.act, answer, now);
      case "ex":
        return exerciseButton(ctx, a.pendingId, a.index, answer, now);
      case "rir":
      case "cl": {
        const snap =
          a.t === "rir"
            ? await setLastSetRir(db, a.groupId, a.value, a.value === 4)
            : await setGroupClean(db, a.groupId, a.clean);
        const view = snap ? await loadEchoView(a.groupId) : null;
        if (!view) {
          await answer("Already removed.");
          return;
        }
        await edit(ctx, echoMessage(view));
        await answer(a.t === "rir" ? "RIR saved." : "Saved.");
        return;
      }
      case "ug": {
        const snap = await undoGroup(db, a.groupId);
        if (!snap) {
          await answer("Already removed.");
          return;
        }
        await edit(ctx, removedText(snap));
        await answer("Removed.");
        return;
      }
      case "ue": {
        const snap = await undoEdit(db, a.key, a.index);
        if (!snap) {
          await answer("Nothing to undo.");
          return;
        }
        await edit(ctx, `Change undone: ${removedText(snap).replace(/^Removed: /, "")}`);
        await answer("Change undone.");
        return;
      }
      case "md": {
        const done = await deactivateMemory(db, a.id);
        const msg = ctx.callbackQuery?.message;
        const old = msg && "text" in msg ? msg.text : undefined;
        if (old?.startsWith("Saved:")) {
          await edit(
            ctx,
            done ? `Deleted: ${esc(old.replace(/^Saved: /, ""))}` : "Already deleted.",
          );
        } else {
          await edit(ctx, memoryList(await listMemory(db)));
        }
        await answer(done ? "Deleted." : "Already deleted.");
        return;
      }
    }
  }

  async function pendingButton(
    ctx: Context,
    id: number,
    act: "ok" | "ed" | "no",
    answer: Answer,
    now: Date,
  ): Promise<void> {
    const pending = await getPending(db, id);
    if (!pending) {
      await answer(EXPIRED);
      return;
    }
    if (act === "no") {
      if (await cancelPending(db, id)) {
        await edit(ctx, "Cancelled, nothing saved.");
        await answer("Cancelled.");
      } else {
        await answer(pending.status === "executed" ? "Already saved." : EXPIRED);
      }
      return;
    }
    if (act === "ed") {
      if (pending.kind !== "clarify_exercise" && (await markAwaitingEdit(db, id))) {
        await answer();
        await send(ctx, "OK, tell me what to change.");
      } else {
        await answer(EXPIRED);
      }
      return;
    }
    // ✅
    if (pending.kind === "clarify_exercise") {
      await answer("Pick an exercise first.");
      return;
    }
    const doneText = pending.kind === "delete" ? "Removed ✓" : "Saved ✓";
    if (pending.status === "executed") {
      // A second tap, or a retried update: nothing to write, nothing to repeat.
      await edit(ctx, doneText);
      await answer("Already saved.");
      return;
    }
    const key = `p:${id}`;
    const r = await executeActions(db, key, pending.actions, { pendingId: id, now });
    if (r.status === "expired") {
      await answer(EXPIRED);
      await send(ctx, EXPIRED);
      return;
    }
    await edit(ctx, doneText);
    await answer(doneText);
    for (const m of await echoes(key, pending.actions, r.results)) await send(ctx, m);
  }

  async function exerciseButton(
    ctx: Context,
    pendingId: number,
    index: number,
    answer: Answer,
    now: Date,
  ): Promise<void> {
    const pending = await getPending(db, pendingId);
    const usable =
      pending?.status === "open" &&
      pending.kind === "clarify_exercise" &&
      pending.expiresAt.getTime() > now.getTime();
    if (!pending || !usable) {
      await answer(EXPIRED);
      return;
    }
    const d = decidePolicy(pending.actions);
    const clarify = d.mode === "clarify" ? pending.actions[d.index] : undefined;
    const chosen = clarify?.kind === "clarify_exercise" ? clarify.candidates[index] : undefined;
    if (d.mode !== "clarify" || clarify?.kind !== "clarify_exercise" || !chosen) {
      await answer("That choice is no longer available.");
      return;
    }
    const resolved = await resolveClarified(db, clarify, chosen.slug, now);
    const said = clarify.said;
    const exercise = resolved.resolved.exercise;

    // Save "said" = exercise, unless it is already the exercise's name/slug or an OR item name.
    let aliasMessage: Message | null = null;
    const norm = normalizeAlias(said);
    if (
      norm &&
      !said.includes("/") &&
      norm !== normalizeAlias(exercise.name) &&
      norm !== normalizeAlias(exercise.slug)
    ) {
      const saved = await saveAlias(db, said, exercise.id);
      if (saved) aliasMessage = aliasSaved(said.trim(), exercise.name, saved.item.id);
    }

    const actions = pending.actions.map((x, i) => (i === d.index ? resolved : x));
    const next = decidePolicy(actions);
    if (next.mode === "clarify") {
      await replacePendingActions(db, pendingId, actions);
      const q = actions[next.index];
      if (q?.kind === "clarify_exercise") {
        await edit(ctx, clarifyCard({ id: pendingId, said: q.said, candidates: q.candidates }));
      }
      if (aliasMessage) await send(ctx, aliasMessage);
      await answer();
      return;
    }
    if (next.mode === "confirm") {
      const kind: PendingKind = actions.some((x) => x.kind === "delete_group")
        ? "delete"
        : "confirm";
      const row = await replacePendingActions(db, pendingId, actions, {
        kind,
        reasons: next.reasons,
      });
      if (row)
        await edit(ctx, confirmCard({ id: pendingId, kind, actions, reasons: next.reasons }));
      if (aliasMessage) await send(ctx, aliasMessage);
      await answer();
      return;
    }
    // direct
    await replacePendingActions(db, pendingId, actions);
    const key = `p:${pendingId}`;
    const r = await executeActions(db, key, actions, { pendingId, now });
    if (r.status === "expired") {
      await answer(EXPIRED);
      await send(ctx, EXPIRED);
      return;
    }
    await edit(ctx, `Exercise: ${esc(exercise.name)}`);
    if (aliasMessage) await send(ctx, aliasMessage);
    await answer();
    for (const m of await echoes(key, actions, r.results)) await send(ctx, m);
  }

  return { text, callback, undoCommand, memoryCommand };
}
