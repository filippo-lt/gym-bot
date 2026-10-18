import { gunzipSync } from "node:zlib";
import { sql } from "drizzle-orm";
import type { Db } from "../db/seed-plan.js";
import { refreshUserState } from "../progression/store.js";
import { EXCLUDED_TABLES, readCatalog, readMigrations, restoreOrder } from "./catalog.js";
import type { BackupMeta } from "./export.js";

export type RestoreRefusal =
  | "not_backup"
  | "manifest_mismatch"
  | "target_not_empty"
  | "schema_mismatch"
  | "remote_not_allowed";

export class RestoreRefusedError extends Error {
  constructor(
    readonly reason: RestoreRefusal,
    message: string,
  ) {
    super(message);
    this.name = "RestoreRefusedError";
  }
}

export interface BackupInput {
  meta: BackupMeta;
  tables: Record<string, unknown[]>;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Reads and checks a backup file (gunzips `*.gz`). Row counts are checked here, hashes in Postgres. */
export function parseBackupFile(bytes: Uint8Array, fileName: string): BackupInput {
  let text: string;
  try {
    const raw = fileName.endsWith(".gz") ? gunzipSync(bytes) : bytes;
    text = new TextDecoder().decode(raw);
  } catch {
    throw new RestoreRefusedError("not_backup", "The file is not valid gzip.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RestoreRefusedError("not_backup", "The file is not valid JSON.");
  }
  if (!isObject(parsed) || parsed.format !== "gymbot-backup")
    throw new RestoreRefusedError("not_backup", "The file is not a GymBot backup.");
  if (parsed.version !== 1)
    throw new RestoreRefusedError("not_backup", `Unsupported backup version: ${parsed.version}.`);
  const { tables, manifest, migrations, created_at: createdAt } = parsed;
  if (
    !isObject(tables) ||
    !isObject(manifest) ||
    !Array.isArray(migrations) ||
    typeof createdAt !== "string" ||
    Number.isNaN(Date.parse(createdAt))
  )
    throw new RestoreRefusedError("not_backup", "The backup header is incomplete.");
  for (const [name, rows] of Object.entries(tables)) {
    const entry = manifest[name];
    if (!Array.isArray(rows) || !isObject(entry))
      throw new RestoreRefusedError("not_backup", `Table ${name} has no manifest entry.`);
    if (rows.length !== entry.rows)
      throw new RestoreRefusedError(
        "manifest_mismatch",
        `Table ${name} has ${rows.length} rows, the manifest says ${entry.rows}.`,
      );
  }
  for (const name of Object.keys(manifest))
    if (!(name in tables))
      throw new RestoreRefusedError("not_backup", `Table ${name} is in the manifest only.`);
  return { meta: parsed as unknown as BackupMeta, tables: tables as Record<string, unknown[]> };
}

export function isLocalHost(host: string): boolean {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host);
}

export interface RestoreSummary {
  dryRun: boolean;
  backupCreatedAt: string;
  backupAgeHours: number;
  inserted: Record<string, number>;
}

class DryRunRollback extends Error {
  constructor(readonly summary: RestoreSummary) {
    super("dry run rollback");
  }
}

const CHUNK = 500;

/**
 * Restores a backup into an empty, migrated database in one transaction. Every refusal comes
 * before the first insert. A dry run does the full work and rolls back.
 */
export async function restoreBackup(
  db: Db,
  input: BackupInput,
  opts: { dryRun: boolean; now: Date },
): Promise<RestoreSummary> {
  const { meta } = input;
  try {
    return await db.transaction(async (tx) => {
      const migrations = await readMigrations(tx);
      if (
        migrations.length !== meta.migrations.length ||
        migrations.some((h, i) => h !== meta.migrations[i])
      )
        throw new RestoreRefusedError(
          "schema_mismatch",
          "The target is at a different migration than the backup. Restore into a database at the same migration, then run pnpm db:migrate.",
        );

      const catalog = await readCatalog(tx);
      const excluded: readonly string[] = EXCLUDED_TABLES;
      const targets = catalog.filter((t) => !excluded.includes(t.name));
      const fileNames = Object.keys(input.tables).sort();
      const targetNames = targets.map((t) => t.name).sort();
      const missing = targetNames.filter((n) => !fileNames.includes(n));
      const extra = fileNames.filter((n) => !targetNames.includes(n));
      if (missing.length || extra.length)
        throw new RestoreRefusedError(
          "schema_mismatch",
          `Tables differ. Missing in the backup: ${missing.join(", ") || "none"}. Not in the target: ${extra.join(", ") || "none"}.`,
        );
      for (const t of targets) {
        for (const row of input.tables[t.name] as Record<string, unknown>[]) {
          const bad = Object.keys(row).find((k) => !t.columns.includes(k));
          if (bad !== undefined)
            throw new RestoreRefusedError(
              "schema_mismatch",
              `Table ${t.name} has no column ${bad} in the target.`,
            );
        }
      }

      for (const t of catalog) {
        const found = await tx.execute(
          sql`select exists (select 1 from ${sql.identifier(t.name)}) as has_rows`,
        );
        if (found[0]?.has_rows)
          throw new RestoreRefusedError(
            "target_not_empty",
            `Table ${t.name} already has rows. Restore only into an empty database.`,
          );
      }

      const inserted: Record<string, number> = {};
      const ordered = restoreOrder(targets);
      for (const t of ordered) {
        const rows = input.tables[t.name] as unknown[];
        for (let i = 0; i < rows.length; i += CHUNK) {
          const json = JSON.stringify(rows.slice(i, i + CHUNK));
          await tx.execute(sql`
            insert into ${sql.identifier(t.name)}
            select * from jsonb_populate_recordset(null::${sql.identifier(t.name)}, ${json}::jsonb)`);
        }
        inserted[t.name] = rows.length;
      }

      // New ids must continue past every restored id (write_ledger keeps `p:<id>` keys).
      for (const t of ordered) {
        for (const s of t.sequences) {
          const max = await tx.execute(
            sql`select max(${sql.identifier(s.column)}) as m from ${sql.identifier(t.name)}`,
          );
          const m = max[0]?.m;
          if (m === null || m === undefined)
            await tx.execute(sql`select setval(${s.sequence}::regclass, 1, false)`);
          else await tx.execute(sql`select setval(${s.sequence}::regclass, ${String(m)}::bigint)`);
        }
      }

      // Row count and hash are read back from Postgres, same query as the export.
      for (const t of ordered) {
        const order = sql.join(
          (t.primaryKey.length ? t.primaryKey : t.columns).map((c) => sql`t.${sql.identifier(c)}`),
          sql`, `,
        );
        const res = await tx.execute(sql`
          with agg as (
            select coalesce(jsonb_agg(to_jsonb(t) order by ${order}), '[]'::jsonb) as j,
                   count(*)::int as n
            from ${sql.identifier(t.name)} t
          )
          select n as count, encode(sha256(convert_to(j::text, 'UTF8')), 'hex') as sha256 from agg`);
        const want = meta.manifest[t.name];
        if (Number(res[0]?.count) !== want?.rows || String(res[0]?.sha256) !== want?.sha256)
          throw new RestoreRefusedError(
            "manifest_mismatch",
            `Table ${t.name} does not match the backup manifest after the insert.`,
          );
      }

      await refreshUserState(tx);

      const created = Date.parse(meta.created_at);
      const summary: RestoreSummary = {
        dryRun: opts.dryRun,
        backupCreatedAt: meta.created_at,
        backupAgeHours: Math.round(((opts.now.getTime() - created) / 3_600_000) * 10) / 10,
        inserted,
      };
      if (opts.dryRun) throw new DryRunRollback(summary);
      return summary;
    });
  } catch (error) {
    if (error instanceof DryRunRollback) return error.summary;
    throw error;
  }
}
