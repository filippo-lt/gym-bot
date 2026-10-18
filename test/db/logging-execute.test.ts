import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { appendMessage, recentMessages } from "../../src/logging/conversation.js";
import { executeActions, setGroupClean, setLastSetRir } from "../../src/logging/execute.js";
import { saveAlias } from "../../src/logging/memory.js";
import {
  cancelPending,
  createPending,
  getOpenPending,
  getPending,
  getPendingBySourceUpdate,
  markAwaitingEdit,
  replacePendingActions,
} from "../../src/logging/pending.js";
import { buildPromptContext, buildPromptStatic } from "../../src/logging/prompt-context.js";
import { stageEdit, stageLogSets, stageUndoLast } from "../../src/logging/resolve.js";
import type { LogSetsInput, StagedAction } from "../../src/logging/types.js";
import { createUsageStore } from "../../src/logging/usage.js";
import { connect, exId, MON, resetAndSeed } from "./logging-fixture.js";

const { sql, db } = connect();
afterAll(async () => {
  await sql.end({ timeout: 5 });
});
beforeEach(async () => {
  await resetAndSeed(db, sql);
});

const CHAT = 4242;
const input = (slug: string, said = slug): LogSetsInput => ({
  exercise: { slug, said },
  sets: { count: 2, reps: 6, load_kg: 55 },
  guessed_fields: [],
  needs_confirmation: false,
});

async function stage(slug: string): Promise<StagedAction> {
  const r = await stageLogSets(db, input(slug), MON);
  if (!r.ok) throw new Error(r.error);
  return r.action;
}

const count = async (table: string) =>
  ((await sql.unsafe(`select count(*)::int as n from ${table}`))[0]?.n ?? -1) as number;

describe("write ledger", () => {
  it("returns the stored result on a retry and writes nothing twice", async () => {
    const a = await stage("bench_press");
    const first = await executeActions(db, "u:100", [a], { now: MON });
    const retry = await executeActions(db, "u:100", [a], { now: MON });
    expect(first.status).toBe("done");
    expect(retry).toEqual(first);
    expect(await count("log_groups")).toBe(1);
    expect(await count("log_entries")).toBe(2);
    expect(await count("write_ledger")).toBe(1);
  });

  it("handles concurrent retries of the same key", async () => {
    const a = await stage("bench_press");
    const [x, y] = await Promise.all([
      executeActions(db, "u:101", [a], { now: MON }),
      executeActions(db, "u:101", [a], { now: MON }),
    ]);
    expect(x).toEqual(y);
    expect(await count("log_groups")).toBe(1);
  });

  it("writes two log actions of one message as two groups", async () => {
    const r = await executeActions(
      db,
      "u:102",
      [await stage("bench_press"), await stage("lateral_raise")],
      {
        now: MON,
      },
    );
    expect(r.status === "done" && r.results.map((x) => x.kind)).toEqual(["log", "log"]);
    expect(await count("log_groups")).toBe(2);
    const keys =
      await sql`select action_index from write_ledger where source_key = 'u:102' order by 1`;
    expect(keys.map((k) => k.action_index)).toEqual([0, 1]);
  });

  it("writes all or none when the second action fails", async () => {
    const good = await stage("bench_press");
    const bad = await stage("lateral_raise");
    if (bad.kind !== "log_sets") throw new Error("expected log");
    bad.resolved.exercise = { ...bad.resolved.exercise, id: 999_999 };
    await expect(executeActions(db, "u:103", [good, bad], { now: MON })).rejects.toThrow();
    expect(await count("log_groups")).toBe(0);
    expect(await count("log_entries")).toBe(0);
    expect(await count("session_items")).toBe(0);
    expect(await count("write_ledger")).toBe(0);
  });
});

