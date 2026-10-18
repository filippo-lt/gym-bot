import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import type { HistoryImport, HistoryIssue } from "../history-import/types.js";
import type { Equipment } from "../plan-import/types.js";
import * as schema from "./schema/index.js";
import type { Db } from "./seed-plan.js";

export class HistoryOpenIssuesError extends Error {
  constructor(readonly issues: HistoryIssue[]) {
    super(
      `Refusing to import: ${issues.length} open issue(s):\n${issues
        .map((i) => `  - ${i.ref}: ${i.detail}`)
        .join("\n")}`,
    );
    this.name = "HistoryOpenIssuesError";
  }
}

export interface HistoryImportSummary {
  deleted: {
    session_items: number;
    log_groups: number;
    class_logs: number;
    weekly_metrics: number;
    bodyweight_logs: number;
  };
  inserted: {
    session_items: number;
    log_groups: number;
    log_entries: number;
    class_logs: number;
    weekly_metrics: number;
    bodyweight_logs: number;
  };
  /** Rows skipped because a non-import row already holds the slot. */
  clashes: string[];
  dryRun: boolean;
}

class DryRunRollback extends Error {
  constructor(readonly summary: HistoryImportSummary) {
    super("dry run rollback");
  }
}

const CHUNK = 200;
function chunks<T>(rows: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += CHUNK) out.push(rows.slice(i, i + CHUNK));
  return out;
}

/**
 * Replaces every source = import row with the fresh ones, in one transaction.
 * Never touches non-import rows; on a unique clash with one, the other row wins.
 * Plan version 1 and current equipment must be seeded first (`pnpm plan:seed`).
 */
