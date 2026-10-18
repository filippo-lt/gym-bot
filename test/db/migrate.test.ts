import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, expect, test } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";
import { testDatabaseUrl } from "./constants.js";

const dir = mkdtempSync(join(tmpdir(), "gymbot-mig-"));
const sql = postgres(testDatabaseUrl(), { max: 1, prepare: false, onnotice: () => {} });

const PROBE_SCHEMA = "migrate_probe";
const MIGRATION_OPTIONS = { migrationsSchema: PROBE_SCHEMA, migrationsTable: "probe_journal" };

async function cleanup() {
  await sql`drop schema if exists migrate_probe cascade`;
}

beforeAll(async () => {
  await cleanup();
  mkdirSync(join(dir, "meta"));
  writeFileSync(
    join(dir, "0000_probe.sql"),
    "CREATE SCHEMA IF NOT EXISTS migrate_probe;\nCREATE TABLE migrate_probe.probe (id integer primary key);\n",
  );
  writeFileSync(
    join(dir, "meta", "_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: [
        { idx: 0, version: "7", when: 1700000000000, tag: "0000_probe", breakpoints: true },
      ],
    }),
  );
});

afterAll(async () => {
  await cleanup();
  await sql.end({ timeout: 5 });
  rmSync(dir, { recursive: true, force: true });
});

test("applies a migration and is idempotent", async () => {
  expect(await runMigrations(testDatabaseUrl(), dir, MIGRATION_OPTIONS)).toBe(true);
  const first = await sql`select to_regclass('migrate_probe.probe') as t`;
  expect(first[0]?.t).toBe("migrate_probe.probe");

  expect(await runMigrations(testDatabaseUrl(), dir, MIGRATION_OPTIONS)).toBe(true);
  const applied = await sql`select count(*)::int as n from migrate_probe.probe_journal`;
  expect(applied[0]?.n).toBe(1);
});

test("skips when there is no journal", async () => {
  expect(await runMigrations(testDatabaseUrl(), join(dir, "nope"), MIGRATION_OPTIONS)).toBe(false);
});

test("has job_runs with a unique (job, date)", async () => {
  await sql`delete from job_runs where job = 'class_question' and date = '2026-10-22'`;
  await sql`insert into job_runs (job, date) values ('class_question', '2026-10-22')`;
  await expect(
    sql`insert into job_runs (job, date) values ('class_question', '2026-10-22')`,
  ).rejects.toMatchObject({ code: "23505" });
  const rows = await sql`select status, done_at from job_runs where job = 'class_question'`;
  expect(rows[0]?.status).toBe("claimed");
  expect(rows[0]?.done_at).toBeNull();
  await sql`delete from job_runs where job = 'class_question' and date = '2026-10-22'`;
});

test("pending_actions defaults input_source to text", async () => {
  const rows = await sql`
    insert into pending_actions (chat_id, kind, actions, expires_at)
    values (1, 'confirm', '[]'::jsonb, now() + interval '1 hour')
    returning id, input_source, transcript`;
  expect(rows[0]?.input_source).toBe("text");
  expect(rows[0]?.transcript).toBeNull();
  await expect(
    sql`insert into pending_actions (chat_id, kind, actions, expires_at, input_source)
        values (1, 'confirm', '[]'::jsonb, now(), 'fax')`,
  ).rejects.toMatchObject({ code: "23514" });
  await sql`delete from pending_actions where id = ${rows[0]?.id}`;
});
