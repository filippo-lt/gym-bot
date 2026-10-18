import { sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { APP_TIMEZONE } from "../config/constants.js";
import { usageLogs } from "../db/schema/agent.js";
import type { Q } from "./db.js";
import type { TokenUsage, UsageStore } from "./types.js";

function romeDate(now: Date): DateTime {
  return DateTime.fromJSDate(now, { zone: APP_TIMEZONE });
}

export function createUsageStore(db: Q): UsageStore {
  return {
    async totals(now) {
      const d = romeDate(now);
      const day = d.toISODate() as string;
      const monthStart = d.startOf("month").toISODate() as string;
      const monthEnd = d.endOf("month").toISODate() as string;
      const [row] = await db
        .select({
          day: sql<number>`coalesce(sum(case when ${usageLogs.date} = ${day} then ${usageLogs.inputTokens} + ${usageLogs.outputTokens} else 0 end), 0)::float8`,
          month: sql<number>`coalesce(sum(${usageLogs.inputTokens} + ${usageLogs.outputTokens}), 0)::float8`,
        })
        .from(usageLogs)
        .where(sql`${usageLogs.date} >= ${monthStart} and ${usageLogs.date} <= ${monthEnd}`);
      return { day: Number(row?.day ?? 0), month: Number(row?.month ?? 0) };
    },
    async record(usage: TokenUsage, now) {
      await db.insert(usageLogs).values({
        date: romeDate(now).toISODate() as string,
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
      });
    },
  };
}
