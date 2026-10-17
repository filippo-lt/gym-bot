import { afterAll, expect, test, vi } from "vitest";
import { testDatabaseUrl } from "./constants.js";

const secret = "s".repeat(32);
vi.stubEnv("CRON_SECRET", secret);
vi.stubEnv("DATABASE_URL", testDatabaseUrl());

const { GET } = await import("../../api/health.js");
const { closeDb } = await import("../../src/db/client.js");

afterAll(async () => {
  await closeDb();
  vi.unstubAllEnvs();
});

test("returns 200 with the database up", async () => {
  const res = await GET(
    new Request("https://example.test/api/health", {
      headers: { authorization: `Bearer ${secret}` },
    }),
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ ok: true, db: "up" });
  expect(body).not.toHaveProperty("pg");
});
