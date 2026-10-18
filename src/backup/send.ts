import type { Message } from "../bot/log-format.js";
import type { Db } from "../db/client.js";
import type { SendFile } from "../jobs/runner.js";
import { backupFiles, buildBackup, TELEGRAM_MAX_BYTES } from "./export.js";
import { backupSummary, type WeeklyUsage } from "./summary.js";

export class BackupTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super("Backup too large for Telegram.");
    this.name = "BackupTooLargeError";
  }
}

export interface SendBackupArgs {
  db: Db;
  now: Date;
  send: (m: Message) => Promise<void>;
  sendFile: SendFile;
  weekly: WeeklyUsage | null;
  /** Test seam: the size limit. */
  maxBytes?: number;
}

/** Summary text, then the JSON, then the CSV zip. Nothing is sent when a file is too big. */
export async function sendBackup(args: SendBackupArgs): Promise<void> {
  const built = await buildBackup(args.db, args.now);
  const files = backupFiles(built, args.now, { allowGzip: true });
  const max = args.maxBytes ?? TELEGRAM_MAX_BYTES;
  const biggest = Math.max(files.json.data.length, files.zip.data.length);
  if (biggest > max) throw new BackupTooLargeError(biggest);
  await args.send({ text: backupSummary(built.meta, args.now, args.weekly), keyboard: [] });
  await args.sendFile({ kind: "document", name: files.json.name, data: files.json.data });
  await args.sendFile({ kind: "document", name: files.zip.name, data: files.zip.data });
}
