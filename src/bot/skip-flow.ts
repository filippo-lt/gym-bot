/**
 * /skip (SPEC 5.7): the item list, the taps on it and Undo. Taps rebuild the open items from the
 * DB and then follow the same policy as free text (SPEC 5.6d): a single non-PRIMARY skip is
 * written at once, a PRIMARY item or the whole session turns the list into a confirm card.
 */
import type { Context } from "grammy";
import type { Db } from "../db/seed-plan.js";
import { trainingDate } from "../domain/calendar.js";
import { describeAction } from "../logging/describe.js";
import { executeActions, ledgerResults } from "../logging/execute.js";
import {
  getOpenPending,
  getPendingBySourceUpdate,
  type Pending,
  type PendingKind,
} from "../logging/pending.js";
import { decidePolicy } from "../logging/policy.js";
import { loadSkipDay, skipAction, undoSkip } from "../logging/skip.js";
import type { LedgerResult, StagedAction } from "../logging/types.js";
import type { CallbackAction } from "./callbacks.js";
import type { Message } from "./log-format.js";
import {
  NO_SESSION,
  NOTHING_TO_SKIP,
  SKIP_STALE,
  skipEcho,
  skipList,
  skipUndone,
} from "./skip-format.js";

type Answer = (text?: string) => Promise<void>;

/** The flow helpers the skip buttons need (the logging flow owns them). */
export interface SkipFlowDeps {
  db: Db;
  now: () => Date;
  send: (ctx: Context, m: Message | string) => Promise<number | undefined>;
  edit: (ctx: Context, m: Message | string) => Promise<void>;
  editQuietly: (ctx: Context, m: Message | string) => Promise<void>;
  remember: (chatId: number | undefined, text: string) => Promise<void>;
  chatOf: (ctx: Context) => number | undefined;
  /** Sends the confirm card as free text does (replaced card retired, "Replaces: …" notice). */
  presentPending: (
    ctx: Context,
    args: {
      kind: PendingKind;
      actions: StagedAction[];
      reasons: string[];
      updateId: number | null;
      now: Date;
    },
  ) => Promise<Pending>;
}

export function createSkipFlow(deps: SkipFlowDeps) {
  const { db, send, edit, editQuietly, remember, chatOf } = deps;

  async function skipCommand(ctx: Context): Promise<void> {
    const date = trainingDate(deps.now());
    const day = await loadSkipDay(db, date);
    if (!day.hasSession) return void (await send(ctx, NO_SESSION));
    if (day.open.length === 0) return void (await send(ctx, NOTHING_TO_SKIP));
    await send(ctx, skipList(date, day.open));
  }

  /** The tapped message only ever shows the list: re-render it after a tap (best effort). */
  async function refreshList(ctx: Context, date: string): Promise<void> {
    try {
      const day = await loadSkipDay(db, date);
      await editQuietly(ctx, day.open.length ? skipList(date, day.open) : NOTHING_TO_SKIP);
    } catch {
      // the list is only a convenience
    }
  }

  /** If the edit fails after a committed write, the text goes out as a message instead. */
  async function editOrSend(ctx: Context, m: Message): Promise<void> {
    try {
      await edit(ctx, m);
    } catch {
      await send(ctx, m);
    }
  }

  async function echoOf(
    ctx: Context,
    key: string,
    results: LedgerResult[],
    answer: Answer,
  ): Promise<boolean> {
    const r = results[0];
    if (r?.kind !== "skip") return false;
    await send(ctx, skipEcho(r, key, 0));
    await answer(r.items.length ? "Skipped." : SKIP_STALE);
    return true;
  }

  async function skipTap(
    ctx: Context,
    a: Extract<CallbackAction, { t: "sk" }>,
    answer: Answer,
  ): Promise<void> {
    const chatId = chatOf(ctx);
    const now = deps.now();
    const updateId = ctx.update.update_id;
    const key = `u:${updateId}`;

    // A retried update: the write (or the card) of the first run is already stored.
    const prior = await ledgerResults(db, key);
    if (prior.length > 0 && (await echoOf(ctx, key, prior, answer))) {
      await refreshList(ctx, a.date);
      return;
    }
    const existing =
      chatId === undefined ? null : await getPendingBySourceUpdate(db, chatId, updateId);
    if (existing) {
      // Re-sends the card only if the first run crashed before it went out.
      if (existing.status === "open") {
        await deps.presentPending(ctx, {
          kind: "confirm",
          actions: existing.actions,
          reasons: existing.reasons,
          updateId,
          now,
        });
      }
      await answer();
      await refreshList(ctx, a.date);
      return;
    }

    if (a.date !== trainingDate(now)) {
      await answer();
      await editQuietly(ctx, "This list is from another day. Send /skip again.");
      await remember(chatId, "A tapped skip button was from another day; nothing changed.");
      return;
    }
    const day = await loadSkipDay(db, a.date);
    const targets =
      a.item === "all" ? day.open : day.open.filter((t) => t.plannedItemId === a.item);
    if (targets.length === 0 || (a.item !== "all" && targets.length !== 1)) {
      await answer(SKIP_STALE);
      await refreshList(ctx, a.date);
      await remember(chatId, "A tapped skip button was for an item already done or skipped.");
      return;
    }
    const action = skipAction(a.date, a.item === "all", targets);
    const open = chatId === undefined ? null : await getOpenPending(db, chatId, now);
    const decision = decidePolicy([action], { openPending: open !== null });

    if (decision.mode === "direct") {
      const r = await executeActions(db, key, [action], { now });
      if (r.status !== "done" || !(await echoOf(ctx, key, r.results, answer))) {
        await answer(SKIP_STALE);
        return;
      }
      await refreshList(ctx, a.date);
      const skipped = r.results[0]?.kind === "skip" ? r.results[0].items : [];
      await remember(
        chatId,
        skipped.length
          ? `Skipped (button): ${skipped.map((i) => i.planName).join(", ")}`
          : "A tapped skip button found the item already done or skipped; nothing changed.",
      );
      return;
    }
    if (decision.mode !== "confirm" || chatId === undefined) {
      await answer(SKIP_STALE);
      return;
    }
    await deps.presentPending(ctx, {
      kind: "confirm",
      actions: [action],
      reasons: decision.reasons,
      updateId,
      now,
    });
    await refreshList(ctx, a.date);
    await answer();
    await remember(chatId, `Asked to confirm: ${describeAction(action)}`);
  }

  async function undoTap(
    ctx: Context,
    a: Extract<CallbackAction, { t: "us" }>,
    answer: Answer,
  ): Promise<void> {
    const undone = await undoSkip(db, a.key, a.index);
    if (undone.status === "none") {
      await answer("Nothing to undo.");
      await remember(chatOf(ctx), "Skip not undone: nothing to undo.");
      return;
    }
    await editOrSend(ctx, skipUndone(undone.names));
    await answer("Skip undone.");
    await remember(chatOf(ctx), `Skip undone: ${undone.names.join(", ")}`);
  }

  return { skipCommand, skipTap, undoTap };
}
