import { DateTime } from "luxon";

export interface UsageView {
  /** Rome date, yyyy-mm-dd. */
  date: string;
  dayTokens: number;
  monthTokens: number;
  sttSecondsToday: number;
  /** A missing cap (feature not configured) drops the "of ..." part. */
  caps: { day: number | null; month: number | null; sttSeconds: number | null };
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

function tokenLine(label: string, used: number, cap: number | null): string {
  if (cap === null) return `${label}: ${fmt(used)} tokens`;
  const pct = cap > 0 ? Math.floor((Math.round(used) * 100) / cap) : 0;
  return `${label}: ${fmt(used)} of ${fmt(cap)} tokens (${pct}%)`;
}

export function formatUsage(u: UsageView): string {
  const date = DateTime.fromISO(u.date).setLocale("en").toFormat("d LLL");
  const usedMin = Math.round(u.sttSecondsToday / 60);
  const voice =
    u.caps.sttSeconds === null
      ? `Voice today: ${usedMin} min`
      : `Voice today: ${usedMin} of ${Math.round(u.caps.sttSeconds / 60)} min`;
  return [
    `Usage on ${date}:`,
    tokenLine("AI today", u.dayTokens, u.caps.day),
    tokenLine("AI this month", u.monthTokens, u.caps.month),
    voice,
  ].join("\n");
}
