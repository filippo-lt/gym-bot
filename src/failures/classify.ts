import Anthropic from "@anthropic-ai/sdk";
import { DrizzleQueryError } from "drizzle-orm";
import { AiTimeoutError } from "../ai/errors.js";
import { SttError } from "../stt/stt.js";
import { FileTooLargeError } from "../telegram/files.js";

export type FailureStep = "ai" | "vision" | "stt" | "download" | "other";
export type FailureKind =
  | "ai_timeout"
  | "ai_overloaded"
  | "ai_rate_limited"
  | "ai_auth"
  | "ai_refused"
  | "ai_network"
  | "stt_timeout"
  | "stt_rate_limited"
  | "stt_auth"
  | "stt_down"
  | "stt_failed"
  | "download_failed"
  | "file_too_large"
  | "db"
  | "row_timeout"
  | "unknown";

/** `detail` holds error name / code / status only, never message text. */
export interface Failure {
  kind: FailureKind;
  detail: string;
}

const MAX_HOPS = 5;
const DETAIL_MAX = 120;
const DB_CODES = new Set([
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
]);
// Generic Node socket codes: they also come from fetch/Anthropic/Telegram, so they only
// count as db when the chain shows the error came through Drizzle or postgres-js.
const SOCKET_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND"]);

const OVERLOADED = new Set([529, 500, 502, 503, 504]);

function prop(e: unknown, key: string): unknown {
  return typeof e === "object" && e !== null ? (e as Record<string, unknown>)[key] : undefined;
}

function detailOf(e: unknown): string {
  const parts: string[] = [];
  const name = prop(e, "name");
  const status = prop(e, "status");
  const code = prop(e, "code");
  if (typeof name === "string") parts.push(name);
  if (typeof status === "number") parts.push(`status ${status}`);
  if (typeof code === "string" || typeof code === "number") parts.push(`code ${code}`);
  return parts.join(" ").slice(0, DETAIL_MAX);
}

function sttKind(e: unknown): FailureKind | null {
  if (e instanceof SttError) {
    if (e.status === 429) return "stt_rate_limited";
    if (e.status === 401 || e.status === 403) return "stt_auth";
    if (e.status >= 500) return "stt_down";
    return "stt_failed";
  }
  const name = prop(e, "name");
  return name === "TimeoutError" || name === "AbortError" ? "stt_timeout" : null;
}

function aiKind(e: unknown, step: FailureStep): FailureKind | null {
  // Caller-signal aborts (e.g. AbortSignal.timeout on the photo path) surface as
  // APIUserAbortError or a TimeoutError/AbortError DOMException. A bare name is only an AI
  // timeout on the AI steps: elsewhere (e.g. a deadline-clamped DB call) it proves nothing.
  const name = prop(e, "name");
  const nameOnly = name === "TimeoutError" || name === "AbortError";
  if (
    e instanceof AiTimeoutError ||
    e instanceof Anthropic.APIConnectionTimeoutError ||
    e instanceof Anthropic.APIUserAbortError ||
    (nameOnly && (step === "ai" || step === "vision"))
  ) {
    return "ai_timeout";
  }
  if (e instanceof Anthropic.APIConnectionError) return "ai_network";
  if (e instanceof Anthropic.APIError) {
    const s = e.status;
    if (typeof s === "number") {
      if (OVERLOADED.has(s)) return "ai_overloaded";
      if (s === 429) return "ai_rate_limited";
      if (s === 401 || s === 403) return "ai_auth";
      if (s === 400) return "ai_refused";
    }
  }
  return null;
}

function dbKind(e: unknown, viaDb: boolean): FailureKind | null {
  const code = prop(e, "code");
  if (prop(e, "name") === "PostgresError") return "db";
  if (typeof code !== "string") return null;
  return DB_CODES.has(code) || (viaDb && SOCKET_CODES.has(code)) ? "db" : null;
}

/** True when the cause chain contains a DrizzleQueryError or a PostgresError. */
function chainViaDb(start: unknown): boolean {
  let current = start;
  for (let hop = 0; hop <= MAX_HOPS && current !== undefined && current !== null; hop++) {
    if (current instanceof DrizzleQueryError || prop(current, "name") === "PostgresError") {
      return true;
    }
    current = prop(current, "cause");
  }
  return false;
}

function kindOf(e: unknown, step: FailureStep, viaDb: boolean): FailureKind | null {
  if (e instanceof FileTooLargeError) return "file_too_large";
  if (step === "download") return null;
  if (step === "stt") return sttKind(e);
  return aiKind(e, step) ?? dbKind(e, viaDb);
}

function hasOwnStatusOrCode(e: unknown): boolean {
  return prop(e, "status") !== undefined || prop(e, "code") !== undefined;
}

/** Pure: maps any thrown value to a kind plus a safe detail (no message text). */
export function classify(error: unknown, step: FailureStep = "other"): Failure {
  let current: unknown = error;
  // grammY wraps handler errors; the original is `.error`.
  if (prop(current, "name") === "BotError" && prop(current, "error") !== undefined) {
    current = prop(current, "error");
  }
  let last: unknown = current;
  const viaDb = chainViaDb(current);
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const kind = kindOf(current, step, viaDb);
    if (kind) return { kind, detail: detailOf(current) };
    const cause = prop(current, "cause");
    const follow = current instanceof DrizzleQueryError || !hasOwnStatusOrCode(current);
    if (cause === undefined || cause === null || !follow) break;
    current = cause;
    last = cause;
  }
  // Detail comes from the deepest unwrapped error, not the BotError/Drizzle wrapper.
  const detail = detailOf(last);
  if (step === "download") return { kind: "download_failed", detail };
  if (step === "stt") return { kind: "stt_failed", detail };
  return { kind: "unknown", detail };
}

export function describeFailure(f: Failure): string {
  return `${f.kind} (${f.detail})`;
}
