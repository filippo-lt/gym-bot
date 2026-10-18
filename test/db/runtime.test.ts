import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/client.js";
import * as schema from "../../src/db/schema/index.js";
import { claim, enqueue, oldestOpen, purgeOldRows, resetStuck } from "../../src/runtime/inbox.js";
import { acquireOrRenew, release } from "../../src/runtime/lease.js";
import { processChat } from "../../src/runtime/process-chat.js";
import { testDatabaseUrl } from "./constants.js";

const clients: postgres.Sql[] = [];
function connect(): { sql: postgres.Sql; db: Db } {
  const client = postgres(testDatabaseUrl(), { max: 2, prepare: false, onnotice: () => {} });
  clients.push(client);
  return { sql: client, db: drizzle(client, { schema }) };
}

const main = connect();
const CHAT = 777;
const FAR = () => Date.now() + 60_000;

beforeEach(async () => {
  await main.sql`truncate inbox, chat_lease restart identity`;
});
afterAll(async () => {
  await Promise.all(clients.map((c) => c.end({ timeout: 5 })));
});

const seed = async (n: number, chat = CHAT, base = 1000) => {
  for (let i = 0; i < n; i += 1) {
    await enqueue(main.db, { update_id: base + i, chat_id: chat, payload: { n: base + i } });
  }
};
const noop = async () => {};
const statuses = async () =>
  (await main.sql`select update_id::int as u, status, attempts from inbox order by id`).map(
    (r) => `${r.u}:${r.status}:${r.attempts}`,
  );

describe("inbox", () => {
  it("dedupes by update_id", async () => {
    expect(await enqueue(main.db, { update_id: 5, chat_id: CHAT, payload: { a: 1 } })).toBe(true);
    expect(await enqueue(main.db, { update_id: 5, chat_id: CHAT, payload: { a: 2 } })).toBe(false);
    const rows = await main.sql`select payload from inbox`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual({ a: 1 });
  });

  it("processes two rows in order", async () => {
    await seed(2);
    const handled: number[] = [];
    const summary = await processChat({
      db: main.db,
      chatId: CHAT,
      handle: async (p) => void handled.push((p as { n: number }).n),
      sendTyping: noop,
      notifyFailed: noop,
      notifyRetrying: noop,
      deadline: FAR(),
    });
    expect(handled).toEqual([1000, 1001]);
    expect(summary).toMatchObject({ processed: 2, failed: 0, stoppedReason: "empty" });
    expect(await statuses()).toEqual(["1000:done:1", "1001:done:1"]);
  });
});

describe("concurrency", () => {
  it("two concurrent processChat calls handle each row exactly once, in order", async () => {
    await seed(8);
    const a = connect();
    const b = connect();
    const handled: number[] = [];
    const handle = async (p: unknown) => {
      handled.push((p as { n: number }).n);
      await new Promise((r) => setTimeout(r, 20));
    };
    const run = (db: Db) =>
      processChat({
        db,
        chatId: CHAT,
        handle,
        sendTyping: noop,
        notifyFailed: noop,
        notifyRetrying: noop,
        deadline: FAR(),
      });
    const [s1, s2] = await Promise.all([run(a.db), run(b.db)]);
    expect(handled).toEqual([1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007]);
    expect(s1.processed + s2.processed).toBe(8);
    expect((await statuses()).every((s) => s.endsWith(":done:1"))).toBe(true);
  });

  it("another owner cannot renew or release a live lease", async () => {
    const me = randomUUID();
    const other = randomUUID();
    expect(await acquireOrRenew(main.db, CHAT, me)).toBe(true);
    expect(await acquireOrRenew(main.db, CHAT, other)).toBe(false);
    expect(await release(main.db, other)).toBe(0);
    expect(await acquireOrRenew(main.db, CHAT, other)).toBe(false);
    expect(await acquireOrRenew(main.db, CHAT, me)).toBe(true);
    expect(await release(main.db, me)).toBe(1);
    expect(await acquireOrRenew(main.db, CHAT, other)).toBe(true);
  });

  it("claim only succeeds once per row", async () => {
    await seed(1);
    const row = await oldestOpen(main.db, CHAT);
    expect(row?.status).toBe("pending");
    const id = row?.id ?? 0;
    expect(await claim(main.db, id, randomUUID())).not.toBeNull();
    expect(await claim(main.db, id, randomUUID())).toBeNull();
  });
});

