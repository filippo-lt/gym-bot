import Anthropic from "@anthropic-ai/sdk";
import { DrizzleQueryError } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { AiTimeoutError } from "../../src/ai/errors.js";
import { classify, describeFailure } from "../../src/failures/classify.js";
import { SttError } from "../../src/stt/stt.js";
import { FileTooLargeError } from "../../src/telegram/files.js";

const api = (status: number) => new Anthropic.APIError(status, undefined, undefined, new Headers());
const named = (name: string, extra: object = {}) =>
  Object.assign(new Error("secret text"), { name }, extra);

describe("classify", () => {
  it("FileTooLargeError is file_too_large on any step", () => {
    expect(classify(new FileTooLargeError(10), "download").kind).toBe("file_too_large");
    expect(classify(new FileTooLargeError(10), "vision").kind).toBe("file_too_large");
  });
  it("other download errors are download_failed", () => {
    expect(classify(new Error("x"), "download").kind).toBe("download_failed");
  });
  it("AiTimeoutError and SDK timeout are ai_timeout", () => {
    expect(classify(new AiTimeoutError(), "ai").kind).toBe("ai_timeout");
    expect(classify(new Anthropic.APIConnectionTimeoutError(), "vision").kind).toBe("ai_timeout");
  });
  it.each([529, 500, 502, 503, 504])("APIError %i is ai_overloaded", (s) => {
    expect(classify(api(s), "ai").kind).toBe("ai_overloaded");
  });
  it("maps 429, 401, 403, 400", () => {
    expect(classify(api(429), "ai").kind).toBe("ai_rate_limited");
    expect(classify(api(401), "ai").kind).toBe("ai_auth");
    expect(classify(api(403), "ai").kind).toBe("ai_auth");
    expect(classify(api(400), "ai").kind).toBe("ai_refused");
  });
  it("APIConnectionError is ai_network", () => {
    expect(classify(new Anthropic.APIConnectionError({}), "ai").kind).toBe("ai_network");
  });
  it("SttError statuses", () => {
    expect(classify(new SttError(429, "groq"), "stt").kind).toBe("stt_rate_limited");
    expect(classify(new SttError(401, "groq"), "stt").kind).toBe("stt_auth");
    expect(classify(new SttError(403, "groq"), "stt").kind).toBe("stt_auth");
    expect(classify(new SttError(503, "groq"), "stt").kind).toBe("stt_down");
    expect(classify(new SttError(400, "groq"), "stt").kind).toBe("stt_failed");
  });
  it("stt timeout and abort names", () => {
    expect(classify(named("TimeoutError"), "stt").kind).toBe("stt_timeout");
    expect(classify(named("AbortError"), "stt").kind).toBe("stt_timeout");
    expect(classify(new Error("boom"), "stt").kind).toBe("stt_failed");
  });
  it("a bare socket code is unknown; through Drizzle or alongside a PostgresError it is db", () => {
    expect(classify(named("Error", { code: "ECONNRESET" })).kind).toBe("unknown");
    expect(classify(named("Error", { code: "ETIMEDOUT" }), "ai").kind).toBe("unknown");
    expect(
      classify(new DrizzleQueryError("select 1", [], named("Error", { code: "ECONNRESET" }))).kind,
    ).toBe("db");
    expect(
      classify(
        named("Error", {
          cause: named("PostgresError", { cause: named("Error", { code: "ECONNREFUSED" }) }),
        }),
      ).kind,
    ).toBe("db");
  });

  it("PostgresError and connection codes are db", () => {
    expect(classify(named("PostgresError", { code: "23505" })).kind).toBe("db");
    expect(classify(named("Error", { code: "CONNECTION_CLOSED" })).kind).toBe("db");
    expect(classify(named("Error", { code: "CONNECT_TIMEOUT" })).kind).toBe("db");
  });
  it("unknown otherwise", () => {
    expect(classify(new Error("x")).kind).toBe("unknown");
    expect(classify("string").kind).toBe("unknown");
    expect(classify(undefined).kind).toBe("unknown");
  });
  it("unwraps BotError", () => {
    expect(classify({ name: "BotError", error: api(429) }, "ai").kind).toBe("ai_rate_limited");
  });
  it("a real DrizzleQueryError around a socket error is db and leaks no query text", () => {
    const cause = Object.assign(new Error("x"), { code: "ECONNREFUSED" });
    for (const step of ["other", "ai"] as const) {
      const f = classify(new DrizzleQueryError("select 1", ["p4ram"], cause), step);
      expect(f.kind).toBe("db");
      expect(describeFailure(f)).not.toContain("select 1");
      expect(describeFailure(f)).not.toContain("p4ram");
    }
  });
  it("unwraps DrizzleQueryError cause without leaking message text", () => {
    const e = new DrizzleQueryError("select 1", [], named("PostgresError", { code: "23505" }));
    const f = classify(e);
    expect(f.kind).toBe("db");
    expect(describeFailure(f)).not.toContain("secret text");
    expect(describeFailure(f)).toContain("db (");
  });
  it("follows cause through plain wrappers, max 5 hops", () => {
    const deep = (n: number): Error => {
      let e: Error = named("PostgresError");
      for (let i = 0; i < n; i++) e = Object.assign(new Error("w"), { cause: e });
      return e;
    };
    expect(classify(deep(3)).kind).toBe("db");
    expect(classify(deep(8)).kind).toBe("unknown");
  });
  it("detail is capped at 120 chars", () => {
    const f = classify(named("X".repeat(300)));
    expect(f.detail.length).toBeLessThanOrEqual(120);
  });
  it("detail comes from the unwrapped error", () => {
    expect(classify({ name: "BotError", error: new TypeError("x") }).detail).toBe("TypeError");
    expect(classify({ name: "BotError", error: new TypeError("x") }, "download")).toEqual({
      kind: "download_failed",
      detail: "TypeError",
    });
    const e = new DrizzleQueryError("select 1", [], named("WeirdError"));
    expect(classify(e)).toEqual({ kind: "unknown", detail: "WeirdError" });
  });
  it("caller aborts are ai_timeout on ai/vision; a bare name elsewhere is not", () => {
    expect(classify(new Anthropic.APIUserAbortError(), "vision").kind).toBe("ai_timeout");
    const dom = new DOMException("signal timed out", "TimeoutError");
    expect(classify(dom, "vision").kind).toBe("ai_timeout");
    expect(classify(new DOMException("x", "AbortError"), "ai").kind).toBe("ai_timeout");
    expect(classify(dom, "ai").kind).toBe("ai_timeout");
    expect(classify(dom, "other").kind).toBe("unknown");
    expect(classify(dom).kind).toBe("unknown");
    expect(classify(new Anthropic.APIUserAbortError(), "other").kind).toBe("ai_timeout");
  });
});
