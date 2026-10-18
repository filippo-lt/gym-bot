import { MAX_DURATION_S } from "./constants.js";

export type InputKind = "voice" | "photo" | "text" | "other";

function prop(o: unknown, key: string): unknown {
  return typeof o === "object" && o !== null ? (o as Record<string, unknown>)[key] : undefined;
}

export function inputKind(payload: unknown): InputKind {
  const message = prop(payload, "message");
  if (prop(message, "voice")) return "voice";
  if (prop(message, "photo")) return "photo";
  const text = prop(message, "text");
  if (typeof text === "string" && !text.startsWith("/")) return "text";
  return "other";
}

/** Minimum time left in the invocation for a row to be worth starting. */
export const MIN_TIME_LEFT_MS: Record<InputKind, number> = {
  voice: 75_000,
  photo: 60_000,
  text: 45_000,
  other: 45_000,
};

/** An invocation younger than this still runs its first row whatever the time left. */
export const FIRST_ROW_GRACE_MS = 15_000;

/** The invocation's hard end for row work: 5 s before the function is killed. */
export function hardEndMs(startedAt: number): number {
  return startedAt + (MAX_DURATION_S - 5) * 1000;
}
