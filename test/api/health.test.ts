import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const secret = "s".repeat(32);
const get = (headers: Record<string, string> = {}) =>
  new Request("https://example.test/api/health", { headers });

async function loadHandler() {
  vi.resetModules();
  return (await import("../../api/health.js")).GET;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/health", () => {
  it("returns 401 without a header", async () => {
    vi.stubEnv("CRON_SECRET", secret);
    const GET = await loadHandler();
    expect((await GET(get())).status).toBe(401);
  });

  it("returns 401 with a wrong bearer", async () => {
    vi.stubEnv("CRON_SECRET", secret);
    const GET = await loadHandler();
    expect((await GET(get({ authorization: `Bearer ${"x".repeat(32)}` }))).status).toBe(401);
  });

  it("returns 500 JSON when CRON_SECRET is missing", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const GET = await loadHandler();
    const res = await GET(get({ authorization: "Bearer anything" }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "server misconfigured" });
  });

  it("returns 503 without details when the database is unreachable", async () => {
    vi.stubEnv("CRON_SECRET", secret);
    vi.stubEnv("DATABASE_URL", "postgres://postgres:secretpw@127.0.0.1:1/nope");
    const GET = await loadHandler();
    const res = await GET(get({ authorization: `Bearer ${secret}` }));
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: false, db: "down" });
    expect(text).not.toContain("secretpw");
  });
});
