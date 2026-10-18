/**
 * Text logging flow (M3): free text -> Claude stages -> code decides (SPEC 3, 5.6d) -> echo,
 * confirm card or "which exercise?" buttons; plus the callbacks for every button.
 * All numbers in replies are formatted by log-format.ts from DB or parsed values.
 */
import { eq } from "drizzle-orm";
import type { Context } from "grammy";
import { BOARD_TIMEOUT_MS, readBoard } from "../ai/board.js";
import { overTokenBudget } from "../ai/budget.js";
import { runIntent } from "../ai/loop.js";
import type { IntentModel } from "../ai/model.js";
import { checkNumbers } from "../ai/number-guard.js";
import { buildDynamicText } from "../ai/prompt.js";
import { logGroups } from "../db/schema/log.js";
import { exercises, hspuLadder, plannedItems } from "../db/schema/plan.js";
import type { Db } from "../db/seed-plan.js";
import { thursdayOnOrBefore, trainingDate } from "../domain/calendar.js";
import { classBreakdown } from "../logging/class-moves.js";
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
  undoWrite,
} from "../logging/execute.js";
import { bandSeenElsewhere, groupSnapshot, lastBotGroup } from "../logging/groups.js";
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
import type {
  GroupSnapshot,
  InputSource,
  LedgerResult,
  PromptStatic,
  StagedAction,
} from "../logging/types.js";
import { createUsageStore } from "../logging/usage.js";
import {
  MAX_VOICE_SECONDS,
  type SpeechToText,
  STT_TIMEOUT_MS,
  sttVocabularyPrompt,
} from "../stt/stt.js";
import { type CallbackAction, parseCallback } from "./callbacks.js";
import { esc, guardLength } from "./format.js";
import {
  aliasSaved,
  BOARD_UNREADABLE,
  BUDGET_REACHED,
  bandQuestion,
  bandSaved,
  cancelledText,
  clarifyCard,
  classMovesCard,
  confirmCard,
  DIDNT_GET_IT,
  deleteQuestion,
  directWriteSaved,
  type EchoView,
  EXPIRED,
  echoMessage,
  editEchoMessage,
  expiredText,
  groupsToMask,
  heardLine,
  inlineKeyboard,
  type Keyboard,
  type Message,
  maskToGroups,
  memoryList,
  memorySaved,
  NO_AI_KEY,
  NUMBER_GUARD_FALLBACK,
  PHOTO_FAILED,
  type Place,
  plural,
  removedText,
  replacedText,
  STALE,
  stripMarkdown,
  summarize,
  VOICE_BLANK,
  VOICE_BUDGET,
  VOICE_FAILED,
  VOICE_NOT_CONFIGURED,
  VOICE_TOO_LONG,
  viewFromSnapshot,
} from "./log-format.js";
import { createSkipFlow } from "./skip-flow.js";
import { NOTHING_SKIPPED_DONE, SKIPPED_DONE, skipEcho } from "./skip-format.js";

export interface AiConfig {
  model: IntentModel;
  dailyTokenCap: number;
  monthlyTokenCap: number;
}
/** A function so the key is only read when free text arrives; it may throw when not configured. */
export type AiSource = AiConfig | (() => AiConfig);

/** Voice notes: the speech-to-text provider (throws when not configured) and the file download. */
export interface MediaSource {
  stt?: () => { stt: SpeechToText; dailySecondsCap: number };
  download(fileId: string, maxBytes: number): Promise<Uint8Array>;
}

export interface FlowDeps {
  db: Db;
  now: () => Date;
  ai?: AiSource;
  media?: MediaSource;
}

const VOICE_MAX_BYTES = 20 * 1024 * 1024;
/** The API takes images up to 5 MB and base64 adds ~33%, so cap the download below 3.75 MB. */
const PHOTO_MAX_BYTES = 3.5 * 1024 * 1024;

export interface Flow {
  text(ctx: Context): Promise<void>;
  voice(ctx: Context): Promise<void>;
  photo(ctx: Context): Promise<void>;
  callback(ctx: Context): Promise<void>;
  undoCommand(ctx: Context): Promise<void>;
  memoryCommand(ctx: Context): Promise<void>;
  skipCommand(ctx: Context): Promise<void>;
}

