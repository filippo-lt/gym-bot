/**
 * "Move the next deload earlier" (M7): the proposal row, its preview and its apply step.
 * The preview runs the same `insertDeload` the ✅ will run, so the card text matches the result.
 */
import { and, desc, eq, gt, ne, sql } from "drizzle-orm";
import { writeLedger } from "../db/schema/agent.js";
import { weeklyMetrics } from "../db/schema/log.js";
import { plans } from "../db/schema/plan.js";
import { proposals, readinessLogs } from "../db/schema/progression.js";
import type { Q } from "../logging/db.js";
import { addDays } from "../plan-import/build-plan.js";
import { RECOVERY_METRIC } from "../progression/load-history.js";
import { type DeloadTrigger, RECOVERY_LOW_MAX } from "../progression/readiness.js";
import { refreshUserState } from "../progression/store.js";
import { insertDeload } from "./deload.js";
import { loadVersionIndex } from "./effective.js";
import type { PlanChangeResult } from "./swap-execute.js";
import type { PlanContent, WeekSpec } from "./types.js";
import { createVersion, loadLatestContent } from "./versions.js";

export const CLOSED = "This offer is closed; nothing changed.";

export interface DeloadPreview {
  /** The new deload week. */
  insertedWeek: number;
  mondayDate: string;
  sundayDate: string;
  /** Old weeks shiftedFrom..shiftedTo move one week later. */
  shiftedFrom: number;
  shiftedTo: number;
  /** Old number of the deload that is removed (it would fall less than 3 weeks after). */
  droppedWeek: number | null;
  /** New number of the next deload after the inserted one when it is kept. */
  keptDeloadWeek: number | null;
  newWeeks: number;
  endDate: string;
}

export interface DeloadPayload {
  currentWeek: number;
  insertAt: number;
  mondayDate: string;
  versionId: number;
  trigger: DeloadTrigger;
}

/** Null when week `insertAt` cannot take a deload (deload, test, last week, outside the plan). */
export function deloadPreview(content: PlanContent, insertAt: number): DeloadPreview | null {
  const weeks = [...content.weeks].sort((a, b) => a.week - b.week);
  const at = weeks.find((w) => w.week === insertAt);
  const last = weeks.at(-1);
  if (!at || !last || at.isDeload || at.isTest || insertAt <= 1 || insertAt >= last.week) {
    return null;
  }
  const out = insertDeload(content, insertAt);
  const newLast = out.content.weeks.at(-1) as WeekSpec;
  const inserted = out.content.weeks[insertAt - 1] as WeekSpec;
  return {
    insertedWeek: insertAt,
    mondayDate: inserted.startDate,
    sundayDate: addDays(inserted.startDate, 6),
    shiftedFrom: insertAt,
    shiftedTo: last.week,
    droppedWeek: out.droppedWeek,
    keptDeloadWeek:
      out.content.weeks.find((w) => w.week > insertAt && w.isDeload && !w.isTest)?.week ?? null,
    newWeeks: out.content.weeks.length,
    endDate: addDays(newLast.startDate, 6),
  };
}

type ProposalRow = typeof proposals.$inferSelect;

/**
 * The trigger was off after `p` was created: a frozen session level that is not RED, or a weekly
 * recovery score above the low threshold for the proposal's week or later (weekly rows carry no timestamp).
 */
async function triggerResetSince(q: Q, p: ProposalRow): Promise<boolean> {
  const [lvl] = await q
    .select({ id: readinessLogs.id })
    .from(readinessLogs)
    .where(
      and(
        eq(readinessLogs.source, "derived"),
        ne(readinessLogs.level, "RED"),
        gt(readinessLogs.createdAt, p.createdAt),
      ),
    )
    .limit(1);
  if (lvl) return true;
  const week = (p.payload as DeloadPayload).currentWeek;
  const [rec] = await q
    .select({ id: weeklyMetrics.id })
    .from(weeklyMetrics)
    .where(
      and(
        eq(weeklyMetrics.metric, RECOVERY_METRIC),
        gt(weeklyMetrics.valueNum, RECOVERY_LOW_MAX),
        sql`${weeklyMetrics.planWeek} >= ${week}`,
      ),
    )
    .limit(1);
  return !!rec;
}

/**
 * Creates (or returns the open) proposal when the trigger fires (`trigger` non-null) and next week can take a deload. Asked once
 * until the trigger resets. Open proposals whose Monday arrived are expired first.
 */
