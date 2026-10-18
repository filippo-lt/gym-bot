/**
 * Small inputs of the progression engine (M5): /readiness, /bw, /class and the HSPU advance card.
 * Writes go through the same executor (write_ledger, Undo) as logs; every number comes from DB rows or parsed input.
 */
import { and, desc, eq, gt } from "drizzle-orm";
import type { Context } from "grammy";
import { DateTime } from "luxon";
import { logGroups } from "../db/schema/log.js";
import { exercises } from "../db/schema/plan.js";
import { proposals } from "../db/schema/progression.js";
import type { Db } from "../db/seed-plan.js";
import { thursdayOnOrBefore, trainingDate, weekdayOf } from "../domain/calendar.js";
import { executeActions } from "../logging/execute.js";
import type { LedgerResult } from "../logging/types.js";
import { logBodyweightInputSchema } from "../logging/types.js";
import { loadFrozenLevel } from "../progression/load-history.js";
import type { SessionAdvice } from "../progression/session-advice.js";
import { refreshUserState } from "../progression/store.js";
import { type CallbackAction, cb, parseCallback } from "./callbacks.js";
import { day, esc } from "./format.js";
import {
  directWriteSaved,
  CLASS_HEAVY_GROUPS as GROUPS,
  inlineKeyboard,
  type Message,
  maskToGroups,
} from "./log-format.js";
import { morningMessage, renderTodayText } from "./morning.js";

const HTML = { parse_mode: "HTML" as const };

export const BW_USAGE = "Send your bodyweight in kg, for example: /bw 78.5";
export const READINESS_QUESTION = "How do you feel today?";

export const READINESS_EMOJI = { t: "😴", o: "🙂", s: "💪" } as const;

const opts = (m: Message) =>
  m.keyboard.length ? { ...HTML, reply_markup: inlineKeyboard(m.keyboard) } : HTML;

/** "78.5", "78,5", "78.5kg" -> 78.5; null when it is not a plausible bodyweight. */
export function parseKg(arg: string): number | null {
  const m = /^\s*(\d{2,3}(?:[.,]\d{1,2})?)\s*(?:kg)?\s*$/i.exec(arg);
  if (!m) return null;
  const parsed = logBodyweightInputSchema.safeParse({
    kg: Number((m[1] as string).replace(",", ".")),
  });
  return parsed.success ? parsed.data.kg : null;
}

// Shared with the class-with-moves card (log-format.ts); re-exported so callers keep this import.
export { maskToGroups };

export function readinessCard(): Message {
  return {
    text: READINESS_QUESTION,
    keyboard: [
      (["t", "o", "s"] as const).map((l) => ({
        text: READINESS_EMOJI[l],
        data: cb.readiness(l),
      })),
    ],
  };
}

export function classCard(date: string, mask: number): Message {
  const picked = maskToGroups(mask);
  return {
    text: [
      `Thursday class (${day(date, "ccc d LLL")}): which parts were heavy?`,
      `Selected: ${picked.length ? picked.join(", ") : "none (= not heavy)"}. Tap to change, then Save.`,
    ].join("\n"),
    keyboard: [
      GROUPS.map((g) => ({
        text: `${(mask & g.bit) !== 0 ? "✓ " : ""}${g.label}`,
        data: cb.classMask(mask ^ g.bit, date),
      })),
      [
        { text: "Not heavy", data: cb.classMask(0, date) },
        { text: "Save", data: cb.classSave(mask, date) },
      ],
    ],
  };
}

export function proposalCard(id: number, from: string, to: string): Message {
  return {
    text: `You hit the target on 2 clean HSPU sessions at ${esc(from)}. Move to ${esc(to)}?`,
    keyboard: [
      [
        { text: "✅", data: cb.proposal(id, "ok") },
        { text: "❌", data: cb.proposal(id, "no") },
      ],
    ],
  };
}

const nextDay = (iso: string): string =>
  DateTime.fromISO(iso, { zone: "utc" }).plus({ days: 1 }).toISODate() as string;

export interface InputsDeps {
  db: Db;
  now: () => Date;
  /** Sends today's (adjusted) session as a new message. */
  sendToday: (ctx: Context) => Promise<void>;
}

