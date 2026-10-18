import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { ParsedItem } from "../plan-import/types.js";
import type { HistoryIssue, HistoryOverrides } from "./types.js";

export const RECORD_SLUG = /^w\d{2}-(mon|tue|wed|thu|fri)-\d{2}$/;

export const hashExport = (raw: string): string => createHash("sha256").update(raw).digest("hex");

const RecordOverrideSchema = z
  .object({
    chosen_option: z.string().min(1).optional(),
    sets: z.array(z.number().int().min(0)).min(1).optional(),
    load_kg_total: z.number().min(0).optional(),
    comment: z.string().optional(),
  })
  .strict();

const BodyweightSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    kg: z.number().positive(),
  })
  .strict();

const TopSchema = z
  .object({
    export_hash: z.string(),
    bodyweight: z.unknown(),
    records: z.record(z.string(), z.unknown()),
  })
  .strict();

export interface ValidatedOverrides {
  export_hash: string | null;
  bodyweight: { date: string; kg: number } | null;
  records: HistoryOverrides["records"];
  issues: HistoryIssue[];
}

/** Strict validation: every mistake becomes an open issue instead of throwing. */
export function validateOverrides(
  raw: unknown,
  itemsByKey: Map<string, ParsedItem>,
): ValidatedOverrides {
  const issues: HistoryIssue[] = [];
  const out: ValidatedOverrides = { export_hash: null, bodyweight: null, records: {}, issues };
  const top = TopSchema.safeParse(raw);
  if (!top.success) {
    issues.push({
      code: "overrides_invalid",
      ref: "overrides",
      detail: `Overrides file has the wrong shape: ${top.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
    });
    return out;
  }
  out.export_hash = top.data.export_hash;
  const bw = BodyweightSchema.safeParse(top.data.bodyweight);
  if (bw.success) out.bodyweight = bw.data;
  else if (top.data.bodyweight === null || top.data.bodyweight === undefined)
    issues.push({
      code: "bodyweight_missing",
      ref: "overrides",
      detail: "Set your bodyweight at setup in the overrides file.",
      snippet: '"bodyweight": { "date": "YYYY-MM-DD", "kg": 0 }',
    });
  else
    issues.push({
      code: "bodyweight_invalid",
      ref: "overrides",
      detail: 'bodyweight must be {"date": "YYYY-MM-DD", "kg": number}.',
    });

  for (const [slug, value] of Object.entries(top.data.records)) {
    if (!RECORD_SLUG.test(slug)) {
      issues.push({
        code: "override_bad_slug",
        ref: slug,
        detail: `"${slug}" is not a valid record key. Use the form w01-tue-05 (week, day, item number).`,
      });
      continue;
    }
    const item = itemsByKey.get(`${slug}-0`);
    if (!item) {
      issues.push({
        code: "override_unknown_record",
        ref: slug,
        detail: `"${slug}" does not match any item of the plan.`,
      });
      continue;
    }
    const parsed = RecordOverrideSchema.safeParse(value);
    if (!parsed.success) {
      issues.push({
        code: "override_invalid",
        ref: slug,
        detail: `Invalid override: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(record)"}: ${i.message}`).join("; ")}`,
      });
      continue;
    }
    if (
      parsed.data.chosen_option !== undefined &&
      !item.exercise_options.includes(parsed.data.chosen_option)
    ) {
      issues.push({
        code: "override_bad_option",
        ref: slug,
        detail: `chosen_option "${parsed.data.chosen_option}" is not one of: ${item.exercise_options.join(", ")}.`,
      });
      continue;
    }
    out.records[slug] = parsed.data;
  }
  return out;
}

export function defaultOverrides(exportHash: string): HistoryOverrides {
  return {
    export_hash: exportHash,
    bodyweight: null,
    records: {},
  };
}

/** Creates the overrides file when missing. Never overwrites. Returns true if created. */
export function ensureOverridesFile(path: string, exportHash: string): boolean {
  if (existsSync(path)) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(defaultOverrides(exportHash), null, 2)}\n`, {
    flag: "wx",
  });
  return true;
}
