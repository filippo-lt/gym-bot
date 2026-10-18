import { eq } from "drizzle-orm";
import { DateTime } from "luxon";
import { classCard } from "../bot/inputs-flow.js";
import { APP_TIMEZONE } from "../config/constants.js";
import { classLogs, plans } from "../db/schema/index.js";
import { planWeekFor, weekdayOf } from "../domain/calendar.js";
import type { Job } from "./runner.js";

export const CLASS_QUESTION =
  "How did class go? Send a photo of the board, a voice note, or tap below.";

/** Thursday 21:00 <= Rome time < 23:00. */
export const classQuestionJob: Job = {
  name: "class_question",
  window(now) {
    const local = DateTime.fromJSDate(now, { zone: APP_TIMEZONE });
    const date = local.toISODate();
    if (!date || weekdayOf(date) !== "thu") return null;
    if (local.hour < 21 || local.hour >= 23) return null;
    return { date };
  },
  async run(ctx, date) {
    const [plan] = await ctx.db.select().from(plans).limit(1);
    if (!plan || planWeekFor(date, plan.startDate, plan.weeks).status !== "active") {
      return "skipped";
    }
    const [logged] = await ctx.db
      .select({ id: classLogs.id })
      .from(classLogs)
      .where(eq(classLogs.date, date));
    if (logged) return "skipped";
    const card = classCard(date, 0);
    await ctx.send({ text: `${CLASS_QUESTION}\n\n${card.text}`, keyboard: card.keyboard });
    return "sent";
  },
};