describe("pending actions", () => {
  let updateIds = 0;
  const make = async (now = new Date(), actions?: StagedAction[]) =>
    createPending(db, {
      chatId: CHAT,
      kind: "confirm",
      actions: actions ?? [await stage("bench_press")],
      reasons: ["guessed"],
      sourceUpdateId: ++updateIds,
      now,
    });

  it("executes once; a repeat returns the stored results", async () => {
    const { pending } = await make();
    const r = await executeActions(db, `p:${pending.id}`, pending.actions, {
      pendingId: pending.id,
      now: MON,
    });
    expect(r.status).toBe("done");
    expect((await getPending(db, pending.id))?.status).toBe("executed");
    const again = await executeActions(db, `p:${pending.id}`, pending.actions, {
      pendingId: pending.id,
      now: MON,
    });
    expect(again).toEqual(r);
    // no ledger rows under another key: nothing to report
    const stranger = await executeActions(db, "p:other", pending.actions, {
      pendingId: pending.id,
      now: MON,
    });
    expect(stranger).toEqual({ status: "expired" });
    expect(await count("log_groups")).toBe(1);
  });

  it("a retry after ✅ gets the ledger results, not 'expired'", async () => {
    const { pending } = await make();
    const key = `p:${pending.id}`;
    const first = await executeActions(db, key, pending.actions, {
      pendingId: pending.id,
      now: MON,
    });
    const again = await executeActions(db, key, pending.actions, {
      pendingId: pending.id,
      now: MON,
    });
    expect(again).toEqual(first);
    expect(first.status).toBe("done");
    expect(await count("log_groups")).toBe(1);
    // a replaced or cancelled request is still expired
    const other = await make();
    await cancelPending(db, other.pending.id);
    expect(
      await executeActions(db, `p:${other.pending.id}`, other.pending.actions, {
        pendingId: other.pending.id,
        now: MON,
      }),
    ).toEqual({ status: "expired" });
  });

  it("reuses the pending request of the same update", async () => {
    const args = {
      chatId: CHAT,
      kind: "confirm" as const,
      actions: [await stage("bench_press")],
      reasons: ["guessed"],
      sourceUpdateId: 900,
      now: new Date(),
    };
    const a = await createPending(db, args);
    const b = await createPending(db, args);
    expect(a.reused).toBe(false);
    expect(b).toMatchObject({ reused: true, replaced: null });
    expect(b.pending.id).toBe(a.pending.id);
    expect((await getPendingBySourceUpdate(db, CHAT, 900))?.id).toBe(a.pending.id);
    expect(await count("pending_actions")).toBe(1);
  });

  it("does nothing for an expired pending action", async () => {
    const { pending } = await make(new Date(Date.now() - 31 * 60_000));
    const r = await executeActions(db, "p:x", pending.actions, {
      pendingId: pending.id,
      now: new Date(),
    });
    expect(r).toEqual({ status: "expired" });
    expect(await count("log_groups")).toBe(0);
    expect(await count("write_ledger")).toBe(0);
  });

  it("replaces an older open one, which can no longer be confirmed", async () => {
    const first = await make();
    const second = await make();
    expect(second.replaced?.id).toBe(first.pending.id);
    expect((await getPending(db, first.pending.id))?.status).toBe("replaced");
    const r = await executeActions(db, "p:old", first.pending.actions, {
      pendingId: first.pending.id,
      now: MON,
    });
    expect(r).toEqual({ status: "expired" });
    expect(await count("log_groups")).toBe(0);
    expect((await getOpenPending(db, CHAT, new Date()))?.id).toBe(second.pending.id);
  });

  it("cancelled pending actions cannot run; expiry is marked on read", async () => {
    const { pending } = await make();
    expect(await cancelPending(db, pending.id)).toBe(true);
    expect(await cancelPending(db, pending.id)).toBe(false);
    expect(
      await executeActions(db, "p:c", pending.actions, { pendingId: pending.id, now: MON }),
    ).toEqual({ status: "expired" });

    const old = await make(new Date(Date.now() - 31 * 60_000));
    expect(await getOpenPending(db, CHAT, new Date())).toBeNull();
    expect((await getPending(db, old.pending.id))?.status).toBe("expired");
  });

  it("tracks awaiting_edit and swaps actions after a clarify", async () => {
    const { pending } = await make();
    expect(await markAwaitingEdit(db, pending.id, new Date())).toBe(true);
    expect((await getOpenPending(db, CHAT, new Date()))?.awaitingEdit).toBe(true);
    const updated = await replacePendingActions(db, pending.id, [await stage("lateral_raise")]);
    expect(updated?.awaitingEdit).toBe(false);
    expect(updated?.actions).toHaveLength(1);
  });
});

describe("pending edge cases", () => {
  const newPending = (actions: StagedAction[], now = new Date()) =>
    createPending(db, {
      chatId: CHAT,
      kind: "confirm",
      actions,
      reasons: ["guessed"],
      sourceUpdateId: null,
      now,
    });

  it("markAwaitingEdit refuses an expired or closed pending (m6)", async () => {
    const stale = await newPending(
      [await stage("bench_press")],
      new Date(Date.now() - 31 * 60_000),
    );
    expect(await markAwaitingEdit(db, stale.pending.id, new Date())).toBe(false);
    const fresh = await newPending([await stage("bench_press")]);
    await cancelPending(db, fresh.pending.id);
    expect(await markAwaitingEdit(db, fresh.pending.id, new Date())).toBe(false);
    expect((await getPending(db, stale.pending.id))?.awaitingEdit).toBe(false);
  });

  it("✅ on an edit whose group is gone: rolled back, pending cancelled, stale (m5)", async () => {
    const r = await executeActions(db, "u:300", [await stage("bench_press")], { now: MON });
    if (r.status !== "done" || r.results[0]?.kind !== "log") throw new Error("expected log");
    const e = await stageEdit(
      db,
      { changes: { load_kg: 60 }, guessed_fields: [], needs_confirmation: false },
      MON,
    );
    if (!e.ok) throw new Error(e.error);
    const { pending } = await newPending([e.action]);
    await sql`delete from log_groups`;
    const out = await executeActions(db, `p:${pending.id}`, pending.actions, {
      pendingId: pending.id,
      now: MON,
    });
    expect(out).toEqual({ status: "stale" });
    expect((await getPending(db, pending.id))?.status).toBe("cancelled");
    expect(await count("write_ledger")).toBe(1); // only the original log
  });

  it("✅ on a delete whose group is gone is stale too (m5)", async () => {
    await executeActions(db, "u:301", [await stage("bench_press")], { now: MON });
    const d = await stageUndoLast(db, MON);
    if (!d.ok) throw new Error(d.error);
    const { pending } = await newPending([d.action]);
    await sql`delete from log_groups`;
    const out = await executeActions(db, `p:${pending.id}`, pending.actions, {
      pendingId: pending.id,
      now: MON,
    });
    expect(out).toEqual({ status: "stale" });
    expect((await getPending(db, pending.id))?.status).toBe("cancelled");
  });

  it("✅ applies only the fields the edit changed (m5)", async () => {
    const r = await executeActions(db, "u:302", [await stage("bench_press")], { now: MON });
    if (r.status !== "done" || r.results[0]?.kind !== "log") throw new Error("expected log");
    const e = await stageEdit(
      db,
      { changes: { load_kg: 60 }, guessed_fields: [], needs_confirmation: false },
      MON,
    );
    if (!e.ok) throw new Error(e.error);
    // A RIR button is tapped between the card and ✅.
    await setLastSetRir(db, r.results[0].groupId, 2, false);
    await executeActions(db, "u:303", [e.action], { now: MON });
    const rows =
      await sql`select load_kg::float8 as l, rir::float8 as r from log_entries order by set_index`;
    expect(rows.map((x) => [x.l, x.r])).toEqual([
      [60, null],
      [60, 2],
    ]);
  });
});

