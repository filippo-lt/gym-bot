import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const processChat = vi.fn(async (d: { chatId: number }) => ({
  chatId: d.chatId,
  processed: 1,
  failed: 0,
  stoppedReason: "empty",
}));
const execute = vi.fn(async () => []);
const chatsWithOpenRows = vi.fn(async () => [11, 22]);

vi.mock("../../src/db/client.js", () => ({ getDb: () => ({ execute }) }));
vi.mock("../../src/runtime/inbox.js", () => ({ chatsWithOpenRows }));
vi.mock("../../src/runtime/process-chat.js", () => ({ processChat }));
vi.mock("../../src/runtime/telegram-runtime.js", () => ({
  botHandlers: async () => ({
    handle: async () => {},
    sendTyping: async () => {},
    notifyFailed: async () => {},
  }),
}));

const secret = "s".repeat(32);
const get = (headers: Record<string, string> = {}) =>
  new Request("https://example.test/api/cron/tick", { headers });

let GET: (r: Request) => Promise<Response>;

beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("CRON_SECRET", secret);
  vi.resetModules();
  GET = (await import("../../api/cron/tick.js")).GET;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("GET /api/cron/tick", () => {
  it("401 without a bearer", async () => {
    expect((await GET(get())).status).toBe(401);
    expect(processChat).not.toHaveBeenCalled();
  });

  it("200 and sweeps every chat with open rows", async () => {
    const res = await GET(get({ authorization: `Bearer ${secret}` }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; swept: { chatId: number }[] };
    expect(body.ok).toBe(true);
    expect(body.swept.map((s) => s.chatId)).toEqual([11, 22]);
    expect(processChat).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalled();
  });
});
