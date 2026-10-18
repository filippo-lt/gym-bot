import { randomUUID } from "node:crypto";
import type { Db } from "../db/client.js";
import { classify, describeFailure, type Failure } from "../failures/classify.js";
import { runWithDeadline } from "./deadline.js";
import { claim, markDone, markRetryOrFailed, oldestOpen, resetStuck } from "./inbox.js";
import { acquireOrRenew, release } from "./lease.js";
import { hardEndMs, inputKind, MIN_TIME_LEFT_MS } from "./row-budget.js";

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
  notifyFailed: (chatId: number, payload: unknown, failure: Failure) => Promise<void>;
  /** Sent on the first failure of a row that will be retried. */
  notifyRetrying: (chatId: number, failure: Failure) => Promise<void>;
  /** Epoch ms; no new row is claimed after this. */
  deadline: number;
  /** Epoch ms the invocation started (default: when processChat starts). */
  startedAt?: number;
  now?: () => number;
  owner?: string;
};

const MAX_ROUNDS = 3;

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
async function runRound(
  deps: ProcessChatDeps,
  owner: string,
  summary: ProcessSummary,
  invocation: { startedAt: number; handlerRuns: number },
) {
  const { db, chatId } = deps;
  const now = deps.now ?? Date.now;
  const { startedAt } = invocation;

  if (!(await acquireOrRenew(db, chatId, owner))) {
    summary.stoppedReason = "lease_held";
    return;
  }
  try {
    for (const stuck of await resetStuck(db, chatId)) {
      if (stuck.status !== "failed") continue;
      summary.failed += 1;
      console.error(`inbox ${stuck.id}: failed (timed out)`);
      await ignoreErrors(() =>
        deps.notifyFailed(chatId, stuck.payload, { kind: "row_timeout", detail: "lease expired" }),
      );
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
      // The first row of an invocation always runs (its timeouts are clamped); later rows
      // that cannot fit wait for the next invocation, attempts untouched.
      if (
        invocation.handlerRuns > 0 &&
        hardEndMs(startedAt) - now() < MIN_TIME_LEFT_MS[inputKind(row.payload)]
      ) {
        summary.stoppedReason = "deadline";
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
        invocation.handlerRuns += 1;
        await runWithDeadline(hardEndMs(startedAt), () => deps.handle(claimed.payload));
      } catch (error) {
        const failure = classify(error, "other");
        const status = await markRetryOrFailed(db, claimed.id, owner, describeFailure(failure));
        if (status === null) {
          // The sweep already resolved this row (and notified, if it failed): nothing to add.
          console.error(`inbox ${claimed.id}: handler failed after the claim was lost`);
          continue;
        }
        console.error(`inbox ${claimed.id}: ${status} (attempt ${claimed.attempts})`);
        if (status === "failed") {
          summary.failed += 1;
          await ignoreErrors(() => deps.notifyFailed(chatId, claimed.payload, failure));
        } else {
          if (claimed.attempts === 1)
            await ignoreErrors(() => deps.notifyRetrying(chatId, failure));
          // Do not burn every attempt in one invocation: retry on the next webhook or tick.
          summary.stoppedReason = "retry_later";
          return;
        }
        continue;
      }

      // Window: if markDone fails the handler runs again on retry; domain writes go through write_ledger.
      try {
        if (await markDone(db, claimed.id, owner)) {
          summary.processed += 1;
          console.log(`inbox ${claimed.id}: done (attempt ${claimed.attempts})`);
        } else {
          console.error(`inbox ${claimed.id}: handled after the claim was lost`);
        }
      } catch (error) {
        console.error(
          `inbox ${claimed.id}: handled but not marked done (${describeFailure(classify(error, "other"))})`,
        );
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
  const invocation = { startedAt: deps.startedAt ?? now(), handlerRuns: 0 };
  const summary: ProcessSummary = {
    chatId: deps.chatId,
    processed: 0,
    failed: 0,
    stoppedReason: "empty",
  };

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    await runRound(deps, owner, summary, invocation);
    // A row may have arrived while we were releasing: look once more.
    if (["lease_held", "busy", "retry_later"].includes(summary.stoppedReason)) break;
    if (now() >= deps.deadline) break;
    if (!(await oldestOpen(deps.db, deps.chatId))) break;
  }
  return summary;
}
