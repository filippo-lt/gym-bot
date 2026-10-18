import { DateTime } from "luxon";
import { BackupTooLargeError, sendBackup } from "../backup/send.js";
import { APP_TIMEZONE } from "../config/constants.js";
import { aiEnv, sttEnv } from "../config/env.js";
import { classify } from "../failures/classify.js";
import { reasonPhrase } from "../failures/messages.js";
import { createUsageStore } from "../logging/usage.js";
import type { Job } from "./runner.js";

/** From 22:30 Rome the next tick is the last one in the window. */
export function isLastChance(now: Date): boolean {
  const local = DateTime.fromJSDate(now, { zone: APP_TIMEZONE });
  return local.hour * 60 + local.minute >= 22 * 60 + 30;
}

function cap(read: () => number): number | null {
  try {
    return read();
  } catch {
    return null; // not configured: show the usage without a cap
  }
}

/** Sunday 18:00 <= Rome time < 23:00. */
export const weeklyBackupJob: Job = {
  name: "weekly_backup",
  window(now) {
    const local = DateTime.fromJSDate(now, { zone: APP_TIMEZONE });
    const date = local.toISODate();
    if (!date || local.weekday !== 7) return null;
    if (local.hour < 18 || local.hour >= 23) return null;
    return { date };
  },
  async run(ctx) {
    try {
      const totals = await createUsageStore(ctx.db).weekTotals(ctx.now);
      await sendBackup({
        db: ctx.db,
        now: ctx.now,
        send: ctx.send,
        sendFile: ctx.sendFile,
        weekly: {
          ...totals,
          caps: {
            tokens: cap(() => aiEnv().AI_DAILY_TOKEN_CAP),
            sttSeconds: cap(() => sttEnv().STT_DAILY_SECONDS_CAP),
          },
        },
      });
      return "sent";
    } catch (error) {
      if (error instanceof BackupTooLargeError) {
        // Retrying cannot help: say so once and finish the job.
        const mb = (error.bytes / (1024 * 1024)).toFixed(1);
        await ctx.send({
          text: `Weekly backup too large for Telegram (${mb} MB). Run pnpm backup locally (no size limit).`,
          keyboard: [],
        });
        return "sent";
      }
      if (isLastChance(ctx.now)) {
        const reason = reasonPhrase(classify(error, "other"));
        try {
          await ctx.send({
            text: `Weekly backup failed (${reason}). Use /export or pnpm backup.`,
            keyboard: [],
          });
        } catch {
          // the failure notice is best effort
        }
      }
      throw error;
    }
  },
};