describe("ordering and takeover", () => {
  it("orders by Telegram update_id, not insertion order", async () => {
    await enqueue(main.db, { update_id: 20, chat_id: CHAT, payload: { n: 20 } });
    await enqueue(main.db, { update_id: 10, chat_id: CHAT, payload: { n: 10 } });
    const handled: number[] = [];
    await processChat({
      db: main.db,
      chatId: CHAT,
      handle: async (p) => void handled.push((p as { n: number }).n),
      sendTyping: noop,
      notifyFailed: noop,
      notifyRetrying: noop,
      deadline: FAR(),
    });
    expect(handled).toEqual([10, 20]);
  });

  it("a second invocation started mid-row gets lease_held; the first handles all rows in order", async () => {
    await seed(3);
    const b = connect();
    const handled: number[] = [];
    let started!: () => void;
    const firstStarted = new Promise<void>((r) => (started = r));
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const a = processChat({
      db: main.db,
      chatId: CHAT,
      handle: async (p) => {
        const n = (p as { n: number }).n;
        handled.push(n);
        if (n === 1000) {
          started();
          await gate;
        }
      },
      sendTyping: noop,
      notifyFailed: noop,
      notifyRetrying: noop,
      deadline: FAR(),
    });
    await firstStarted;
    const sb = await processChat({
      db: b.db,
      chatId: CHAT,
      handle: async () => {
        throw new Error("B must not handle");
      },
      sendTyping: noop,
      notifyFailed: noop,
      notifyRetrying: noop,
      deadline: FAR(),
    });
    expect(sb.stoppedReason).toBe("lease_held");
    open();
    const sa = await a;
    expect(handled).toEqual([1000, 1001, 1002]);
    expect(sa.processed).toBe(3);
  });

  it("after takeover the old holder's release changes 0 rows", async () => {
    await seed(1);
    const b = connect();
    const ownerA = randomUUID();
    let started!: () => void;
    const firstStarted = new Promise<void>((r) => (started = r));
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const a = processChat({
      db: main.db,
      chatId: CHAT,
      owner: ownerA,
      handle: async () => {
        started();
        await gate;
      },
      sendTyping: noop,
      notifyFailed: noop,
      notifyRetrying: noop,
      deadline: FAR(),
    });
    await firstStarted;
    await main.sql`update chat_lease set until = now() - interval '1 second'`;
    const ownerB = randomUUID();
    const sb = await processChat({
      db: b.db,
      chatId: CHAT,
      owner: ownerB,
      handle: noop,
      sendTyping: noop,
      notifyFailed: noop,
      notifyRetrying: noop,
      deadline: FAR(),
    });
    // B took the lease over but the row is still being worked by A.
    expect(sb.stoppedReason).toBe("busy");
    const lease = await main.sql`select owner from chat_lease`;
    expect(lease[0]?.owner).toBe(ownerB);
    expect(await release(main.db, ownerA)).toBe(0);
    open();
    await a;
  });
});