export async function importHistory(
  db: Db,
  result: HistoryImport,
  opts: { planName: string; equipment?: Equipment[]; dryRun?: boolean },
): Promise<HistoryImportSummary> {
  if (result.open_issues.length > 0) throw new HistoryOpenIssuesError(result.open_issues);

  try {
    return await db.transaction(async (tx) => {
      // Equipment is reference data owned by plan:seed; only check that it is current.
      const dbEquipment = new Map(
        (
          await tx
            .select({ slug: schema.equipment.slug, baseKg: schema.equipment.baseKg })
            .from(schema.equipment)
        ).map((r) => [r.slug, r.baseKg]),
      );
      for (const e of opts.equipment ?? []) {
        if (e.base_kg === null) continue;
        if (dbEquipment.get(e.slug) !== e.base_kg)
          throw new Error(
            `Equipment "${e.slug}" base_kg in the DB (${dbEquipment.get(e.slug) ?? "missing"}) differs from seed/equipment.json (${e.base_kg}). Run pnpm plan:seed first.`,
          );
      }

      const itemRows = await tx
        .select({ id: schema.plannedItems.id, key: schema.plannedItems.itemKey })
        .from(schema.plannedItems)
        .innerJoin(
          schema.planVersions,
          eq(schema.planVersions.id, schema.plannedItems.planVersionId),
        )
        .innerJoin(schema.plans, eq(schema.plans.id, schema.planVersions.planId))
        .where(and(eq(schema.planVersions.version, 1), eq(schema.plans.name, opts.planName)));
      if (itemRows.length === 0)
        throw new Error(
          `Plan "${opts.planName}" version 1 is not seeded. Run pnpm plan:seed first.`,
        );
      const itemIds = new Map(itemRows.map((r) => [r.key, r.id]));
      const exerciseIds = new Map(
        (
          await tx
            .select({ id: schema.exercises.id, slug: schema.exercises.slug })
            .from(schema.exercises)
        ).map((r) => [r.slug, r.id]),
      );
      const itemId = (key: string) => {
        const id = itemIds.get(key);
        if (id === undefined) throw new Error(`Planned item ${key} not found in plan version 1.`);
        return id;
      };
      const exerciseId = (slug: string) => {
        const id = exerciseIds.get(slug);
        if (id === undefined)
          throw new Error(`Exercise ${slug} not found. Run pnpm plan:seed first.`);
        return id;
      };

      const deleted = {
        session_items: (
          await tx
            .delete(schema.sessionItems)
            .where(eq(schema.sessionItems.source, "import"))
            .returning({ id: schema.sessionItems.id })
        ).length,
        log_groups: (
          await tx
            .delete(schema.logGroups)
            .where(eq(schema.logGroups.source, "import"))
            .returning({ id: schema.logGroups.id })
        ).length,
        class_logs: (
          await tx
            .delete(schema.classLogs)
            .where(eq(schema.classLogs.source, "import"))
            .returning({ id: schema.classLogs.id })
        ).length,
        weekly_metrics: (
          await tx
            .delete(schema.weeklyMetrics)
            .where(eq(schema.weeklyMetrics.source, "import"))
            .returning({ id: schema.weeklyMetrics.id })
        ).length,
        bodyweight_logs: (
          await tx
            .delete(schema.bodyweightLogs)
            .where(eq(schema.bodyweightLogs.source, "import"))
            .returning({ id: schema.bodyweightLogs.id })
        ).length,
      };

      const clashes: string[] = [];
      const inserted = {
        session_items: 0,
        log_groups: 0,
        log_entries: 0,
        class_logs: 0,
        weekly_metrics: 0,
        bodyweight_logs: 0,
      };

      // session_items: keep an existing bot row for the same (date, planned item).
      const wanted = result.session_items.map((s) => ({ ...s, plannedItemId: itemId(s.item_key) }));
      const existing = wanted.length
        ? await tx
            .select({ d: schema.sessionItems.sessionDate, p: schema.sessionItems.plannedItemId })
            .from(schema.sessionItems)
            .where(
              inArray(
                schema.sessionItems.plannedItemId,
                wanted.map((w) => w.plannedItemId),
              ),
            )
        : [];
      const taken = new Set(existing.map((e) => `${e.d}/${e.p}`));
      const sessionRows = wanted.filter((w) => {
        if (!taken.has(`${w.session_date}/${w.plannedItemId}`)) return true;
        clashes.push(`session_item ${w.import_row_key}: a bot row already exists, kept`);
        return false;
      });
      // A bot log on the slot wins over what the export says: the item stays done.
      const botGroups = wanted.length
        ? await tx
            .select({ d: schema.logGroups.sessionDate, p: schema.logGroups.plannedItemId })
            .from(schema.logGroups)
            .where(
              and(
                ne(schema.logGroups.source, "import"),
                inArray(
                  schema.logGroups.plannedItemId,
                  wanted.map((w) => w.plannedItemId),
                ),
              ),
            )
        : [];
      const botLogged = new Set(botGroups.map((e) => `${e.d}/${e.p}`));
      const statusFor = (s: (typeof sessionRows)[number]) => {
        if (s.status === "done" || !botLogged.has(`${s.session_date}/${s.plannedItemId}`)) {
          return s.status;
        }
        clashes.push(`session_item ${s.import_row_key}: a bot log exists, kept as done`);
        return "done" as const;
      };
      for (const batch of chunks(sessionRows)) {
        await tx.insert(schema.sessionItems).values(
          batch.map((s) => ({
            sessionDate: s.session_date,
            plannedItemId: s.plannedItemId,
            status: statusFor(s),
            chosenExerciseId: s.chosen_exercise_slug ? exerciseId(s.chosen_exercise_slug) : null,
            source: "import" as const,
            importRowKey: s.import_row_key,
          })),
        );
        inserted.session_items += batch.length;
      }

      // A bot-logged slot the export has no row for (its old import row was deleted above)
      // still needs its done row. It comes back as source = 'bot' even if the deleted row was an
      // import one: the SPEC "Transition" rule only promises that a re-import never deletes bot
      // data, and this row now exists only for a bot log. Keeping it 'bot' means a later re-import
      // leaves it alone instead of deleting and restoring it again; if the export ever gains the
      // row, the "a bot row already exists, kept" clash above applies. Undoing the bot log still
      // works (it restores the status recorded at log time on this row).
      const allBot = await tx
        .select({
          d: schema.logGroups.sessionDate,
          p: schema.logGroups.plannedItemId,
          e: schema.logGroups.exerciseId,
        })
        .from(schema.logGroups)
        .where(
          and(ne(schema.logGroups.source, "import"), isNotNull(schema.logGroups.plannedItemId)),
        )
        .orderBy(schema.logGroups.id);
      const slots = new Map<string, { d: string; p: number; e: number }>();
      for (const g of allBot) slots.set(`${g.d}/${g.p}`, { d: g.d, p: g.p as number, e: g.e });
      for (const slot of slots.values()) {
        const rows = await tx
          .insert(schema.sessionItems)
          .values({
            sessionDate: slot.d,
            plannedItemId: slot.p,
            status: "done",
            chosenExerciseId: slot.e,
            source: "bot",
          })
          .onConflictDoNothing()
          .returning({ id: schema.sessionItems.id });
        if (rows.length) clashes.push(`session_item ${slot.d}/${slot.p}: restored for a bot log`);
      }

      for (const g of result.log_groups) {
        const [row] = await tx
          .insert(schema.logGroups)
          .values({
            sessionDate: g.session_date,
            performedAt: new Date(g.performed_at),
            plannedItemId: itemId(g.item_key),
            subItem: g.sub_item,
            exerciseId: exerciseId(g.exercise_slug),
            bwKg: g.bw_kg,
            readinessLevel: g.readiness_level,
            source: "import",
            importRowKey: g.import_row_key,
            perSetUnknown: g.per_set_unknown,
          })
          .returning({ id: schema.logGroups.id });
        if (!row) throw new Error("Failed to insert log group");
        await tx.insert(schema.logEntries).values(
          g.entries.map((e) => ({
            groupId: row.id,
            setIndex: e.set_index,
            reps: e.reps,
            loadKg: e.load_kg,
            addedKg: e.added_kg,
            assistKg: e.assist_kg,
            durationS: e.duration_s,
            distanceM: e.distance_m,
            padHeight: e.pad_height,
            rir: e.rir,
            rirPlus: e.rir_plus,
            clean: e.clean,
            note: e.note,
          })),
        );
        inserted.log_groups += 1;
        inserted.log_entries += g.entries.length;
      }

      for (const c of result.class_logs) {
        const rows = await tx
          .insert(schema.classLogs)
          .values({ date: c.date, heavyGroups: c.heavy_groups, source: "import" })
          .onConflictDoNothing({ target: schema.classLogs.date })
          .returning({ id: schema.classLogs.id });
        if (rows.length) inserted.class_logs += 1;
        else clashes.push(`class_log ${c.date}: a non-import row already exists, kept`);
      }

      for (const m of result.weekly_metrics) {
        const rows = await tx
          .insert(schema.weeklyMetrics)
          .values({
            planWeek: m.plan_week,
            metric: m.metric,
            valueNum: m.value_num,
            valueText: m.value_text,
            unit: m.unit,
            source: "import",
            importRowKey: m.import_row_key,
          })
          .onConflictDoNothing({
            target: [schema.weeklyMetrics.planWeek, schema.weeklyMetrics.metric],
          })
          .returning({ id: schema.weeklyMetrics.id });
        if (rows.length) inserted.weekly_metrics += 1;
        else
          clashes.push(
            `weekly_metric w${m.plan_week}/${m.metric}: a non-import row already exists, kept`,
          );
      }

      if (result.bodyweight) {
        const rows = await tx
          .insert(schema.bodyweightLogs)
          .values({ date: result.bodyweight.date, kg: result.bodyweight.kg, source: "import" })
          .onConflictDoNothing({ target: schema.bodyweightLogs.date })
          .returning({ id: schema.bodyweightLogs.id });
        if (rows.length) inserted.bodyweight_logs += 1;
        else
          clashes.push(
            `bodyweight ${result.bodyweight.date}: a non-import row already exists, kept`,
          );
      }

      const summary: HistoryImportSummary = {
        deleted,
        inserted,
        clashes,
        dryRun: opts.dryRun === true,
      };
      if (opts.dryRun) throw new DryRunRollback(summary);
      return summary;
    });
  } catch (error) {
    if (error instanceof DryRunRollback) return error.summary;
    throw error;
  }
}