describe("group helpers", () => {
  it("sets RIR on the last set and clean on all sets", async () => {
    const r = await executeActions(db, "u:200", [await stage("bench_press")], { now: MON });
    if (r.status !== "done" || r.results[0]?.kind !== "log") throw new Error("expected log");
    const id = r.results[0].groupId;
    const snap = await setLastSetRir(db, id, 4, true);
    expect(snap?.entries.map((e) => [e.rir, e.rirPlus])).toEqual([
      [null, false],
      [4, true],
    ]);
    const cl = await setGroupClean(db, id, true);
    expect(cl?.entries.every((e) => e.clean === true)).toBe(true);
    expect(await setLastSetRir(db, 99999, 1, false)).toBeNull();
  });
});

describe("usage, conversation, prompt context", () => {
  it("totals day and month in Europe/Rome", async () => {
    const store = createUsageStore(db);
    // 23:30 UTC on 31 Oct is already 1 Nov in Rome (CET).
    await store.record(
      { model: "m", inputTokens: 100, outputTokens: 50, cacheReadTokens: 5, cacheWriteTokens: 0 },
      new Date("2026-10-31T23:30:00Z"),
    );
    await store.record(
      { model: "m", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      new Date("2026-11-01T10:00:00Z"),
    );
    await store.record(
      { model: "m", inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      new Date("2026-10-15T10:00:00Z"),
    );
    expect(await store.totals(new Date("2026-11-01T12:00:00Z"))).toEqual({ day: 165, month: 165 });
    expect(await store.totals(new Date("2026-10-20T12:00:00Z"))).toEqual({ day: 0, month: 1000 });
  });

  it("returns the last 10 messages within 6 h, truncated, oldest first", async () => {
    const now = new Date();
    for (let i = 0; i < 12; i += 1) await appendMessage(db, CHAT, "user", `m${i}`);
    await appendMessage(db, CHAT, "assistant", "x".repeat(900));
    await sql`insert into conversation_messages (chat_id, role, text, created_at) values (${CHAT}, 'user', 'old', now() - interval '7 hours')`;
    await appendMessage(db, CHAT + 1, "user", "other chat");
    const r = await recentMessages(db, CHAT, now);
    expect(r).toHaveLength(10);
    expect(r[0]?.text).toBe("m3");
    expect(r[9]?.text.length).toBe(501);
    expect(r.some((m) => m.text === "old" || m.text === "other chat")).toBe(false);
  });

  it("builds static and dynamic prompt context", async () => {
    const stat = await buildPromptStatic(db);
    expect(stat.catalog.find((c) => c.slug === "face_pull")?.aliases).toEqual(["face pulls"]);
    expect(stat.hspuLadder.map((h) => h.slug)).toContain("hspu_negative");

    await saveAlias(db, "fp", await exId(sql, "face_pull"));
    await createPending(db, {
      chatId: CHAT,
      kind: "confirm",
      actions: [await stage("bench_press")],
      reasons: [],
      sourceUpdateId: null,
      now: new Date(),
    });
    const ctx = await buildPromptContext(db, CHAT, MON);
    expect(ctx.todayLabel).toBe("Mon 28 Sep 2026 · Week 1 · Base");
    expect(ctx.todayItems.length).toBeGreaterThan(5);
    expect(ctx.aliases).toEqual([{ said: "fp", slug: "face_pull", name: "Face pull" }]);
    expect(ctx.pending?.summary).toContain("bench_press");
    const sat = await buildPromptContext(db, CHAT, new Date("2026-10-04T10:00:00Z"));
    expect(sat.todayLabel).toBe("Sun 4 Oct 2026 · rest day");
  });
});
