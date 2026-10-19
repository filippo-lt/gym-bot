import { DateTime } from "luxon";
import { esc } from "../bot/format.js";
import { APP_TIMEZONE } from "../config/constants.js";
import type { BackupMeta } from "./export.js";

export interface WeeklyUsage {
  tokens: number;
  sttSeconds: number;
  caps: { tokens: number | null; sttSeconds: number | null };
}

const nf = new Intl.NumberFormat("en-US");

/** The text sent before the backup files (HTML-safe). */
export function backupSummary(meta: BackupMeta, now: Date, weekly: WeeklyUsage | null): string {
  const when = DateTime.fromJSDate(now, { zone: APP_TIMEZONE })
    .setLocale("en")
    .toFormat("d LLL yyyy, HH:mm");
  const entries = Object.entries(meta.manifest);
  const rows = [
    ...entries.filter(([, m]) => m.rows > 0),
    ...entries.filter(([, m]) => m.rows === 0),
  ]
    .map(([name, m]) => `${esc(name)} ${nf.format(m.rows)}`)
    .join(", ");
  const lines = [`Backup of ${when} (Rome).`, `Rows: ${rows}`];
  if (weekly) {
    const minutes = Math.round(weekly.sttSeconds / 60);
    lines.push(
      `This week: ${nf.format(Math.round(weekly.tokens))} AI tokens, ${nf.format(minutes)} min voice.`,
    );
    const caps: string[] = [];
    if (weekly.caps.tokens !== null) caps.push(`${nf.format(weekly.caps.tokens)} tokens`);
    if (weekly.caps.sttSeconds !== null) {
      caps.push(`${nf.format(Math.round(weekly.caps.sttSeconds / 60))} min voice`);
    }
    if (caps.length) lines.push(`Limits per day: ${caps.join(", ")}.`);
  }
  lines.push("Keep these files: they are your only restore point.");
  return lines.join("\n");
}
