import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, expect, test } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";
import { testDatabaseUrl } from "./constants.js";

const dir = mkdtempSync(join(tmpdir(), "gymbot-mig-"));
const sql = postgres(testDatabaseUrl(), { max: 1, prepare: false, onnotice: () => {} });

async function cleanup() {
  await sql`drop table if exists m0_migration_probe`;
  await sql`drop schema if exists drizzle cascade`;
}

beforeAll(async () => {
  await cleanup();
  mkdirSync(join(dir, "meta"));
  writeFileSync(
    join(dir, "0000_probe.sql"),
    "CREATE TABLE m0_migration_probe (id integer primary key);\n",
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
  expect(await runMigrations(testDatabaseUrl(), dir)).toBe(true);
  const first = await sql`select to_regclass('public.m0_migration_probe') as t`;
  expect(first[0]?.t).toBe("m0_migration_probe");

  expect(await runMigrations(testDatabaseUrl(), dir)).toBe(true);
  const applied = await sql`select count(*)::int as n from drizzle.__drizzle_migrations`;
  expect(applied[0]?.n).toBe(1);
});

test("skips when there is no journal", async () => {
  expect(await runMigrations(testDatabaseUrl(), join(dir, "nope"))).toBe(false);
});
