import type { Context } from "grammy";
import { InputFile } from "grammy";
import { BackupTooLargeError, sendBackup } from "../backup/send.js";
import type { Db } from "../db/seed-plan.js";
import { classify, describeFailure } from "../failures/classify.js";
import { reasonPhrase } from "../failures/messages.js";

export interface ExportDeps {
  db: Db;
  now: () => Date;
  /** Test seam. */
  backup?: typeof sendBackup;
}

/** /export: the same backup as the Sunday job, sent to this chat. */
export function createExportCommand(deps: ExportDeps): (ctx: Context) => Promise<void> {
  const backup = deps.backup ?? sendBackup;
  return async (ctx) => {
    await ctx.reply("Preparing your backup…");
    try {
      await backup({
        db: deps.db,
        now: deps.now(),
        weekly: null,
        send: async (m) => {
          await ctx.reply(m.text, { parse_mode: "HTML" });
        },
        sendFile: async (f) => {
          const file = new InputFile(f.data, f.name);
          if (f.kind === "photo") {
            await ctx.replyWithPhoto(file, f.caption ? { caption: f.caption } : {});
          } else {
            await ctx.replyWithDocument(file, f.caption ? { caption: f.caption } : {});
          }
        },
      });
    } catch (error) {
      if (error instanceof BackupTooLargeError) {
        const mb = (error.bytes / (1024 * 1024)).toFixed(1);
        await ctx.reply(
          `Backup too large for Telegram (${mb} MB). Run pnpm backup locally (no size limit).`,
        );
        return;
      }
      const failure = classify(error, "other");
      console.error("export: failed,", describeFailure(failure));
      await ctx.reply(`Backup failed (${reasonPhrase(failure)}). Please try again.`);
    }
  };
}
