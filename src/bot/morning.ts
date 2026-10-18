import { DateTime } from "luxon";
import type { Db } from "../db/client.js";
import { loadSessionAdvice, type SessionAdvice } from "../progression/session-advice.js";
import { cb } from "./callbacks.js";
import { formatSession } from "./format.js";
import { READINESS_EMOJI, READINESS_QUESTION } from "./inputs-flow.js";
import type { Message } from "./log-format.js";
import { getSession } from "./session.js";

export const MORNING_GREETING = "☀️ Good morning.";

/** Same fallback as `/today`: the engine failing never takes the plain session away. */
async function advise(db: Db, date: string, now: Date): Promise<SessionAdvice | null> {
  try {
    return await loadSessionAdvice(db, date, now, { short: false });
  } catch (error) {
    console.error(`progression: advice failed (${error instanceof Error ? error.name : "error"})`);
    return null;
  }
}

/** The exact `/today` text for `date` at `now`, plus what the morning job needs on a Friday. */
export async function renderTodayText(
  db: Db,
  date: string,
  now: Date,
): Promise<{ text: string; askClassFirst: boolean; thursday: string | null }> {
  const session = await getSession(db, date);
  const advice = session.kind === "session" ? await advise(db, date, now) : null;
  const askClassFirst = advice?.askClassFirst ?? false;
  const thursday = askClassFirst
    ? (DateTime.fromISO(date, { zone: "utc" }).minus({ days: 1 }).toISODate() as string)
    : null;
  return { text: formatSession(session, advice, { short: false }), askClassFirst, thursday };
}

/** Greeting + today; the readiness question with buttons, or, once answered, the chosen level and no buttons. */
export function morningMessage(
  todayText: string,
  date: string,
  readiness?: "t" | "o" | "s",
): Message {
  if (readiness) {
    return {
      text: `${MORNING_GREETING}\nReadiness: ${READINESS_EMOJI[readiness]}\n\n${todayText}`,
      keyboard: [],
    };
  }
  return {
    text: `${MORNING_GREETING}\n\n${todayText}\n\n${READINESS_QUESTION}`,
    keyboard: [
      (["t", "o", "s"] as const).map((l) => ({
        text: READINESS_EMOJI[l],
        data: cb.readinessMorning(l, date),
      })),
    ],
  };
}
