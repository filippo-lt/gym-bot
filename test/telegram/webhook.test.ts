import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const enqueue = vi.fn(async () => true);
const processChat = vi.fn(async () => ({
  chatId: 1,
  processed: 1,
  failed: 0,
  stoppedReason: "empty",
}));
const waitUntil = vi.fn((_p: Promise<unknown>) => {});

vi.mock("@vercel/functions", () => ({ waitUntil }));
vi.mock("../../src/db/client.js", () => ({ getDb: () => ({}) }));
vi.mock("../../src/runtime/inbox.js", () => ({ enqueue }));
vi.mock("../../src/runtime/process-chat.js", () => ({ processChat }));
vi.mock("../../src/runtime/telegram-runtime.js", () => ({
  botHandlers: async () => ({
    handle: async () => {},
    sendTyping: async () => {},
    notifyFailed: async () => {},
    notifyRetrying: async () => {},
  }),
}));

const SECRET = "w".repeat(32);
const USER = 4242;

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://example.test/api/telegram", {
    method: "POST",
    headers: { "x-telegram-bot-api-secret-token": SECRET, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
const message = (from: number) => ({
  update_id: 10,
  message: { message_id: 1, chat: { id: 99 }, from: { id: from }, text: "/today" },
});

let POST: (r: Request) => Promise<Response>;

beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "token");
  vi.stubEnv("ALLOWED_TELEGRAM_USER_ID", String(USER));
  vi.resetModules();
  POST = (await import("../../api/telegram.js")).POST;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("POST /api/telegram", () => {
  it("401 without the secret header", async () => {
    const req = new Request("https://example.test/api/telegram", {
      method: "POST",
      body: JSON.stringify(message(USER)),
    });
    expect((await POST(req)).status).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("401 with a wrong secret", async () => {
    const res = await POST(
      post(message(USER), { "x-telegram-bot-api-secret-token": "x".repeat(32) }),
    );
    expect(res.status).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("200 and nothing stored for another user", async () => {
    const res = await POST(post(message(USER + 1)));
    expect(res.status).toBe(200);
    expect(enqueue).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("stores the update and schedules processing for the allowed user", async () => {
    const before = Date.now();
    const res = await POST(post(message(USER)));
    expect(res.status).toBe(200);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ update_id: 10, chat_id: 99 }),
    );
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntil.mock.calls[0]?.[0];
    expect(processChat).toHaveBeenCalledWith(expect.objectContaining({ chatId: 99 }));
    const deps = (processChat.mock.calls as unknown as [{ startedAt: number }][])[0]?.[0];
    expect(deps?.startedAt).toBeGreaterThanOrEqual(before);
    expect(deps?.startedAt).toBeLessThanOrEqual(Date.now());
  });

  it("catches and logs a processChat failure inside waitUntil", async () => {
    processChat.mockRejectedValueOnce(new Error("kaput"));
    expect((await POST(post(message(USER)))).status).toBe(200);
    await expect(waitUntil.mock.calls[0]?.[0]).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith("telegram: processing failed:", "Error");
  });

  it("200 for invalid JSON and for unrecognised shapes", async () => {
    expect((await POST(post("{not json"))).status).toBe(200);
    expect((await POST(post({ hello: "world" }))).status).toBe(200);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("500 without details when the webhook secret is not configured", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "");
    vi.resetModules();
    const { POST: P } = await import("../../api/telegram.js");
    const res = await P(post(message(USER)));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "server misconfigured" });
  });
});
