import { z } from "zod";

const str = z
  .union([z.string(), z.number()])
  .optional()
  .transform((v) => (v === undefined ? "" : String(v)));

export const RecordSchema = z.object({
  status: z.enum(["planned", "done", "modified", "skipped"]).default("planned"),
  actual: str,
  load: str,
  rir: str,
  notes: str,
});

export const WeekSchema = z.object({
  progress: z.record(z.string(), str).optional(),
  exposure: z
    .object({
      pull: z.boolean().optional(),
      push: z.boolean().optional(),
      legs: z.boolean().optional(),
    })
    .optional(),
  days: z.record(z.string(), z.record(z.string(), RecordSchema)).optional(),
});

/** The old tracker's localStorage state. `ui` is ignored. */
export const ExportSchema = z.object({
  weeks: z.record(z.string(), WeekSchema),
  ui: z.unknown().optional(),
});

export type HistoryExport = z.infer<typeof ExportSchema>;
export type ExportRecord = z.infer<typeof RecordSchema>;
