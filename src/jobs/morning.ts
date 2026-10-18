import { eq } from "drizzle-orm";
import { DateTime } from "luxon";
import { formatFinished } from "../bot/format.js";
import { classCard } from "../bot/inputs-flow.js";
import { morningMessage, renderTodayText } from "../bot/morning.js";
import { getSession } from "../bot/session.js";
import { APP_TIMEZONE } from "../config/constants.js";
import { logGroups } from "../db/schema/index.js";
import { CLASS_QUESTION } from "./class-question.js";
import type { Job } from "./runner.js";

/** Mon-Fri, 06:00 <= Rome time < 10:00. */
export function morningWindow(now: Date): { date: string } | null {
  const local = DateTime.fromJSDate(now, { zone: APP_TIMEZONE });
  const date = local.toISODate();
  if (!date || local.weekday > 5) return null;
  if (local.hour < 6 || local.hour >= 10) return null;
  return { date };
}

/** The weekday before `date`: Monday goes back to the previous Friday. */
export function previousWeekday(date: string): string {
  const d = DateTime.fromISO(date, { zone: "utc" });
  return d.minus({ days: d.weekday === 1 ? 3 : 1 }).toISODate() as string;
}

export const morningJob: Job = {
  name: "morning",
  window: morningWindow,
  async run(ctx, date) {
    const session = await getSession(ctx.db, date);
    if (session.kind === "finished") {
      // Only the first weekday after the plan ends gets the closing message.
      const before = await getSession(ctx.db, previousWeekday(date));
      if (before.kind === "finished") return "skipped";
      await ctx.send({ text: formatFinished(), keyboard: [] });
      return "sent";
    }
    if (session.kind !== "session") return "skipped";
    const [started] = await ctx.db
      .select({ id: logGroups.id })
      .from(logGroups)
      .where(eq(logGroups.sessionDate, date))
      .limit(1);
    if (started) return "skipped";
    const today = await renderTodayText(ctx.db, date, ctx.now);
    if (today.askClassFirst && today.thursday) {
      const card = classCard(today.thursday, 0);
      await ctx.send({ text: `${CLASS_QUESTION}\n\n${card.text}`, keyboard: card.keyboard });
    }
    await ctx.send(morningMessage(today.text, date));
    return "sent";
  },
};
