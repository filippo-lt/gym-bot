import { sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { CACHE_READ_WEIGHT, CACHE_WRITE_WEIGHT } from "../ai/constants.js";
import { APP_TIMEZONE } from "../config/constants.js";
import { usageLogs } from "../db/schema/agent.js";
import type { Q } from "./db.js";
import type { TokenUsage, UsageStore } from "./types.js";

function romeDate(now: Date): DateTime {
  return DateTime.fromJSDate(now, { zone: APP_TIMEZONE });
}

/** SQL twin of `countedTokens`; weights come from the same constants. */
const counted = sql`(${usageLogs.inputTokens} + ${usageLogs.outputTokens} + ${CACHE_WRITE_WEIGHT}::float8 * ${usageLogs.cacheWriteTokens} + ${CACHE_READ_WEIGHT}::float8 * ${usageLogs.cacheReadTokens})`;

export function createUsageStore(db: Q): UsageStore {
  return {
    async totals(now) {
      const d = romeDate(now);
      const day = d.toISODate() as string;
      const monthStart = d.startOf("month").toISODate() as string;
      const monthEnd = d.endOf("month").toISODate() as string;
      const [row] = await db
        .select({
          day: sql<number>`coalesce(sum(case when ${usageLogs.date} = ${day} then ${counted} else 0 end), 0)::float8`,
          month: sql<number>`coalesce(sum(${counted}), 0)::float8`,
        })
        .from(usageLogs)
        .where(sql`${usageLogs.date} >= ${monthStart} and ${usageLogs.date} <= ${monthEnd}`);
      return { day: Number(row?.day ?? 0), month: Number(row?.month ?? 0) };
    },
    async weekTotals(now) {
      const d = romeDate(now);
      const start = d.startOf("week").toISODate() as string; // Luxon weeks start on Monday
      const end = d.endOf("week").toISODate() as string;
      const [row] = await db
        .select({
          tokens: sql<number>`coalesce(sum(${counted}), 0)::float8`,
          stt: sql<number>`coalesce(sum(${usageLogs.sttSeconds}), 0)::float8`,
        })
        .from(usageLogs)
        .where(sql`${usageLogs.date} >= ${start} and ${usageLogs.date} <= ${end}`);
      return { tokens: Number(row?.tokens ?? 0), sttSeconds: Number(row?.stt ?? 0) };
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
    async sttSecondsToday(now) {
      const day = romeDate(now).toISODate() as string;
      const [row] = await db
        .select({ s: sql<number>`coalesce(sum(${usageLogs.sttSeconds}), 0)::float8` })
        .from(usageLogs)
        .where(sql`${usageLogs.date} = ${day}`);
      return Number(row?.s ?? 0);
    },
    async recordStt(seconds, provider, now) {
      await db.insert(usageLogs).values({
        date: romeDate(now).toISODate() as string,
        model: provider,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        sttSeconds: Math.round(seconds),
      });
    },
  };
}
