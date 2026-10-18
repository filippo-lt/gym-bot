import { gunzipSync } from "node:zlib";
import { is } from "drizzle-orm";
import { getTableConfig, type PgTable, PgTable as PgTableClass } from "drizzle-orm/pg-core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { EXCLUDED_TABLES, readCatalog, readMigrations } from "../../src/backup/catalog.js";
import {
  type BuiltBackup,
  backupFiles,
  buildBackup,
  GZIP_OVER_BYTES,
} from "../../src/backup/export.js";
import * as schema from "../../src/db/schema/index.js";
import { connect, resetAndSeed } from "./logging-fixture.js";

const { sql, db } = connect();
afterAll(async () => {
  await sql.end({ timeout: 5 });
});
beforeEach(async () => {
  await resetAndSeed(db, sql);
});

const NOW = new Date("2026-10-18T17:00:03.120Z");

describe("backup catalog", () => {
  it("lists the same tables as the Drizzle schema", async () => {
    const catalog = (await readCatalog(db)).map((t) => t.name);
    const fromSchema = Object.values(schema)
      .filter((v) => is(v, PgTableClass))
      .map((t) => getTableConfig(t as PgTable).name)
      .sort();
    expect(catalog).toEqual(fromSchema);
  });

  it("reads foreign keys and sequences", async () => {
    const entries = (await readCatalog(db)).find((t) => t.name === "log_entries");
    expect(entries?.dependsOn).toContain("log_groups");
    const groups = (await readCatalog(db)).find((t) => t.name === "log_groups");
    expect(groups?.sequences.map((s) => s.column)).toContain("id");
    expect(groups?.primaryKey).toEqual(["id"]);
  });

  it("reads the migration hashes", async () => {
    const hashes = await readMigrations(db);
    expect(hashes.length).toBeGreaterThan(0);
    expect(hashes.every((h) => typeof h === "string" && h.length > 0)).toBe(true);
  });
});

describe("buildBackup", () => {
  it("covers every catalog table or excludes it, and excluded tables exist", async () => {
    const catalog = (await readCatalog(db)).map((t) => t.name);
    const built = await buildBackup(db, NOW);
    for (const name of catalog) {
      expect(
        name in built.meta.manifest || (EXCLUDED_TABLES as readonly string[]).includes(name),
      ).toBe(true);
    }
    for (const name of EXCLUDED_TABLES) expect(catalog).toContain(name);
    for (const name of EXCLUDED_TABLES) expect(built.meta.manifest[name]).toBeUndefined();
    expect(built.meta.excluded).toEqual([...EXCLUDED_TABLES]);
  });

  it("counts rows and hashes them in Postgres", async () => {
    const built = await buildBackup(db, NOW);
    for (const [name, entry] of Object.entries(built.meta.manifest)) {
      expect(JSON.parse(built.tableJson[name] as string)).toHaveLength(entry.rows);
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(built.meta.manifest.plans?.rows).toBeGreaterThan(0);
    expect(built.meta.manifest.plans?.sha256).toBe(
      (
        await sql`select encode(sha256(convert_to(${built.tableJson.plans as string}::jsonb::text, 'UTF8')), 'hex') as h`
      )[0]?.h,
    );
  });

  it("writes a parseable file with typed values", async () => {
    const built = await buildBackup(db, NOW);
    const parsed = JSON.parse(built.json);
    expect(parsed.format).toBe("gymbot-backup");
    expect(parsed.version).toBe(1);
    expect(parsed.created_at).toBe(NOW.toISOString());
    expect(parsed.migrations).toEqual(built.meta.migrations);
    expect(Object.keys(parsed.tables).sort()).toEqual(Object.keys(built.meta.manifest).sort());
    const plan = parsed.tables.plans[0];
    expect(plan.created_at).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it("keeps text[] as arrays and jsonb as objects", async () => {
    const catalog = await readCatalog(db);
    const built = await buildBackup(db, NOW);
    const parsed = JSON.parse(built.json).tables as Record<string, Record<string, unknown>[]>;
    const types = await sql<{ t: string; c: string; ty: string }[]>`
      select table_name t, column_name c, data_type ty from information_schema.columns
      where table_schema = 'public' and data_type in ('ARRAY', 'jsonb')`;
    let arrays = 0;
    let objects = 0;
    for (const { t, c, ty } of types) {
      if (!catalog.some((x) => x.name === t) || !parsed[t]) continue;
      for (const row of parsed[t]) {
        const v = row[c];
        if (v === null) continue;
        if (ty === "ARRAY") {
          expect(Array.isArray(v)).toBe(true);
          arrays++;
        } else if (typeof v === "object") objects++;
      }
    }
    expect(arrays + objects).toBeGreaterThan(0);
  });
});

describe("backupFiles", () => {
  const fake = (json: string): BuiltBackup =>
    ({ meta: {}, tables: [], tableJson: {}, json }) as unknown as BuiltBackup;

  it("names files with the Rome date", () => {
    const f = backupFiles(fake("{}"), new Date("2026-10-18T22:30:00Z"), { allowGzip: true });
    expect(f.json.name).toBe("gymbot-backup-2026-10-19.json");
    expect(f.zip.name).toBe("gymbot-backup-2026-10-19-csv.zip");
  });

  it("gzips a big file only when allowed", () => {
    const big = "a".repeat(GZIP_OVER_BYTES + 1024 * 1024);
    const gz = backupFiles(fake(big), NOW, { allowGzip: true });
    expect(gz.json.name).toBe("gymbot-backup-2026-10-18.json.gz");
    expect(Buffer.from(gunzipSync(gz.json.data)).toString("utf8")).toBe(big);
    const plain = backupFiles(fake(big), NOW, { allowGzip: false });
    expect(plain.json.name).toBe("gymbot-backup-2026-10-18.json");
    expect(plain.json.data.length).toBe(big.length);
  });
});