const PARTLY = "partly_understood";
/** Marks, in pending.reasons, which action a clarify tap resolved (for late retried taps). */
const HTML = { parse_mode: "HTML" as const };

function opts(m: { keyboard: Keyboard }) {
  return m.keyboard.length ? { ...HTML, reply_markup: inlineKeyboard(m.keyboard) } : HTML;
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

/** Telegram HTML to plain text, for the conversation memory the model reads. */
function htmlToPlain(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
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
      } else if (r.kind === "memory") {
        add(memorySaved(r.content, r.memoryId));
      } else if (r.kind === "band") {
        add(bandSaved(r.colour, r.kg));
      } else if (r.kind === "readiness" || r.kind === "bodyweight" || r.kind === "class") {
        add(directWriteSaved(r, sourceKey, i));
      } else if (r.kind === "skip") {
        add(skipEcho(r, sourceKey, i));
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
   * Best effort: a removed group's original echo becomes "Removed: …" and loses its buttons.
   * Telegram errors (message too old, deleted, not modified...) don't matter.
   */
  async function retireEcho(ctx: Context, snap: GroupSnapshot): Promise<void> {
    try {
      const chatId = chatOf(ctx);
      const messageId = await findEchoMessage(db, snap.groupId);
      if (chatId === undefined || messageId === null) return;
      await ctx.api.editMessageText(chatId, messageId, removedText(snap), HTML);
    } catch {
      // message too old, deleted, not modified...
    }
  }

  /**
   * A band set whose colour has no kg yet: ask once per colour (the first saved log with it). Best effort; the answer
   * ("red band 15 kg") is an ordinary chat message that stages set_band_kg.
   */
  async function askBandKg(ctx: Context, groupId: number, only?: Set<string>): Promise<void> {
    try {
      const snap = await groupSnapshot(db, groupId);
      if (!snap) return;
      const colours = [
        ...new Set(
          snap.entries
            .filter(
              (e) =>
                e.band !== null && e.assistKg === null && (only === undefined || only.has(e.band)),
            )
            .map((e) => e.band as string),
        ),
      ];
      for (const colour of colours) {
        if (await bandSeenElsewhere(db, colour, groupId)) continue;
        await send(ctx, bandQuestion(colour));
        await remember(chatOf(ctx), `Asked how many kg the ${colour} band is.`);
      }
    } catch (error) {
      console.error(`band question failed (${error instanceof Error ? error.name : "error"})`);
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
      if (e.result.kind === "log") await askBandKg(ctx, e.result.groupId);
      else if (e.result.kind === "edit") {
        // An edit asks only for a colour it introduced (the log itself asked for the old one).
        const a = actions[e.index];
        if (a?.kind === "edit_group") {
          const old = new Set(a.before.entries.map((x) => x.band));
          const added = new Set(
            a.after.entries
              .map((x) => x.band)
              .filter((b): b is string => b !== null && !old.has(b)),
          );
          if (added.size > 0) await askBandKg(ctx, e.result.groupId, added);
        }
      }
    }
    for (const r of results) {
      if (r.kind === "edit") await refreshEcho(ctx, r.groupId);
      else if (r.kind === "delete") await retireEcho(ctx, r.snapshot);
    }
  }

  // -------------------------------------------------------------------------
  // Pending cards

  function renderPending(p: Pending, replacedSummary: string | null): Message {
    if (p.kind === "clarify_exercise") {
      const d = decidePolicy(p.actions, { voiceInput: p.inputSource === "voice" });
      const a = d.mode === "clarify" ? p.actions[d.index] : undefined;
      if (a?.kind === "clarify_exercise") {
        return clarifyCard({
          id: p.id,
          actionIndex: d.mode === "clarify" ? d.index : 0,
          said: a.said,
          candidates: a.candidates,
          replacedSummary,
          partlyUnderstood: p.reasons.includes(PARTLY),
          heard: p.transcript,
        });
      }
    }
    const only = p.actions.length === 1 ? p.actions[0] : undefined;
    if (only?.kind === "log_class" && only.input.moves) {
      return classMovesCard({
        id: p.id,
        action: only,
        mask: groupsToMask(only.input.heavy_groups ?? []),
        replacedSummary,
        heard: p.transcript,
      });
    }
    return confirmCard({
      id: p.id,
      kind: p.kind,
      actions: p.actions,
      reasons: p.reasons,
      replacedSummary,
      heard: p.transcript,
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
      inputSource?: InputSource;
      transcript?: string | null;
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
      inputSource: args.inputSource,
      transcript: args.transcript,
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

  const allSkips = (actions: StagedAction[]) => actions.every((a) => a.kind === "skip_items");
  const noSkipItems = (results: LedgerResult[]) =>
    results.length > 0 && results.every((x) => x.kind === "skip" && x.items.length === 0);

  /** An executed skip card whose write skipped nothing (the items were settled meanwhile). */
  const skipWasEmpty = async (p: Pending) => noSkipItems(await ledgerResults(db, `p:${p.id}`));

  /**
   * A tap on a card whose request is over (saved, expired, replaced, cancelled): the buttons go
   * and the card shows how it ended. Best effort, and never a new chat message.
   */
  async function closeStaleCard(ctx: Context, p: Pending): Promise<void> {
    // A clarify card that was resolved and saved already shows "Exercise: …": keep it.
    if (p.status === "executed" && p.kind === "clarify_exercise") return;
    const emptySkip = p.status === "executed" && allSkips(p.actions) && (await skipWasEmpty(p));
    const text =
      p.status === "executed"
        ? p.kind === "delete"
          ? "Removed ✓"
          : allSkips(p.actions)
            ? emptySkip
              ? NOTHING_SKIPPED_DONE
              : SKIPPED_DONE
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

  /**
   * The inbox can run a handler twice. Never ask the model (or STT) again for work already done.
   * True when this update was already handled (its echoes or card are re-sent when needed).
   */
  async function alreadyHandled(ctx: Context, chatId: number, key: string): Promise<boolean> {
    const updateId = ctx.update.update_id;
    const prior = await ledgerResults(db, key);
    if (prior.length > 0) {
      await sendEchoes(ctx, key, [], prior);
      return true;
    }
    const existing = await getPendingBySourceUpdate(db, chatId, updateId);
    if (existing) {
      if (existing.status === "open" && existing.messageId === null) {
        // The first run crashed before its card went out: do what it would have done, including
        // the "Replaces: …" notice and retiring the older card.
        await sendPendingCard(ctx, chatId, existing, await getReplacedPredecessor(db, existing));
      }
      return true;
    }
    return false;
  }

  async function text(ctx: Context): Promise<void> {
    const body = ctx.message?.text;
    const chatId = ctx.chat?.id;
    if (body === undefined || chatId === undefined) return;
    if (!aiConfig()) {
      await send(ctx, NO_AI_KEY);
      return;
    }
    if (await alreadyHandled(ctx, chatId, `u:${ctx.update.update_id}`)) return;
    await handleInput(ctx, { body, source: "text" });
  }

  /** The intent pipeline for one message, typed or transcribed. */
  async function handleInput(
    ctx: Context,
    input: { body: string; source: InputSource; transcript?: string },
  ): Promise<void> {
    const { body, source } = input;
    const voice = source === "voice";
    const transcript = input.transcript ?? null;
    const heard = voice && transcript ? `${heardLine(transcript)}\n\n` : "";
    const chatId = (ctx.chat as { id: number }).id;
    const ai = aiConfig();
    if (!ai) {
      await send(ctx, NO_AI_KEY);
      return;
    }
    const updateId = ctx.update.update_id;
    const key = `u:${updateId}`;
    const now = deps.now();

    // One query at a time (session pooler rule).
    const staticBlock = await promptStatic();
    const context = await buildPromptContext(db, chatId, now);
    await appendMessage(db, chatId, "user", voice ? `[voice] ${body}` : body);

    let result: Awaited<ReturnType<typeof runIntent>>;
    try {
      result = await runIntent({
        text: voice ? `[voice] ${body}` : body,
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
      const fallback = [...result.reads].reverse().find((r) => r.fallbackHtml !== null);
      const sendFallback = async (html: string | null) => {
        await send(ctx, {
          text: heard + (html ? html : esc(NUMBER_GUARD_FALLBACK)),
          keyboard: [],
        });
        await appendMessage(
          db,
          chatId,
          "assistant",
          html ? htmlToPlain(html) : NUMBER_GUARD_FALLBACK,
        );
      };
      if (result.replyText && !result.truncated) {
        // Number guard (SPEC 3): a number the model wrote must come from this run's facts.
        const reply = stripMarkdown(result.replyText);
        const checked = checkNumbers(reply, [
          ...result.reads.map((r) => r.content),
          buildDynamicText(context),
          body,
        ]);
        if (!checked.ok) {
          console.warn(`ai: reply rejected, ${checked.unknown.length} unknown number(s)`);
          await sendFallback(fallback?.fallbackHtml ?? null);
          return;
        }
        await send(ctx, { text: heard + esc(guardLength(reply, 3000)), keyboard: [] });
        await appendMessage(db, chatId, "assistant", reply);
        return;
      }
      if (!result.truncated && fallback?.fallbackHtml) {
        // The model read something but wrote nothing: show the code-formatted answer.
        await sendFallback(fallback.fallbackHtml);
        return;
      }
      const reply = result.truncated
        ? "Sorry, that message was too long for me. Please split it."
        : DIDNT_GET_IT;
      await send(ctx, { text: heard + esc(reply), keyboard: [] });
      await appendMessage(db, chatId, "assistant", reply);
      return;
    }

    // With an unsaved request open nothing is written directly: the new actions go to a card
    // that replaces it (and says so).
    const open = await getOpenPending(db, chatId, now);
    const decision = decidePolicy(staged, {
      openPending: open !== null,
      partlyUnderstood: partly,
      voiceInput: voice,
    });
    if (decision.mode === "direct") {
      const r = await executeActions(db, key, staged, { now });
      if (r.status === "done") {
        await sendEchoes(ctx, key, staged, r.results);
        await appendMessage(
          db,
          chatId,
          "assistant",
          noSkipItems(r.results)
            ? "Nothing skipped: already done or skipped."
            : `Saved: ${plainSummary(staged)}`,
        );
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
        inputSource: source,
        transcript,
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
        inputSource: source,
        transcript,
      });
      await appendMessage(db, chatId, "assistant", `Asked to confirm: ${plainSummary(staged)}`);
    }
  }

  async function voice(ctx: Context): Promise<void> {
    const note = ctx.message?.voice;
    const chatId = ctx.chat?.id;
    if (!note || chatId === undefined) return;
    if (!aiConfig()) {
      await send(ctx, NO_AI_KEY);
      return;
    }
    let sttConfig: { stt: SpeechToText; dailySecondsCap: number } | undefined;
    try {
      sttConfig = deps.media?.stt?.();
    } catch (error) {
      console.error(`stt: not configured (${error instanceof Error ? error.name : "error"})`);
    }
    if (!sttConfig || !deps.media) {
      await send(ctx, VOICE_NOT_CONFIGURED);
      return;
    }
    if (await alreadyHandled(ctx, chatId, `u:${ctx.update.update_id}`)) return;
    if (note.duration > MAX_VOICE_SECONDS) {
      await send(ctx, VOICE_TOO_LONG);
      return;
    }
    const now = deps.now();
    const usage = createUsageStore(db);
    if ((await usage.sttSecondsToday(now)) + note.duration > sttConfig.dailySecondsCap) {
      await send(ctx, VOICE_BUDGET);
      return;
    }
    let transcript: string;
    try {
      const staticBlock = await promptStatic();
      const audio = await deps.media.download(note.file_id, VOICE_MAX_BYTES);
      transcript = (
        await sttConfig.stt.transcribe(audio, {
          filename: "voice.ogg",
          prompt: sttVocabularyPrompt(staticBlock.catalog.map((e) => e.name)),
          signal: AbortSignal.timeout(STT_TIMEOUT_MS),
        })
      ).trim();
    } catch (error) {
      console.error(`stt: failed (${error instanceof Error ? error.name : "error"})`);
      await send(ctx, VOICE_FAILED);
      return;
    }
    await usage.recordStt(note.duration, sttConfig.stt.name, now);
    if (!/[\p{L}\p{N}]/u.test(transcript)) {
      await send(ctx, VOICE_BLANK);
      return;
    }
    await handleInput(ctx, { body: transcript, source: "voice", transcript });
  }

  /** A blackboard photo: Claude vision reads the moves, the class card asks what was heavy. */
  async function photo(ctx: Context): Promise<void> {
    const sizes = ctx.message?.photo;
    const chatId = ctx.chat?.id;
    const largest = sizes?.at(-1);
    if (!largest || chatId === undefined) return;
    const ai = aiConfig();
    if (!ai) {
      await send(ctx, NO_AI_KEY);
      return;
    }
    if (await alreadyHandled(ctx, chatId, `u:${ctx.update.update_id}`)) return;
    const now = deps.now();
    const usage = createUsageStore(db);
    if (await overTokenBudget(usage, now, ai)) {
      await send(ctx, BUDGET_REACHED);
      return;
    }
    const caption = ctx.message?.caption?.trim() || undefined;
    let board: Awaited<ReturnType<typeof readBoard>>;
    try {
      if (!deps.media) throw new Error("no media source");
      const image = await deps.media.download(largest.file_id, PHOTO_MAX_BYTES);
      board = await readBoard({
        model: ai.model,
        image,
        caption,
        signal: AbortSignal.timeout(BOARD_TIMEOUT_MS),
      });
    } catch (error) {
      console.error(`photo: failed (${error instanceof Error ? error.name : "error"})`);
      await send(ctx, PHOTO_FAILED);
      return;
    }
    await usage.record(board.usage, now);
    await appendMessage(db, chatId, "user", `[photo] ${caption ?? "class board"}`);
    if (board.result.kind === "not_board") {
      await send(ctx, BOARD_UNREADABLE);
      await appendMessage(db, chatId, "assistant", BOARD_UNREADABLE);
      return;
    }
    const { moves, heavyGroups } = board.result;
    await presentPending(ctx, {
      kind: "confirm",
      actions: [
        {
          kind: "log_class",
          input: { moves, heavy_groups: heavyGroups },
          date: thursdayOnOrBefore(trainingDate(now)),
          photoFileId: largest.file_id,
          rawText: caption,
        },
      ],
      reasons: ["class_moves"],
      updateId: ctx.update.update_id,
      now,
      inputSource: "photo",
    });
    const breakdown = classBreakdown(moves)
      .map((r) => `${r.group} ${plural(r.moves, "move")} ${plural(r.sets, "set")}`)
      .join(", ");
    await appendMessage(
      db,
      chatId,
      "assistant",
      `Asked which class parts were heavy: ${breakdown}`,
    );
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
      case "cm":
        return classMovesButton(ctx, a.id, a.mask, a.save, answer, now);
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
        await retireEcho(ctx, snap);
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
      case "uw": {
        const undone = await undoWrite(db, a.key, a.index, now);
        if (undone.status === "stale") {
          await answer("Can't undo: it changed since.");
          await remember(chatOf(ctx), "Undo refused: the value changed since; nothing changed.");
          return;
        }
        if (undone.status === "none") {
          await answer("Nothing to undo.");
          await remember(chatOf(ctx), "Undo found nothing to undo.");
          return;
        }
        await edit(ctx, esc(undone.text));
        await answer("Undone.");
        await remember(chatOf(ctx), undone.text);
        return;
      }
      case "sk":
        return skip.skipTap(ctx, a, answer);
      case "us":
        return skip.undoTap(ctx, a, answer);
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
      await remember(
        chatId,
        allSkips(pending.actions) && (await skipWasEmpty(pending))
          ? "A tapped button was too late: nothing was skipped."
          : "A tapped button was too late: the request was already saved.",
      );
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
    const doneText =
      pending.kind === "delete"
        ? "Removed ✓"
        : allSkips(pending.actions)
          ? SKIPPED_DONE
          : "Saved ✓";
    const key = `p:${id}`;
    const r = await executeActions(db, key, pending.actions, {
      pendingId: id,
      now,
      source: pending.inputSource,
    });
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
    // Every item was done or skipped meanwhile: the card must not claim a skip happened.
    const nothingSkipped = noSkipItems(r.results);
    const finalText = nothingSkipped ? NOTHING_SKIPPED_DONE : doneText;
    await editQuietly(ctx, finalText);
    await answer(finalText);
    await sendEchoes(ctx, key, pending.actions, r.results);
    await remember(
      chatId,
      nothingSkipped
        ? "Nothing skipped (user confirmed): already done or skipped."
        : `${pending.kind === "delete" ? "Removed" : "Saved"} (user confirmed): ${plainSummary(pending.actions)}`,
    );
  }

  /** Toggles and Save of a class-with-moves card: the heavy mask rides in the button, the pending holds the moves. */
  async function classMovesButton(
    ctx: Context,
    id: number,
    mask: number,
    save: boolean,
    answer: Answer,
    now: Date,
  ): Promise<void> {
    const chatId = chatOf(ctx);
    const pending = await getPending(db, id);
    const action =
      pending?.actions.length === 1 && pending.actions[0]?.kind === "log_class"
        ? pending.actions[0]
        : undefined;
    if (!pending || !action?.input.moves) {
      await answer(EXPIRED);
      await remember(chatId, "A tapped request was not found (expired); nothing changed.");
      return;
    }
    if (pending.status === "executed") {
      await answer("Already saved.");
      await closeStaleCard(ctx, pending);
      await remember(chatId, "A tapped button was too late: the request was already saved.");
      return;
    }
    if (pending.status !== "open" || pending.expiresAt.getTime() <= now.getTime()) {
      await answer(EXPIRED);
      await closeStaleCard(ctx, pending);
      await remember(chatId, "A tapped class button found the request expired; nothing changed.");
      return;
    }
    if (!save) {
      await edit(
        ctx,
        classMovesCard({
          id,
          action: { ...action, input: { ...action.input, heavy_groups: maskToGroups(mask) } },
          mask,
          heard: pending.transcript,
        }),
      );
      await answer();
      return;
    }
    const toSave = {
      ...action,
      input: { ...action.input, heavy_groups: maskToGroups(mask) },
    };
    const key = `p:${id}`;
    const r = await executeActions(db, key, [toSave], {
      pendingId: id,
      now,
      source: pending.inputSource,
      replaceActions: [toSave],
      replaceReasons: pending.reasons,
    });
    if (r.status !== "done") {
      await answer(r.status === "stale" ? STALE : EXPIRED);
      if (r.status === "stale") await editQuietly(ctx, STALE);
      else await closeStaleCard(ctx, (await getPending(db, id)) ?? pending);
      await remember(chatId, "The tapped class card could not be saved; nothing changed.");
      return;
    }
    const result = r.results[0];
    if (result?.kind === "class") await editQuietly(ctx, directWriteSaved(result, key, 0));
    else await editQuietly(ctx, "Saved ✓");
    await answer("Saved.");
    await remember(chatId, `Saved (user confirmed): ${plainSummary([toSave])}`);
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
    const d = decidePolicy(pending.actions, { voiceInput: pending.inputSource === "voice" });
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
    const next = decidePolicy(actions, {
      partlyUnderstood: partly,
      voiceInput: pending.inputSource === "voice",
    });
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
            heard: pending.transcript,
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
      await edit(
        ctx,
        confirmCard({
          id: pendingId,
          kind,
          actions,
          reasons: next.reasons,
          heard: pending.transcript,
        }),
      );
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
      source: pending.inputSource,
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

  const skip = createSkipFlow({
    db,
    now: deps.now,
    send,
    edit,
    editQuietly,
    remember,
    chatOf,
    presentPending,
  });

  return {
    text,
    voice,
    photo,
    callback,
    undoCommand,
    memoryCommand,
    skipCommand: skip.skipCommand,
  };
}
