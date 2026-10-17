import postgres from "postgres";
import { afterAll, expect, test } from "vitest";
import { testDatabaseUrl } from "./constants.js";

const sql = postgres(testDatabaseUrl(), { max: 1, prepare: false });

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

test("connects to the test database", async () => {
  const rows = await sql`select 1 as one`;
  expect(rows[0]?.one).toBe(1);
});
