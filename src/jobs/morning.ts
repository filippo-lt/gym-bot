import { desc, eq } from "drizzle-orm";
import { DateTime } from "luxon";
import { formatFinished } from "../bot/format.js";
import { classCard } from "../bot/inputs-flow.js";
import { morningMessage, renderTodayText } from "../bot/morning.js";
import { APP_TIMEZONE } from "../config/constants.js";
import { logGroups, plans } from "../db/schema/index.js";
import { planWeekFor } from "../domain/calendar.js";
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

/** The first Monday-Friday after the plan's last day. */
export function isFirstWeekdayAfterPlan(date: string, startDate: string, weeks: number): boolean {
  let first = DateTime.fromISO(startDate, { zone: "utc" }).plus({ days: weeks * 7 });
  if (first.weekday === 6) first = first.plus({ days: 2 });
  else if (first.weekday === 7) first = first.plus({ days: 1 });
  return first.toISODate() === date;
}

export const morningJob: Job = {
  name: "morning",
  window: morningWindow,
  async run(ctx, date) {
    const [plan] = await ctx.db.select().from(plans).orderBy(desc(plans.id)).limit(1);
    if (!plan) return "skipped";
    const status = planWeekFor(date, plan.startDate, plan.weeks).status;
    if (status === "finished") {
      if (!isFirstWeekdayAfterPlan(date, plan.startDate, plan.weeks)) return "skipped";
      await ctx.send({ text: formatFinished(), keyboard: [] });
      return "sent";
    }
    if (status !== "active") return "skipped";
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
