/**
 * Text logging flow (M3): free text -> Claude stages -> code decides (SPEC 3, 5.6d) -> echo,
 * confirm card or "which exercise?" buttons; plus the callbacks for every button.
 * All numbers in replies are formatted by log-format.ts from DB or parsed values.
 */
import { eq } from "drizzle-orm";
import { type Context, InlineKeyboard } from "grammy";
import { runIntent } from "../ai/loop.js";
import type { IntentModel } from "../ai/model.js";
import { logGroups } from "../db/schema/log.js";
import { exercises, hspuLadder, plannedItems } from "../db/schema/plan.js";
import type { Db } from "../db/seed-plan.js";
import { trainingDate } from "../domain/calendar.js";
import { appendMessage } from "../logging/conversation.js";
import { describeSnapshot } from "../logging/describe.js";
import {
  executeActions,
  findEchoMessage,
  ledgerResults,
  recordEchoMessage,
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
  getReplacedPredecessor,
  markAwaitingEdit,
  type Pending,
  type PendingKind,
  replacePendingActions,
  setPendingMessageId,
} from "../logging/pending.js";
import { decidePolicy } from "../logging/policy.js";
import { buildPromptContext, buildPromptStatic } from "../logging/prompt-context.js";
import {
  ClarifiedInvalidError,
  ClarifyChoiceError,
  createLoggingBackend,
  resolveClarified,
} from "../logging/resolve.js";
import type { GroupSnapshot, LedgerResult, PromptStatic, StagedAction } from "../logging/types.js";
import { createUsageStore } from "../logging/usage.js";
import { type CallbackAction, parseCallback } from "./callbacks.js";
import { esc } from "./format.js";
import {
  aliasSaved,
  BUDGET_REACHED,
  cancelledText,
  clarifyCard,
  confirmCard,
  DIDNT_GET_IT,
  deleteQuestion,
  type EchoView,
  EXPIRED,
  echoMessage,
  editEchoMessage,
  expiredText,
  type Keyboard,
  type Message,
  memoryList,
  NO_AI_KEY,
  type Place,
  removedText,
  replacedText,
  STALE,
  stripMarkdown,
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

const PARTLY = "partly_understood";
/** Marks, in pending.reasons, which action a clarify tap resolved (for late retried taps). */
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

  /**
   * Button outcomes go into the conversation too, so the model never sees a stale "Asked to
   * confirm" after the user tapped. Best effort: history must not fail a tap.
   */
  async function remember(chatId: number | undefined, text: string): Promise<void> {
    if (chatId === undefined) return;
    try {
      await appendMessage(db, chatId, "assistant", text);
    } catch (error) {
      console.error(
        `conversation: append failed (${error instanceof Error ? error.name : "error"})`,
      );
    }
  }
  const chatOf = (ctx: Context): number | undefined =>
    ctx.chat?.id ?? ctx.callbackQuery?.message?.chat.id;

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

  /**
   * An edit echo from the ledger (a retried update has no staged action): the values the edit
   * replaced, the group as it is now, and which sets differ.
   */
  async function rebuildEditAction(
    r: Extract<LedgerResult, { kind: "edit" }>,
  ): Promise<Extract<StagedAction, { kind: "edit_group" }> | null> {
    const snap = await groupSnapshot(db, r.groupId);
    if (!snap) return null;
    const bg = r.beforeGroup;
    let exercise: GroupSnapshot["exercise"] = snap.exercise;
    if (bg && bg.exerciseId !== snap.exercise.id) {
      const [ex] = await db.select().from(exercises).where(eq(exercises.id, bg.exerciseId));
      if (ex) exercise = { ...snap.exercise, id: ex.id, slug: ex.slug, name: ex.name };
    }
    let hspuStep = snap.hspuStep;
    if (bg && bg.hspuStepId !== null) {
      const [step] = await db.select().from(hspuLadder).where(eq(hspuLadder.id, bg.hspuStepId));
      hspuStep = step ? { slug: step.slug, name: step.name } : null;
    } else if (bg) {
      hspuStep = null;
    }
    const before: GroupSnapshot = { ...snap, exercise, hspuStep, entries: r.before };
    const differing = snap.entries
      .filter(
        (e) =>
          JSON.stringify(e) !== JSON.stringify(r.before.find((b) => b.setIndex === e.setIndex)),
      )
      .map((e) => e.setIndex);
    const [g] = await db
      .select({ note: logGroups.note })
      .from(logGroups)
      .where(eq(logGroups.id, r.groupId));
    const noteChanged = bg !== undefined && (bg.note ?? null) !== (g?.note ?? null);
    return {
      kind: "edit_group",
      input: {
        changes: noteChanged ? { note: g?.note ?? "" } : {},
        guessed_fields: [],
        needs_confirmation: false,
      },
      before,
      after: snap,
      setIndexes: differing.length > 0 ? differing : snap.entries.map((e) => e.setIndex),
      lastSession: null,
    };
  }

  /** One message per saved group (or edit, or delete), with the result it belongs to. */
  async function echoesIndexed(
    sourceKey: string,
    actions: StagedAction[],
    results: LedgerResult[],
  ): Promise<{ message: Message; index: number; result: LedgerResult }[]> {
    const out: { message: Message; index: number; result: LedgerResult }[] = [];
    for (const [i, r] of results.entries()) {
      const a = actions[i];
      const add = (message: Message) => out.push({ message, index: i, result: r });
      if (r.kind === "log") {
        const view = await loadEchoView(r.groupId);
        if (view) add(echoMessage(view));
      } else if (r.kind === "edit") {
        const action = a?.kind === "edit_group" ? a : await rebuildEditAction(r);
        add(action ? editEchoMessage(action, sourceKey, i) : { text: "Changed ✓", keyboard: [] });
      } else {
        add({ text: removedText(r.snapshot), keyboard: [] });
      }
    }
    return out;
  }

  /**
   * Best effort: an edited group's original echo shows the new values (its Undo button stays).
   * Only an echo recorded for that very group is touched; Telegram errors don't matter.
   */
  async function refreshEcho(ctx: Context, groupId: number): Promise<void> {
    try {
      const chatId = chatOf(ctx);
      const messageId = await findEchoMessage(db, groupId);
      if (chatId === undefined || messageId === null) return;
      const view = await loadEchoView(groupId);
      if (!view) return;
      const m = echoMessage(view);
      await ctx.api.editMessageText(chatId, messageId, m.text, opts(m));
    } catch {
      // message too old, deleted, not modified...
    }
  }

  /**
   * Sends the echoes of a write and remembers each saved group's echo message id (best effort),
   * so a later edit can refresh it; an edit refreshes the echo of the group it changed.
   */
  async function sendEchoes(
    ctx: Context,
    sourceKey: string,
    actions: StagedAction[],
    results: LedgerResult[],
  ): Promise<void> {
    for (const e of await echoesIndexed(sourceKey, actions, results)) {
      const id = await send(ctx, e.message);
      if (id !== undefined && e.result.kind === "log") {
        try {
          await recordEchoMessage(db, sourceKey, e.index, id);
        } catch (error) {
          // A DB hiccup must not make the inbox retry and send the echoes again.
          console.error(`echo id not stored (${error instanceof Error ? error.name : "error"})`);
        }
      }
    }
    for (const r of results) if (r.kind === "edit") await refreshEcho(ctx, r.groupId);
  }

  // -------------------------------------------------------------------------
  // Pending cards

  function renderPending(p: Pending, replacedSummary: string | null): Message {
    if (p.kind === "clarify_exercise") {
      const d = decidePolicy(p.actions);
      const a = d.mode === "clarify" ? p.actions[d.index] : undefined;
      if (a?.kind === "clarify_exercise") {
        return clarifyCard({
          id: p.id,
          actionIndex: d.mode === "clarify" ? d.index : 0,
          said: a.said,
          candidates: a.candidates,
          replacedSummary,
          partlyUnderstood: p.reasons.includes(PARTLY),
        });
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
    await sendPendingCard(ctx, chatId, pending, replaced);
    return pending;
  }

  /** A replaced request is always announced on the new card, and its own card is retired. */
  async function sendPendingCard(
    ctx: Context,
    chatId: number,
    pending: Pending,
    replaced: Pending | null,
  ): Promise<void> {
    const notice = replaced ? plainSummary(replaced.actions) : null;
    const id = await send(ctx, renderPending(pending, notice));
    if (id !== undefined) await setPendingMessageId(db, pending.id, id);
    if (replaced) {
      await retireCard(ctx, chatId, replaced);
      await remember(chatId, `Replaced the earlier request: ${plainSummary(replaced.actions)}`);
    }
  }

  /** Best effort: the old card loses its buttons. Telegram errors don't matter here. */
  async function retireCard(ctx: Context, chatId: number, old: Pending): Promise<void> {
    if (old.messageId === null) return;
    try {
      await ctx.api.editMessageText(chatId, old.messageId, replacedText(old.actions), HTML);
    } catch {
      // message too old, already edited, deleted...
    }
  }

  /** Best effort: Telegram errors (message too old, deleted...) must not fail the update. */
  async function editQuietly(ctx: Context, m: Message | string): Promise<void> {
    try {
      await edit(ctx, m);
    } catch {
      // message too old, already edited, deleted...
    }
  }

  /**
   * A tap on a card whose request is over (saved, expired, replaced, cancelled): the buttons go
   * and the card shows how it ended. Best effort, and never a new chat message.
   */
  async function closeStaleCard(ctx: Context, p: Pending): Promise<void> {
    // A clarify card that was resolved and saved already shows "Exercise: …": keep it.
    if (p.status === "executed" && p.kind === "clarify_exercise") return;
    const text =
      p.status === "executed"
        ? p.kind === "delete"
          ? "Removed ✓"
          : "Saved ✓"
        : p.status === "replaced"
          ? replacedText(p.actions)
          : p.status === "cancelled"
            ? cancelledText(p.actions)
            : expiredText(p.actions);
    await editQuietly(ctx, text);
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
      await sendEchoes(ctx, key, [], prior);
      return;
    }
    const existing = await getPendingBySourceUpdate(db, chatId, updateId);
    if (existing) {
      if (existing.status === "open" && existing.messageId === null) {
        // The first run crashed before its card went out: do what it would have done, including
        // the "Replaces: …" notice and retiring the older card.
        await sendPendingCard(ctx, chatId, existing, await getReplacedPredecessor(db, existing));
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
        backend: createLoggingBackend(db, now, { openPending: context.pending }),
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
    const partly = result.toolErrors > 0 || result.truncated;
    if (staged.length === 0) {
      const reply = result.truncated
        ? "Sorry, that message was too long for me. Please split it."
        : result.replyText
          ? stripMarkdown(result.replyText)
          : DIDNT_GET_IT;
      await send(ctx, { text: esc(reply), keyboard: [] });
      await appendMessage(db, chatId, "assistant", reply);
      return;
    }

    // With an unsaved request open nothing is written directly: the new actions go to a card
    // that replaces it (and says so).
    const open = await getOpenPending(db, chatId, now);
    const decision = decidePolicy(staged, {
      openPending: open !== null,
      partlyUnderstood: partly,
    });
    if (decision.mode === "direct") {
      const r = await executeActions(db, key, staged, { now });
      if (r.status === "done") {
        await sendEchoes(ctx, key, staged, r.results);
        await appendMessage(db, chatId, "assistant", `Saved: ${plainSummary(staged)}`);
      } else {
        await send(ctx, r.status === "stale" ? STALE : EXPIRED);
      }
    } else if (decision.mode === "clarify") {
      await presentPending(ctx, {
        kind: "clarify_exercise",
        actions: staged,
        reasons: partly ? [PARTLY] : [],
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
      const kind: PendingKind = staged.every((a) => a.kind === "delete_group")
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
    if (replaced) {
      card.text = `Replaces: ${esc(plainSummary(replaced.actions))}\n\n${card.text}`;
    }
    const id = await send(ctx, card);
    if (id !== undefined) await setPendingMessageId(db, pending.id, id);
    if (replaced) {
      await retireCard(ctx, chatId, replaced);
      await remember(chatId, `Replaced the earlier request: ${plainSummary(replaced.actions)}`);
    }
    await remember(chatId, `Asked to confirm: remove ${describeSnapshot(snap)}`);
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
        await remember(chatOf(ctx), "A tapped button was no longer valid; nothing changed.");
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
        return exerciseButton(ctx, a.pendingId, a.index, a.action, answer, now);
      case "rir":
      case "cl": {
        const snap =
          a.t === "rir"
            ? await setLastSetRir(db, a.groupId, a.value, a.value === 4)
            : await setGroupClean(db, a.groupId, a.clean);
        const view = snap ? await loadEchoView(a.groupId) : null;
        if (!view) {
          await answer("Already removed.");
          await remember(
            chatOf(ctx),
            "A tapped RIR/clean button was for a log that is already removed.",
          );
          return;
        }
        await edit(ctx, echoMessage(view));
        await answer(a.t === "rir" ? "RIR saved." : "Saved.");
        if (snap) {
          const what =
            a.t === "rir"
              ? `RIR ${a.value === 4 ? "4+" : a.value} set on`
              : a.clean
                ? "Marked clean:"
                : "Marked not clean:";
          await remember(chatOf(ctx), `${what} ${describeSnapshot(snap)}`);
        }
        return;
      }
      case "ug": {
        const snap = await undoGroup(db, a.groupId);
        if (!snap) {
          await answer("Already removed.");
          await remember(
            chatOf(ctx),
            "A tapped Undo button was for a log that is already removed.",
          );
          return;
        }
        await edit(ctx, removedText(snap));
        await answer("Removed.");
        await remember(chatOf(ctx), `Removed (Undo button): ${describeSnapshot(snap)}`);
        return;
      }
      case "ue": {
        const undone = await undoEdit(db, a.key, a.index);
        if (undone.status === "stale") {
          await answer("Can't undo: this log changed since.");
          await remember(chatOf(ctx), "Edit not undone: the log changed since; nothing changed.");
          return;
        }
        if (undone.status === "none") {
          await answer("Nothing to undo.");
          await remember(chatOf(ctx), "Edit not undone: nothing to undo.");
          return;
        }
        await refreshEcho(ctx, undone.snapshot.groupId);
        await edit(ctx, `Change undone: ${removedText(undone.snapshot).replace(/^Removed: /, "")}`);
        await answer("Change undone.");
        await remember(
          chatOf(ctx),
          `Edit undone, log is back to: ${describeSnapshot(undone.snapshot)}`,
        );
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
        await remember(
          chatOf(ctx),
          done ? "Memory item deleted." : "A tapped memory item was already deleted.",
        );
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
    const chatId = chatOf(ctx);
    const pending = await getPending(db, id);
    if (!pending) {
      await answer(EXPIRED);
      await remember(chatId, "A tapped request was not found (expired); nothing changed.");
      return;
    }
    if (pending.status === "executed") {
      // A late or double tap (✅ then ✏️/❌ before the first edit landed, a retried update):
      // it was saved, nothing to write, nothing to repeat.
      await answer("Already saved.");
      await closeStaleCard(ctx, pending);
      await remember(chatId, "A tapped button was too late: the request was already saved.");
      return;
    }
    if (act === "no") {
      if (await cancelPending(db, id)) {
        await edit(ctx, cancelledText(pending.actions));
        await answer("Cancelled.");
        await remember(
          chatId,
          `Cancelled by the user, nothing saved: ${plainSummary(pending.actions)}`,
        );
      } else {
        await answer(EXPIRED);
        await closeStaleCard(ctx, pending);
        await remember(chatId, "A tapped cancel found the request expired; nothing changed.");
      }
      return;
    }
    if (act === "ed") {
      if (
        pending.kind === "clarify_exercise" &&
        pending.status === "open" &&
        pending.expiresAt.getTime() > now.getTime()
      ) {
        await answer();
        await send(ctx, "Pick one of the buttons above, or send a new message.");
      } else if (await markAwaitingEdit(db, id, now)) {
        await answer();
        await send(ctx, "OK, tell me what to change.");
        await remember(
          chatId,
          `User tapped edit on: ${plainSummary(pending.actions)}. Waiting for the corrected request.`,
        );
      } else {
        await answer(EXPIRED);
        await closeStaleCard(ctx, pending);
        await remember(chatId, "A tapped edit button had expired; nothing changed.");
      }
      return;
    }
    // ✅
    if (pending.kind === "clarify_exercise") {
      await answer("Pick an exercise first.");
      return;
    }
    const doneText = pending.kind === "delete" ? "Removed ✓" : "Saved ✓";
    const key = `p:${id}`;
    const r = await executeActions(db, key, pending.actions, { pendingId: id, now });
    if (r.status === "stale") {
      await editQuietly(ctx, STALE);
      await answer(STALE);
      await remember(
        chatId,
        "The tapped request was stale (the log no longer exists); nothing changed.",
      );
      return;
    }
    if (r.status === "expired") {
      await answer(EXPIRED);
      await closeStaleCard(ctx, (await getPending(db, id)) ?? pending);
      await remember(chatId, "The tapped request had expired; nothing saved.");
      return;
    }
    // The write is committed: a failing card edit must not stop the echoes (and their Undo).
    await editQuietly(ctx, doneText);
    await answer(doneText);
    await sendEchoes(ctx, key, pending.actions, r.results);
    await remember(
      chatId,
      `${pending.kind === "delete" ? "Removed" : "Saved"} (user confirmed): ${plainSummary(pending.actions)}`,
    );
  }

  async function exerciseButton(
    ctx: Context,
    pendingId: number,
    index: number,
    tappedAction: number | null,
    answer: Answer,
    now: Date,
  ): Promise<void> {
    const chatId = chatOf(ctx);
    const pending = await getPending(db, pendingId);
    if (tappedAction === null) {
      // A button without the clarify position (sent before it was encoded) can't say which
      // question it answers: never apply it.
      if (pending?.status === "executed") {
        await answer("Already saved.");
        await closeStaleCard(ctx, pending);
        return;
      }
      await answer(EXPIRED);
      if (pending) {
        // Close the request too, or a later message would announce "Replaces: …".
        await cancelPending(db, pendingId);
        await closeStaleCard(ctx, { ...pending, status: "expired" });
      }
      await remember(chatId, "A tapped exercise choice was from an old card; nothing saved.");
      return;
    }
    if (pending?.status === "executed" && (await ledgerResults(db, `p:${pendingId}`)).length > 0) {
      // A retried tap: the choice was already saved. Nothing to write, nothing to repeat.
      // Best effort: a card still showing buttons (its first edit failed) gets its final text.
      // The button names its own clarify.
      const done = pending.actions[tappedAction];
      try {
        await edit(
          ctx,
          done?.kind === "log_sets" ? `Exercise: ${esc(done.resolved.exercise.name)}` : "Saved ✓",
        );
      } catch {
        // already edited, deleted or too old
      }
      await answer("Already saved.");
      return;
    }
    if (pending?.status === "open" && pending.kind !== "clarify_exercise") {
      // The clarify card already became a confirm card (a retried or late tap).
      await answer("Already answered.");
      return;
    }
    const usable =
      pending?.status === "open" &&
      pending.kind === "clarify_exercise" &&
      pending.expiresAt.getTime() > now.getTime();
    if (!pending || !usable) {
      await answer(EXPIRED);
      if (pending) await closeStaleCard(ctx, pending);
      await remember(chatId, "A tapped exercise choice had expired; nothing saved.");
      return;
    }
    const d = decidePolicy(pending.actions);
    const clarify = d.mode === "clarify" ? pending.actions[d.index] : undefined;
    const chosen = clarify?.kind === "clarify_exercise" ? clarify.candidates[index] : undefined;
    if (d.mode === "clarify" && d.index !== tappedAction) {
      // A button of an earlier clarify in this request: its card moved on to the next question.
      await answer("Already answered.");
      return;
    }
    if (d.mode !== "clarify" || clarify?.kind !== "clarify_exercise" || !chosen) {
      await answer("That choice is no longer available.");
      await remember(
        chatOf(ctx),
        "A tapped exercise choice was no longer available; nothing changed.",
      );
      return;
    }
    let resolved: Awaited<ReturnType<typeof resolveClarified>>;
    try {
      resolved = await resolveClarified(db, clarify, chosen.slug, now);
    } catch (error) {
      if (error instanceof ClarifiedInvalidError) {
        // The sets don't fit that exercise: close the request instead of leaving a stuck card.
        await cancelPending(db, pendingId);
        await edit(
          ctx,
          `Can't save ${esc(error.exerciseName)}: ${esc(error.reason)} Send it again.`,
        );
        await answer();
        await remember(
          chatId,
          `Could not save ${error.exerciseName}: ${error.reason} Request closed.`,
        );
        return;
      }
      console.error(`ai: clarify choice failed (${error instanceof Error ? error.name : "error"})`);
      if (error instanceof ClarifyChoiceError) {
        await answer("That choice is no longer available.");
        await remember(
          chatOf(ctx),
          "A tapped exercise choice was no longer available; nothing changed.",
        );
        return;
      }
      throw error; // DB and other unexpected errors: let the inbox retry
    }
    const said = clarify.said;
    const exercise = resolved.resolved.exercise;

    // Save "said" = exercise, unless it is already the exercise's name/slug or an OR item name.
    // Only called once the choice has been accepted (never for an expired request).
    const saveChosenAlias = async (): Promise<Message | null> => {
      const norm = normalizeAlias(said);
      if (
        !norm ||
        said.includes("/") ||
        norm === normalizeAlias(exercise.name) ||
        norm === normalizeAlias(exercise.slug)
      ) {
        return null;
      }
      const saved = await saveAlias(db, said, exercise.id);
      if (saved) await remember(chatId, `Saved alias "${said.trim()}" = ${exercise.name}.`);
      return saved ? aliasSaved(said.trim(), exercise.name, saved.item.id) : null;
    };
    const chose = `User chose ${exercise.name} for "${said}".`;

    const actions = pending.actions.map((x, i) => (i === d.index ? resolved : x));
    const partly = pending.reasons.includes(PARTLY);
    const next = decidePolicy(actions, { partlyUnderstood: partly });
    if (next.mode === "clarify") {
      if (!(await replacePendingActions(db, pendingId, actions))) {
        await answer(EXPIRED);
        await remember(chatOf(ctx), "The request had expired; nothing saved.");
        return;
      }
      const q = actions[next.index];
      if (q?.kind === "clarify_exercise") {
        await edit(
          ctx,
          clarifyCard({
            id: pendingId,
            actionIndex: next.index,
            said: q.said,
            candidates: q.candidates,
            partlyUnderstood: partly,
          }),
        );
        await remember(chatId, `${chose} Asked which exercise "${q.said}" is.`);
      }
      const aliasMessage = await saveChosenAlias();
      if (aliasMessage) await send(ctx, aliasMessage);
      await answer();
      return;
    }
    if (next.mode === "confirm") {
      const kind: PendingKind = actions.every((x) => x.kind === "delete_group")
        ? "delete"
        : "confirm";
      const row = await replacePendingActions(db, pendingId, actions, {
        kind,
        reasons: next.reasons,
      });
      if (!row) {
        await answer(EXPIRED);
        await remember(chatOf(ctx), "The request had expired; nothing saved.");
        return;
      }
      await edit(ctx, confirmCard({ id: pendingId, kind, actions, reasons: next.reasons }));
      await remember(chatId, `${chose} Asked to confirm: ${plainSummary(actions)}`);
      const aliasMessage = await saveChosenAlias();
      if (aliasMessage) await send(ctx, aliasMessage);
      await answer();
      return;
    }
    // direct: storing the resolved actions, claiming and writing are one transaction
    const key = `p:${pendingId}`;
    const r = await executeActions(db, key, actions, {
      pendingId,
      now,
      replaceActions: actions,
      replaceReasons: pending.reasons,
    });
    if (r.status !== "done") {
      await answer(r.status === "stale" ? STALE : EXPIRED);
      if (r.status === "stale") await editQuietly(ctx, STALE);
      else await closeStaleCard(ctx, (await getPending(db, pendingId)) ?? pending);
      await remember(chatId, "The tapped exercise choice could not be saved; nothing changed.");
      return;
    }
    await edit(ctx, `Exercise: ${esc(exercise.name)}`);
    await remember(chatId, `${chose} Saved: ${plainSummary(actions)}`);
    const aliasMessage = await saveChosenAlias();
    if (aliasMessage) await send(ctx, aliasMessage);
    await answer();
    await sendEchoes(ctx, key, actions, r.results);
  }

  return { text, callback, undoCommand, memoryCommand };
}