describe("recovery", () => {
  it("resets a row abandoned mid-processing and retries in order", async () => {
    await seed(2);
    // Simulate a crashed holder: claimed, never finished, lease long gone.
    const row = await oldestOpen(main.db, CHAT);
    await claim(main.db, row?.id ?? 0, randomUUID());
    // Fresh claim: a new invocation must back off.
    const handled: number[] = [];
    const deps = {
      db: main.db,
      chatId: CHAT,
      handle: async (p: unknown) => void handled.push((p as { n: number }).n),
      sendTyping: noop,
      notifyFailed: noop,
      notifyRetrying: noop,
      deadline: FAR(),
    };
    expect((await processChat(deps)).stoppedReason).toBe("busy");
    expect(handled).toEqual([]);

    await main.sql`update inbox set claimed_at = now() - interval '151 seconds' where status = 'processing'`;
    await main.sql`update chat_lease set until = now() - interval '1 second'`;
    const summary = await processChat(deps);
    expect(handled).toEqual([1000, 1001]);
    expect(summary.processed).toBe(2);
    expect(await statuses()).toEqual(["1000:done:2", "1001:done:1"]);
  });

  it("resetStuck leaves recent claims alone", async () => {
    await seed(1);
    await claim(main.db, (await oldestOpen(main.db, CHAT))?.id ?? 0, randomUUID());
    expect(await resetStuck(main.db, CHAT)).toEqual([]);
  });
});

describe("failures and deadline", () => {
  it("fails after 3 attempts over 3 runs, notifies once, then processes the next row", async () => {
    await seed(2);
    const handled: number[] = [];
    const notified: number[] = [];
    const deps = {
      db: main.db,
      chatId: CHAT,
      handle: async (p: unknown) => {
        const n = (p as { n: number }).n;
        if (n === 1000) throw new Error("boom secret text");
        handled.push(n);
      },
      sendTyping: noop,
      notifyFailed: async (_c: number, p: unknown) => void notified.push((p as { n: number }).n),
      notifyRetrying: noop,
      deadline: FAR(),
    };
    expect((await processChat(deps)).stoppedReason).toBe("retry_later");
    expect(await statuses()).toEqual(["1000:pending:1", "1001:pending:0"]);
    expect((await processChat(deps)).stoppedReason).toBe("retry_later");
    expect(notified).toEqual([]);
    const last = await processChat(deps);
    expect(notified).toEqual([1000]);
    expect(handled).toEqual([1001]);
    expect(last).toMatchObject({ processed: 1, failed: 1 });
    expect(await statuses()).toEqual(["1000:failed:3", "1001:done:1"]);
    const err = await main.sql`select error from inbox where update_id = 1000`;
    expect(err[0]?.error).toBe("unknown (Error)");
  });

  it("killed invocations cannot bypass the attempt cap", async () => {
    await seed(1);
    const id = (await oldestOpen(main.db, CHAT))?.id ?? 0;
    const kill = async () => {
      expect(await claim(main.db, id, randomUUID())).not.toBeNull();
      await main.sql`update inbox set claimed_at = now() - interval '151 seconds' where id = ${id}`;
      await main.sql`update chat_lease set until = now() - interval '1 second'`;
    };
    // Attempts 1 and 2: reset to pending by the next holder (which then crashes).
    for (let i = 0; i < 2; i += 1) {
      await kill();
      await resetStuck(main.db, CHAT);
    }
    await kill(); // attempt 3, killed too
    let handlerCalls = 0;
    const notified: number[] = [];
    const summary = await processChat({
      db: main.db,
      chatId: CHAT,
      handle: async () => {
        handlerCalls += 1;
      },
      sendTyping: noop,
      notifyFailed: async (_c, p) => void notified.push((p as { n: number }).n),
      notifyRetrying: noop,
      deadline: FAR(),
    });
    expect(handlerCalls).toBe(0);
    expect(notified).toEqual([1000]);
    expect(summary.failed).toBe(1);
    expect(await statuses()).toEqual(["1000:failed:3"]);
    const err = await main.sql`select error, done_at from inbox`;
    expect(err[0]?.error).toBe("timed out");
    expect(err[0]?.done_at).not.toBeNull();
  });

  describe("a claim lost to the stuck-row sweep", () => {
    // Invocation A holds the last attempt of a row and runs past the lease. Invocation B sweeps
    // it to failed (and notifies) before A's handler finishes.
    const interleave = async (aHandlerFails: boolean) => {
      await seed(1);
      await main.sql`update inbox set attempts = 2`;
      const notified: number[] = [];
      const notify = async (_c: number, p: unknown) => void notified.push((p as { n: number }).n);
      let b: Awaited<ReturnType<typeof processChat>> | undefined;
      const a = await processChat({
        db: main.db,
        chatId: CHAT,
        handle: async () => {
          await main.sql`update inbox set claimed_at = now() - interval '151 seconds'`;
          await main.sql`update chat_lease set until = now() - interval '1 second'`;
          b = await processChat({
            db: main.db,
            chatId: CHAT,
            handle: noop,
            sendTyping: noop,
            notifyFailed: notify,
            notifyRetrying: noop,
            deadline: FAR(),
          });
          if (aHandlerFails) throw new Error("late boom");
        },
        sendTyping: noop,
        notifyFailed: notify,
        notifyRetrying: noop,
        deadline: FAR(),
      });
      return { a, b, notified };
    };

    it("one notice when the late handler then throws", async () => {
      const { a, b, notified } = await interleave(true);
      expect(b?.failed).toBe(1);
      expect(a.failed).toBe(0);
      expect(notified).toEqual([1000]);
      expect(await statuses()).toEqual(["1000:failed:3"]);
      const row = await main.sql`select error from inbox`;
      expect(row[0]?.error).toBe("timed out");
    });

    it("a late success does not flip the failed row to done or count as processed", async () => {
      const { a, notified } = await interleave(false);
      expect(a.processed).toBe(0);
      expect(notified).toEqual([1000]);
      expect(await statuses()).toEqual(["1000:failed:3"]);
    });
  });

  it("a failing sendTyping or notifyFailed does not stop the loop", async () => {
    await seed(2);
    const handled: number[] = [];
    const run = () =>
      processChat({
        db: main.db,
        chatId: CHAT,
        handle: async (p) => {
          const n = (p as { n: number }).n;
          if (n === 1000) throw new Error("boom");
          handled.push(n);
        },
        sendTyping: async () => {
          throw new Error("typing down");
        },
        notifyFailed: async () => {
          throw new Error("send down");
        },
        notifyRetrying: noop,
        deadline: FAR(),
      });
    for (let i = 0; i < 3; i += 1) await run();
    expect(handled).toEqual([1001]);
  });

  it("claims nothing once the deadline has passed", async () => {
    await seed(1);
    const summary = await processChat({
      db: main.db,
      chatId: CHAT,
      handle: noop,
      sendTyping: noop,
      notifyFailed: noop,
      notifyRetrying: noop,
      deadline: Date.now() - 1,
    });
    expect(summary).toMatchObject({ processed: 0, stoppedReason: "deadline" });
    expect(await statuses()).toEqual(["1000:pending:0"]);
    // Lease was released.
    expect(await acquireOrRenew(main.db, CHAT, randomUUID())).toBe(true);
  });
});

