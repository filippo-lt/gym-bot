import { gzipSync } from "node:zlib";
import { sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { APP_TIMEZONE } from "../config/constants.js";
import type { Db } from "../db/seed-plan.js";
import { type CatalogTable, EXCLUDED_TABLES, readCatalog, readMigrations } from "./catalog.js";
import { toCsv } from "./csv.js";
import { zip } from "./zip.js";

export interface ManifestEntry {
  rows: number;
  sha256: string;
}

export interface BackupMeta {
  format: "gymbot-backup";
  version: 1;
  created_at: string;
  migrations: string[];
  excluded: string[];
  manifest: Record<string, ManifestEntry>;
}

export interface BuiltBackup {
  meta: BackupMeta;
  tables: CatalogTable[];
  /** Postgres JSON text per table, never parsed on the way to the file. */
  tableJson: Record<string, string>;
  /** The whole file. */
  json: string;
}

export interface BackupFiles {
  json: { name: string; data: Uint8Array };
  zip: { name: string; data: Uint8Array };
}

export const GZIP_OVER_BYTES = 10 * 1024 * 1024;
export const TELEGRAM_MAX_BYTES = 45 * 1024 * 1024;

/**
 * Reads every non-excluded public table, one query at a time, in one read-only
 * repeatable-read transaction so all tables come from the same snapshot.
 */
export async function buildBackup(db: Db, now: Date): Promise<BuiltBackup> {
  return db.transaction(
    async (tx) => {
      const excluded: readonly string[] = EXCLUDED_TABLES;
      const tables = (await readCatalog(tx)).filter((t) => !excluded.includes(t.name));
      const migrations = await readMigrations(tx);
      const manifest: Record<string, ManifestEntry> = {};
      const tableJson: Record<string, string> = {};
      for (const t of tables) {
        const order = sql.join(
          (t.primaryKey.length ? t.primaryKey : t.columns).map((c) => sql`t.${sql.identifier(c)}`),
          sql`, `,
        );
        const rows = await tx.execute(sql`
          with agg as (
            select coalesce(jsonb_agg(to_jsonb(t) order by ${order}), '[]'::jsonb) as j,
                   count(*)::int as n
            from ${sql.identifier(t.name)} t
          )
          select j::text as rows, n as count,
                 encode(sha256(convert_to(j::text, 'UTF8')), 'hex') as sha256
          from agg`);
        const row = rows[0];
        if (!row) throw new Error("Backup read returned no row.");
        tableJson[t.name] = String(row.rows);
        manifest[t.name] = { rows: Number(row.count), sha256: String(row.sha256) };
      }
      const meta: BackupMeta = {
        format: "gymbot-backup",
        version: 1,
        created_at: now.toISOString(),
        migrations,
        excluded: [...EXCLUDED_TABLES],
        manifest,
      };
      const body = tables.map((t) => `${JSON.stringify(t.name)}:${tableJson[t.name]}`).join(",");
      const head = JSON.stringify(meta);
      const json = `${head.slice(0, -1)},"tables":{${body}}}`;
      return { meta, tables, tableJson, json };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/** The JSON (gzipped when large and allowed) and the CSV zip, named with the Rome date. */
export function backupFiles(b: BuiltBackup, now: Date, opts: { allowGzip: boolean }): BackupFiles {
  const date = DateTime.fromJSDate(now, { zone: APP_TIMEZONE }).toFormat("yyyy-MM-dd");
  const base = `gymbot-backup-${date}`;
  const jsonBytes = new TextEncoder().encode(b.json);
  const json =
    opts.allowGzip && jsonBytes.length > GZIP_OVER_BYTES
      ? { name: `${base}.json.gz`, data: new Uint8Array(gzipSync(jsonBytes)) }
      : { name: `${base}.json`, data: jsonBytes };

  const enc = new TextEncoder();
  const csvs = b.tables.map((t) => {
    const rows = JSON.parse(b.tableJson[t.name] as string) as Record<string, unknown>[];
    return { name: `${t.name}.csv`, data: enc.encode(toCsv(t.columns, rows)) };
  });
  return { json, zip: { name: `${base}-csv.zip`, data: zip(csvs) } };
}
