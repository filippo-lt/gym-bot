import { afterEach, describe, expect, it, vi } from "vitest";
import { hasValidBearer, requireCronAuth } from "../../src/http/auth.js";

const secret = "a".repeat(32);
const req = (headers: Record<string, string> = {}) =>
  new Request("https://example.test/api/health", { headers });

describe("hasValidBearer", () => {
  it("accepts the correct bearer token", () => {
    expect(hasValidBearer(req({ authorization: `Bearer ${secret}` }), secret)).toBe(true);
  });

  it("rejects a wrong token of the same length", () => {
    expect(hasValidBearer(req({ authorization: `Bearer ${"b".repeat(32)}` }), secret)).toBe(false);
  });

  it("rejects a wrong token of a different length", () => {
    expect(hasValidBearer(req({ authorization: "Bearer short" }), secret)).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(hasValidBearer(req(), secret)).toBe(false);
  });

  it("accepts the scheme in any case", () => {
    expect(hasValidBearer(req({ authorization: `bearer ${secret}` }), secret)).toBe(true);
  });

  it("rejects a non-bearer scheme", () => {
    expect(hasValidBearer(req({ authorization: `Basic ${secret}` }), secret)).toBe(false);
  });
});

describe("requireCronAuth", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns null for the right secret", () => {
    vi.stubEnv("CRON_SECRET", secret);
    expect(requireCronAuth(req({ authorization: `Bearer ${secret}` }))).toBeNull();
  });

  it("returns 401 JSON otherwise", async () => {
    vi.stubEnv("CRON_SECRET", secret);
    const res = requireCronAuth(req());
    expect(res?.status).toBe(401);
    expect(await res?.json()).toEqual({ ok: false, error: "unauthorized" });
  });
});