describe("row level security", () => {
  it("is on for the runtime tables", async () => {
    const rows = await main.sql`
      select relname, relrowsecurity from pg_class
      where relname in ('inbox', 'chat_lease') and relkind = 'r'`;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.relrowsecurity)).toBe(true);
  });
});

describe("invocation deadline and notices", () => {
  const base = {
    db: main.db,
    chatId: CHAT,
    sendTyping: noop,
    notifyFailed: noop,
    notifyRetrying: noop,
    deadline: Number.MAX_SAFE_INTEGER,
  };

  it("a later voice row that cannot fit waits; attempts untouched", async () => {
    await enqueue(main.db, { update_id: 1, chat_id: CHAT, payload: { message: { text: "hi" } } });
    await enqueue(main.db, { update_id: 2, chat_id: CHAT, payload: { message: { voice: {} } } });
    let clock = 0;
    const summary = await processChat({
      ...base,
      startedAt: 0,
      now: () => clock,
      handle: async () => {
        clock = 15_000; // 70 s left < 75 s needed for voice
      },
    });
    expect(summary).toMatchObject({ processed: 1, stoppedReason: "deadline" });
    expect(await statuses()).toEqual(["1:done:1", "2:pending:0"]);
  });

  it("startedAt defaults once per processChat, not per round", async () => {
    await enqueue(main.db, { update_id: 1, chat_id: CHAT, payload: { message: { text: "a" } } });
    await enqueue(main.db, { update_id: 2, chat_id: CHAT, payload: { message: { text: "b" } } });
    let clock = 0;
    const summary = await processChat({
      ...base,
      now: () => clock,
      handle: async () => {
        clock = 50_000; // 35 s left of 85 s: a text row (45 s) no longer fits
      },
    });
    // Round 1 stops on the deadline; the follow-up round must not restart the clock.
    expect(summary).toMatchObject({ processed: 1, stoppedReason: "deadline" });
    expect(await statuses()).toEqual(["1:done:1", "2:pending:0"]);
  });

  it("sweep-failed stuck rows do not count as a handled row", async () => {
    await seed(2);
    await main.sql`update inbox set status = 'processing', attempts = 3, claimed_at = now() - interval '151 seconds' where update_id = 1000`;
    const handled: number[] = [];
    const summary = await processChat({
      ...base,
      startedAt: 0,
      now: () => 80_000, // 5 s left: only the first handled row may run
      handle: async (p) => void handled.push((p as { n: number }).n),
    });
    expect(handled).toEqual([1001]);
    expect(summary.failed).toBe(1);
  });

  it("the first row always runs, even when late", async () => {
    await enqueue(main.db, { update_id: 1, chat_id: CHAT, payload: { message: { voice: {} } } });
    const summary = await processChat({
      ...base,
      startedAt: 0,
      now: () => 12_000,
      handle: noop,
    });
    expect(summary.processed).toBe(1);
  });

  it("stores a classified error without message text", async () => {
    await seed(1);
    const err = Object.assign(new Error("secret text"), { name: "DrizzleQueryError" });
    (err as { cause?: unknown }).cause = Object.assign(new Error("secret text"), {
      name: "PostgresError",
    });
    await processChat({
      ...base,
      handle: async () => {
        throw err;
      },
    });
    const rows = await main.sql`select error from inbox`;
    expect(String(rows[0]?.error).startsWith("db")).toBe(true);
    expect(String(rows[0]?.error)).not.toContain("secret text");
  });

  it("notifies retrying only on attempt 1; failed notice carries the failure", async () => {
    await seed(1);
    const retrying: string[] = [];
    const failed: string[] = [];
    const deps = {
      ...base,
      handle: async () => {
        throw Object.assign(new Error("x"), { name: "PostgresError" });
      },
      notifyRetrying: async (_c: number, f: { kind: string }) => void retrying.push(f.kind),
      notifyFailed: async (_c: number, _p: unknown, f: { kind: string }) =>
        void failed.push(f.kind),
    };
    await processChat(deps);
    expect(retrying).toEqual(["db"]);
    await processChat(deps);
    expect(retrying).toEqual(["db"]);
    await processChat(deps);
    expect(retrying).toEqual(["db"]);
    expect(failed).toEqual(["db"]);
  });

  it("a stuck row failed by the sweep notifies row_timeout", async () => {
    await seed(1);
    await main.sql`update inbox set status = 'processing', attempts = 3, claimed_at = now() - interval '151 seconds'`;
    const failed: string[] = [];
    await processChat({
      ...base,
      handle: noop,
      notifyFailed: async (_c, _p, f) => void failed.push(f.kind),
    });
    expect(failed).toEqual(["row_timeout"]);
  });
});

describe("purgeOldRows", () => {
  it("deletes finished rows older than 30 days, keeps recent and open ones", async () => {
    await seed(4);
    await main.sql`update inbox set status = 'done', received_at = now() - interval '31 days' where update_id = 1000`;
    await main.sql`update inbox set status = 'failed', received_at = now() - interval '31 days' where update_id = 1001`;
    await main.sql`update inbox set status = 'done', received_at = now() - interval '29 days' where update_id = 1002`;
    await main.sql`update inbox set received_at = now() - interval '40 days' where update_id = 1003`;
    expect(await purgeOldRows(main.db, new Date())).toBe(2);
    expect(await statuses()).toEqual(["1002:done:0", "1003:pending:0"]);
  });
});
