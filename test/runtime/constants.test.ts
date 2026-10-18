import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { AI_BUDGET_S } from "../../src/ai/constants.js";
import { LEASE_S, MAX_DURATION_S, STOP_TAKING_AT_S } from "../../src/runtime/constants.js";

const vercel = JSON.parse(readFileSync("vercel.json", "utf8")) as {
  functions: Record<string, { maxDuration: number }>;
};

it("lease is maxDuration + 60 s", () => {
  expect(LEASE_S).toBe(MAX_DURATION_S + 60);
  expect(STOP_TAKING_AT_S).toBeLessThan(MAX_DURATION_S);
});

it("the AI budget fits after the last claim", () => {
  expect(STOP_TAKING_AT_S + AI_BUDGET_S + 5).toBeLessThanOrEqual(MAX_DURATION_S);
});

it("vercel.json maxDuration matches the constants", () => {
  expect(vercel.functions["api/telegram.ts"]?.maxDuration).toBe(MAX_DURATION_S);
  expect(vercel.functions["api/cron/tick.ts"]?.maxDuration).toBe(MAX_DURATION_S);
  expect(vercel.functions["api/health.ts"]?.maxDuration).toBe(30);
});

it("every function file in api/ has an explicit vercel.json entry", () => {
  const files = readdirSync("api", { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `api/${f}`);
  expect(files.length).toBeGreaterThan(0);
  for (const f of files) expect(vercel.functions[f], f).toBeDefined();
});