export async function ensureDeloadProposal(
  db: Q,
  today: string,
  trigger: DeloadTrigger | null,
): Promise<{
  id: number;
  preview: DeloadPreview;
  messageId: number | null;
  trigger: DeloadTrigger;
} | null> {
  const stale = await db
    .select()
    .from(proposals)
    .where(and(eq(proposals.kind, "earlier_deload"), eq(proposals.status, "open")));
  for (const p of stale) {
    if ((p.payload as DeloadPayload).mondayDate <= today) {
      await db.update(proposals).set({ status: "expired" }).where(eq(proposals.id, p.id));
    }
  }
  if (!trigger) return null;

  const index = await loadVersionIndex(db);
  const week = index.weekOf(today);
  if (!week) return null;
  const [plan] = await db.select({ id: plans.id }).from(plans).orderBy(desc(plans.id)).limit(1);
  if (!plan) return null;
  const latest = await loadLatestContent(db, plan.id);
  const insertAt = week.week + 1;
  const preview = deloadPreview(latest.content, insertAt);
  if (!preview || preview.mondayDate <= today) return null;

  const [last] = await db
    .select()
    .from(proposals)
    .where(eq(proposals.kind, "earlier_deload"))
    .orderBy(desc(proposals.id))
    .limit(1);
  if (last && !(await triggerResetSince(db, last))) {
    if (last.status !== "open") return null;
    const p = last.payload as DeloadPayload;
    const open = deloadPreview(latest.content, p.insertAt);
    return open
      ? { id: last.id, preview: open, messageId: last.messageId, trigger: p.trigger }
      : null;
  }

  // At most one live card: an older open offer is replaced by the new one.
  await db
    .update(proposals)
    .set({ status: "expired" })
    .where(and(eq(proposals.kind, "earlier_deload"), eq(proposals.status, "open")));
  const payload: DeloadPayload = {
    currentWeek: week.week,
    insertAt,
    mondayDate: preview.mondayDate,
    versionId: latest.versionId,
    trigger,
  };
  const [row] = await db
    .insert(proposals)
    .values({ kind: "earlier_deload", payload })
    .returning({ id: proposals.id });
  if (!row) throw new Error("Failed to create the deload proposal");
  return { id: row.id, preview, messageId: null, trigger };
}

export type DeloadApplyResult =
  | {
      ok: true;
      versionId: number;
      insertedWeek: number;
      droppedWeek: number | null;
      mondayDate: string;
    }
  | { ok: false; reason: "decided" | "closed"; reply: string };

/**
 * ✅: runs inside the caller's transaction. Every refusal that closes the offer marks it expired. A lost
 * version race throws StaleBaseVersionError (the caller rolls back, then calls expireDeloadProposal).
 */
export async function applyDeloadProposal(
  tx: Q,
  proposalId: number,
  today: string,
  now: Date = new Date(),
): Promise<DeloadApplyResult> {
  const [row] = await tx
    .select()
    .from(proposals)
    .where(and(eq(proposals.id, proposalId), eq(proposals.kind, "earlier_deload")))
    .for("update");
  if (row?.status === "expired") return { ok: false, reason: "closed", reply: CLOSED };
  if (row?.status !== "open") return { ok: false, reason: "decided", reply: "Already decided." };
  const p = row.payload as DeloadPayload;
  const close = async (status: "expired") => {
    await tx.update(proposals).set({ status, decidedAt: now }).where(eq(proposals.id, row.id));
  };

  if (p.mondayDate <= today) {
    await close("expired");
    return { ok: false, reason: "closed", reply: CLOSED };
  }
  const [plan] = await tx.select({ id: plans.id }).from(plans).orderBy(desc(plans.id)).limit(1);
  if (!plan) {
    await close("expired");
    return { ok: false, reason: "closed", reply: CLOSED };
  }
  const latest = await loadLatestContent(tx, plan.id);
  if (latest.versionId !== p.versionId) {
    await close("expired");
    return { ok: false, reason: "closed", reply: CLOSED };
  }
  const preview = deloadPreview(latest.content, p.insertAt);
  if (!preview || preview.mondayDate !== p.mondayDate) {
    await close("expired");
    return { ok: false, reason: "closed", reply: CLOSED };
  }

  const out = insertDeload(latest.content, p.insertAt);
  const created = await createVersion(tx, {
    planId: plan.id,
    baseVersionId: latest.versionId,
    content: out.content,
    effectiveFrom: p.mondayDate,
    reason: `Deload moved earlier to W${preview.insertedWeek}`,
    change: {
      kind: "deload_earlier",
      insertedWeek: preview.insertedWeek,
      droppedWeek: out.droppedWeek,
    },
  });
  await tx
    .update(proposals)
    .set({ status: "accepted", decidedAt: now })
    .where(eq(proposals.id, row.id));
  const result: PlanChangeResult = {
    kind: "plan_change",
    overrideIds: [],
    versionId: created.versionId,
    createdExerciseId: null,
  };
  await tx
    .insert(writeLedger)
    .values({ sourceKey: `r:${row.id}`, actionIndex: 0, result })
    .onConflictDoNothing();
  await refreshUserState(tx);
  return {
    ok: true,
    versionId: created.versionId,
    insertedWeek: preview.insertedWeek,
    droppedWeek: out.droppedWeek,
    mondayDate: p.mondayDate,
  };
}

/** Marks a proposal expired (used after a rolled-back apply, outside the failed transaction). */
export async function expireDeloadProposal(db: Q, proposalId: number, now: Date): Promise<void> {
  await db
    .update(proposals)
    .set({ status: "expired", decidedAt: now })
    .where(and(eq(proposals.id, proposalId), eq(proposals.status, "open")));
}
