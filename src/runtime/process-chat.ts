import { randomUUID } from "node:crypto";
import type { Db } from "../db/client.js";
import { claim, markDone, markRetryOrFailed, oldestOpen, resetStuck } from "./inbox.js";
import { acquireOrRenew, release } from "./lease.js";

export type StoppedReason =
  | "lease_held"
  | "busy"
  | "lease_lost"
  | "deadline"
  | "empty"
  | "retry_later";

export type ProcessSummary = {
  chatId: number;
  processed: number;
  failed: number;
  stoppedReason: StoppedReason;
};

export type ProcessChatDeps = {
  db: Db;
  chatId: number;
  handle: (payload: unknown) => Promise<void>;
  sendTyping: (chatId: number) => Promise<void>;
  notifyFailed: (chatId: number, payload: unknown) => Promise<void>;
  /** Epoch ms; no new row is claimed after this. */
  deadline: number;
  now?: () => number;
  owner?: string;
};

const MAX_ROUNDS = 3;

/** Name and code only: driver errors can carry SQL params, i.e. message text. */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return "unknown error";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? `${error.name} (${code})` : error.name;
}

async function ignoreErrors(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch {
    // best effort only
  }
}

/*
 * A "busy" or "lease_held" exit can leave a message waiting until the next webhook or cron tick
 * (at most 15 min). That is accepted by SPEC §3.
 */
async function runRound(deps: ProcessChatDeps, owner: string, summary: ProcessSummary) {
  const { db, chatId } = deps;
  const now = deps.now ?? Date.now;

  if (!(await acquireOrRenew(db, chatId, owner))) {
    summary.stoppedReason = "lease_held";
    return;
  }
  try {
    for (const stuck of await resetStuck(db, chatId)) {
      if (stuck.status !== "failed") continue;
      summary.failed += 1;
      console.error(`inbox ${stuck.id}: failed (timed out)`);
      await ignoreErrors(() => deps.notifyFailed(chatId, stuck.payload));
    }
    let claimMisses = 0;
    while (now() < deps.deadline) {
      if (!(await acquireOrRenew(db, chatId, owner))) {
        summary.stoppedReason = "lease_lost";
        return;
      }
      const row = await oldestOpen(db, chatId);
      if (!row) {
        summary.stoppedReason = "empty";
        return;
      }
      if (row.status === "processing") {
        summary.stoppedReason = "busy";
        return;
      }
      const claimed = await claim(db, row.id, owner);
      if (!claimed) {
        claimMisses += 1;
        if (claimMisses >= 5) {
          summary.stoppedReason = "busy";
          return;
        }
        continue;
      }

      await ignoreErrors(() => deps.sendTyping(chatId));
      try {
        await deps.handle(claimed.payload);
      } catch (error) {
        const status = await markRetryOrFailed(db, claimed.id, describeError(error));
        console.error(`inbox ${claimed.id}: ${status} (attempt ${claimed.attempts})`);
        if (status === "failed") {
          summary.failed += 1;
          await ignoreErrors(() => deps.notifyFailed(chatId, claimed.payload));
        } else {
          // Do not burn every attempt in one invocation: retry on the next webhook or tick.
          summary.stoppedReason = "retry_later";
          return;
        }
        continue;
      }

      // Window: if markDone fails the handler runs again on retry.
      // TODO(M3): make domain writes idempotent through write_ledger (SPEC §3).
      try {
        await markDone(db, claimed.id);
        summary.processed += 1;
        console.log(`inbox ${claimed.id}: done (attempt ${claimed.attempts})`);
      } catch (error) {
        console.error(`inbox ${claimed.id}: handled but not marked done (${describeError(error)})`);
        summary.stoppedReason = "retry_later";
        return;
      }
    }
    summary.stoppedReason = "deadline";
  } finally {
    await release(db, owner);
  }
}

export async function processChat(deps: ProcessChatDeps): Promise<ProcessSummary> {
  const owner = deps.owner ?? randomUUID();
  const now = deps.now ?? Date.now;
  const summary: ProcessSummary = {
    chatId: deps.chatId,
    processed: 0,
    failed: 0,
    stoppedReason: "empty",
  };

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    await runRound(deps, owner, summary);
    // A row may have arrived while we were releasing: look once more.
    if (["lease_held", "busy", "retry_later"].includes(summary.stoppedReason)) break;
    if (now() >= deps.deadline) break;
    if (!(await oldestOpen(deps.db, deps.chatId))) break;
  }
  return summary;
}