export interface Inputs {
  readinessCommand(ctx: Context): Promise<void>;
  bodyweightCommand(ctx: Context): Promise<void>;
  classCommand(ctx: Context): Promise<void>;
  callback(ctx: Context): Promise<void>;
  /** Sends the "move to the next HSPU step?" card when the engine proposes it (live sessions only). */
  hspuProposal(ctx: Context, advice: SessionAdvice | null): Promise<void>;
}

export function createInputs(deps: InputsDeps): Inputs {
  const { db } = deps;

  const reply = (ctx: Context, m: Message) => ctx.reply(m.text, opts(m));
  const edit = async (ctx: Context, m: Message) => {
    try {
      await ctx.editMessageText(m.text, opts(m));
    } catch (error) {
      const d = (error as { description?: unknown } | null)?.description;
      if (!(typeof d === "string" && d.includes("message is not modified"))) throw error;
    }
  };

  async function readinessCommand(ctx: Context): Promise<void> {
    await reply(ctx, readinessCard());
  }

  async function bodyweightCommand(ctx: Context): Promise<void> {
    const arg = typeof ctx.match === "string" ? ctx.match : "";
    const kg = parseKg(arg);
    if (kg === null) {
      await ctx.reply(esc(BW_USAGE), HTML);
      return;
    }
    const now = deps.now();
    const key = `u:${ctx.update.update_id}`;
    const r = await executeActions(
      db,
      key,
      [{ kind: "log_bodyweight", input: { kg }, date: trainingDate(now) }],
      { now },
    );
    const result = r.status === "done" ? r.results[0] : undefined;
    if (result?.kind === "bodyweight") await reply(ctx, directWriteSaved(result, key, 0));
  }

  async function classCommand(ctx: Context): Promise<void> {
    await reply(ctx, classCard(thursdayOnOrBefore(trainingDate(deps.now())), 0));
  }

  async function readinessTap(
    ctx: Context,
    level: "t" | "o" | "s",
    morningDate?: string,
  ): Promise<void> {
    const now = deps.now();
    const date = trainingDate(now);
    if (morningDate !== undefined && morningDate !== date) {
      await ctx.answerCallbackQuery({ text: "That button is from another day." });
      return;
    }
    // Through the ledger: a double tap or a redelivered update writes one row.
    await executeActions(
      db,
      `u:${ctx.update.update_id}`,
      [
        {
          kind: "log_readiness",
          input: { signal: level === "s" ? "good" : "exhausted" },
          date,
          button: level,
        },
      ],
      { now },
    );
    if (morningDate === undefined) {
      await edit(ctx, { text: `Noted: ${READINESS_EMOJI[level]}`, keyboard: [] });
    } else {
      // The re-freeze already ran inside executeActions: re-render the session with the new level.
      const { text } = await renderTodayText(db, date, now);
      await edit(ctx, morningMessage(text, date, level));
    }
    await ctx.answerCallbackQuery();
    // The signal moves the level only while it is frozen and nothing is logged; later it counts for the next day.
    const [started] = await db
      .select({ id: logGroups.id })
      .from(logGroups)
      .where(eq(logGroups.sessionDate, date))
      .limit(1);
    const frozen = await loadFrozenLevel(db, date);
    if (started && frozen) {
      await ctx.reply(
        `You already started today, so today stays ${frozen}. I'll use this tomorrow.`,
      );
    }
    if (morningDate === undefined) await deps.sendToday(ctx);
  }

  async function classTap(ctx: Context, mask: number, date: string, save: boolean): Promise<void> {
    const now = deps.now();
    if (weekdayOf(date) !== "thu") {
      await ctx.answerCallbackQuery({ text: "That button is no longer valid." });
      return;
    }
    if (!save) {
      await edit(ctx, classCard(date, mask));
      await ctx.answerCallbackQuery();
      return;
    }
    const key = `u:${ctx.update.update_id}`;
    const r = await executeActions(
      db,
      key,
      [{ kind: "log_class", input: { heavy_groups: maskToGroups(mask) }, date }],
      { now },
    );
    const result: LedgerResult | undefined = r.status === "done" ? r.results[0] : undefined;
    if (result?.kind === "class") await edit(ctx, directWriteSaved(result, key, 0));
    await ctx.answerCallbackQuery({ text: "Saved." });
    // Saved on the Friday right after that Thursday: show the session again with the Friday adjustments.
    if (result?.kind === "class" && trainingDate(now) === nextDay(date)) await deps.sendToday(ctx);
  }

  async function proposalTap(ctx: Context, id: number, act: "ok" | "no"): Promise<void> {
    const now = deps.now();
    const [row] = await db.select().from(proposals).where(eq(proposals.id, id));
    const p = row?.payload as { fromName?: string; toName?: string } | undefined;
    const decided = await db.transaction(async (tx) => {
      const updated = await tx
        .update(proposals)
        .set({ status: act === "ok" ? "accepted" : "declined", decidedAt: now })
        .where(and(eq(proposals.id, id), eq(proposals.status, "open")))
        .returning({ id: proposals.id });
      // The accepted step is the current one until a newer log (SPEC 5.2): rebuild the cache.
      if (updated.length > 0 && act === "ok") await refreshUserState(tx);
      return updated.length > 0;
    });
    if (!row || !decided) {
      await ctx.answerCallbackQuery({ text: "Already decided." });
      return;
    }
    await edit(ctx, {
      text:
        act === "ok"
          ? `Moved HSPU to ${esc(p?.toName ?? "the next step")} ✓`
          : `OK, staying on ${esc(p?.fromName ?? "this step")}.`,
      keyboard: [],
    });
    await ctx.answerCallbackQuery({ text: act === "ok" ? "Moved." : "Staying." });
  }

  async function callback(ctx: Context): Promise<void> {
    const a: CallbackAction | null = parseCallback(ctx.callbackQuery?.data ?? "");
    if (a?.t === "rd") return readinessTap(ctx, a.level, a.morningDate);
    if (a?.t === "cg") return classTap(ctx, a.mask, a.date, a.save);
    if (a?.t === "pr") return proposalTap(ctx, a.id, a.act);
    await ctx.answerCallbackQuery({ text: "That button is no longer valid." });
  }

  async function hspuProposal(ctx: Context, advice: SessionAdvice | null): Promise<void> {
    if (advice?.mode !== "live") return;
    const adv = [...advice.items.values()].find((i) => i.hspuAdvance)?.hspuAdvance;
    if (!adv) return;
    const open = await db
      .select()
      .from(proposals)
      .where(and(eq(proposals.kind, "hspu_advance"), eq(proposals.status, "open")))
      .orderBy(desc(proposals.id));
    const same = (p: { payload: unknown }) => {
      const x = p.payload as { fromStepOrder?: number; toStepOrder?: number };
      return x.fromStepOrder === adv.from.order && x.toStepOrder === adv.to.order;
    };
    // A "no" is respected until the next HSPU log.
    const [declined] = await db
      .select()
      .from(proposals)
      .where(and(eq(proposals.kind, "hspu_advance"), eq(proposals.status, "declined")))
      .orderBy(desc(proposals.decidedAt))
      .limit(1);
    if (declined?.decidedAt && same(declined)) {
      const [newer] = await db
        .select({ id: logGroups.id })
        .from(logGroups)
        .innerJoin(exercises, eq(exercises.id, logGroups.exerciseId))
        .where(
          and(eq(exercises.type, "skill_ladder"), gt(logGroups.performedAt, declined.decidedAt)),
        )
        .limit(1);
      if (!newer) return;
    }
    for (const p of open.filter((x) => !same(x))) {
      await db.update(proposals).set({ status: "expired" }).where(eq(proposals.id, p.id));
    }
    let row = open.find(same);
    if (!row) {
      [row] = await db
        .insert(proposals)
        .values({
          kind: "hspu_advance",
          payload: {
            fromStepOrder: adv.from.order,
            toStepOrder: adv.to.order,
            fromName: adv.from.name,
            toName: adv.to.name,
            date: advice.date,
          },
        })
        .returning();
    }
    if (!row || row.messageId !== null) return;
    const sent = (await reply(ctx, proposalCard(row.id, adv.from.name, adv.to.name))) as
      | { message_id?: number }
      | undefined;
    if (sent?.message_id !== undefined) {
      await db
        .update(proposals)
        .set({ messageId: sent.message_id })
        .where(eq(proposals.id, row.id));
    }
  }

  return { readinessCommand, bodyweightCommand, classCommand, callback, hspuProposal };
}
