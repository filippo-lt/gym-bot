/**
 * M7 Task 9: the "move the next deload earlier" proposal. Real Postgres, fake Telegram transport.
 * Plan: 12 weeks from Mon 2026-09-28, deloads W4 and W8, test W12 (W6 Monday = 2026-11-02).
 */
import { desc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Transformer } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeModel } from "../../src/ai/fake-model.js";
import { createBot } from "../../src/bot/bot.js";
import * as schema from "../../src/db/schema/index.js";
import { seedPlan } from "../../src/db/seed-plan.js";
import { applyDeloadProposal, ensureDeloadProposal } from "../../src/plan/deload-proposal.js";
import { loadVersionIndex } from "../../src/plan/effective.js";
import { undoPlanChange } from "../../src/plan/undo.js";
import { createVersion, loadLatestContent } from "../../src/plan/versions.js";
import { addDays } from "../../src/plan-import/build-plan.js";
import type { ParsedItem, ResolvedPlan } from "../../src/plan-import/types.js";
import { testDatabaseUrl } from "./constants.js";

const fail = vi.hoisted(() => ({ stale: false }));
vi.mock("../../src/plan/versions.js", async (orig) => {
  const real = await orig<typeof import("../../src/plan/versions.js")>();
  return {
    ...real,
    createVersion: async (...args: Parameters<typeof real.createVersion>) => {
      if (fail.stale) throw new real.StaleBaseVersionError(args[1].baseVersionId);
      return real.createVersion(...args);
    },
  };
});

const sql = postgres(testDatabaseUrl(), { max: 4, prepare: false, onnotice: () => {} });
const db = drizzle(sql, { schema });
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const START = "2026-09-28";
const W6 = "2026-11-02"; // Monday of week 6
const W6_TUE = "2026-11-03";
const W7 = "2026-11-09";
const rome10 = (date: string) => new Date(`${date}T09:00:00Z`);

function item(week: number, weekday: ParsedItem["weekday"], order: number): ParsedItem {
  return {
    key: `w${String(week).padStart(2, "0")}-${weekday}-${String(order).padStart(2, "0")}-0`,
    week,
    weekday,
    order,
    sub_item: 0,
    block: "Main",
    plan_name: "Squat",
    exercise_options: ["squat"],
    variant_label: null,
    prescription_raw: "3 × 5",
    extras_raw: null,
    sets_min: 3,
    sets_max: 3,
    reps_min: 5,
    reps_max: 5,
    per_side: false,
    duration_s_min: null,
    duration_s_max: null,
    hiit: null,
    tempo: null,
    modifiers: [],
    hspu_step: null,
    rir_min: 1,
    rir_max: 2,
    tags: [],
    rest_raw: "1 min",
    priority: "High",
    note: null,
    time_raw: "5 min",
    time_min_min: 5,
    time_min_max: 5,
    fallback_prescription: null,
    flags: [],
  };
}

function fixture(): ResolvedPlan {
  const weeks = Array.from({ length: 12 }, (_, i) => ({
    week: i + 1,
    phase: [4, 8].includes(i + 1) ? "Deload" : i + 1 === 12 ? "Test" : "Base",
    is_deload: [4, 8].includes(i + 1),
    is_test: i + 1 === 12,
    start_date: addDays(START, 7 * i),
  }));
  return {
    open_issues: [],
    resolved_hash: "resolved-deload",
    plan: {
      source_hash: "hash-deload",
      name: "Deload Plan",
      start_date: START,
      weeks_count: 12,
      weeks,
      equipment: [],
      hspu_ladder: [],
      exercises: [
        {
          slug: "squat",
          name: "Squat",
          aliases: [],
          muscle_group: "legs",
          type: "weighted",
          load_basis: "barbell_total",
          equipment_slug: null,
          is_main_lift: true,
          review_note: null,
        },
      ],
      items: weeks.flatMap((w) => [item(w.week, "mon", 0), item(w.week, "tue", 0)]),
    },
  };
}

beforeEach(async () => {
  fail.stale = false;
  await sql`truncate table suggestions, readiness_logs, user_state, proposals, write_ledger, pending_actions, memory_items, conversation_messages, usage_logs, log_entries, log_groups, session_items, class_logs, weekly_metrics, bodyweight_logs, session_overrides, planned_item_options, planned_items, plan_weeks, plan_versions, plans, hspu_ladder, exercises, equipment restart identity cascade`;
  await seedPlan(db, fixture());
});

const proposalRows = () => sql`select * from proposals order by id`;

describe("ensureDeloadProposal", () => {
  it("creates nothing without the trigger", async () => {
    expect(await ensureDeloadProposal(db, W6, null)).toBeNull();
    expect(await proposalRows()).toHaveLength(0);
  });

  it("creates one open proposal with the preview of what the tap will do", async () => {
    const p = await ensureDeloadProposal(db, W6_TUE, "sessions");
    expect(p?.messageId).toBeNull();
    expect(p?.preview).toEqual({
      insertedWeek: 7,
      mondayDate: W7,
      sundayDate: "2026-11-15",
      shiftedFrom: 7,
      shiftedTo: 12,
      droppedWeek: 8,
      keptDeloadWeek: null,
      newWeeks: 12,
      endDate: "2026-12-20",
    });
    const [row] = await proposalRows();
    expect(row?.kind).toBe("earlier_deload");
    expect(row?.status).toBe("open");
    const versionId = (await loadLatestContent(db, 1)).versionId;
    expect(row?.payload).toEqual({
      currentWeek: 6,
      insertAt: 7,
      mondayDate: W7,
      versionId,
      trigger: "sessions",
    });
  });

  it("an open proposal is returned again (not duplicated) with its message id", async () => {
    const first = await ensureDeloadProposal(db, W6, "sessions");
    await sql`update proposals set message_id = 77`;
    const again = await ensureDeloadProposal(db, W6_TUE, "sessions");
    expect(again?.id).toBe(first?.id);
    expect(again?.messageId).toBe(77);
    expect(await proposalRows()).toHaveLength(1);
  });

  it("is not proposed when next week is a deload or the test week, or nothing follows it", async () => {
    expect(await ensureDeloadProposal(db, "2026-10-14", "sessions")).toBeNull(); // W3 -> W4 deload
    expect(await ensureDeloadProposal(db, "2026-12-07", "sessions")).toBeNull(); // W11 -> W12 test
    expect(await ensureDeloadProposal(db, "2026-12-14", "sessions")).toBeNull(); // W12: no next week
    expect(await ensureDeloadProposal(db, "2026-09-20", "sessions")).toBeNull(); // before the plan
  });

  it("is asked once until the trigger resets: declined stays declined", async () => {
    const first = await ensureDeloadProposal(db, W6, "sessions");
    await sql`update proposals set status = 'declined', decided_at = now()`;
    expect(await ensureDeloadProposal(db, W6_TUE, "sessions")).toBeNull();
    expect(first).not.toBeNull();
    expect(await proposalRows()).toHaveLength(1);
  });

  it("a non-RED frozen session level after the proposal re-arms it", async () => {
    await ensureDeloadProposal(db, W6, "sessions");
    await sql`update proposals set status = 'declined', decided_at = now()`;
    await sql`insert into readiness_logs (date, at, kind, source, level)
      values (${W6_TUE}, now(), 'button_ok', 'derived', 'GREEN')`;
    const again = await ensureDeloadProposal(db, "2026-11-04", "sessions");
    expect(again).not.toBeNull();
    expect(await proposalRows()).toHaveLength(2);
  });

  it("after a GREEN session and two new REDs it is asked again", async () => {
    await ensureDeloadProposal(db, W6, "sessions");
    await sql`update proposals set status = 'declined', decided_at = now()`;
    await sql`insert into readiness_logs (date, at, kind, source, level) values
      (${W6_TUE}, now(), 'button_ok', 'derived', 'GREEN'),
      ('2026-11-04', now(), 'button_tired', 'derived', 'RED'),
      ('2026-11-05', now(), 'button_tired', 'derived', 'RED')`;
    const again = await ensureDeloadProposal(db, "2026-11-05", "sessions");
    expect(again?.id).toBe(2);
    expect(await proposalRows()).toHaveLength(2);
  });

  it("a RED level alone does not re-arm it", async () => {
    await ensureDeloadProposal(db, W6, "sessions");
    await sql`update proposals set status = 'declined', decided_at = now()`;
    await sql`insert into readiness_logs (date, at, kind, source, level)
      values (${W6_TUE}, now(), 'button_tired', 'derived', 'RED')`;
    expect(await ensureDeloadProposal(db, "2026-11-04", "sessions")).toBeNull();
  });

  it("a weekly recovery score above 2 re-arms it", async () => {
    await ensureDeloadProposal(db, W6, "sessions");
    await sql`update proposals set status = 'declined', decided_at = now()`;
    await sql`insert into weekly_metrics (plan_week, metric, value_num, source)
      values (6, 'recovery', 4, 'bot')`;
    expect(await ensureDeloadProposal(db, "2026-11-04", "sessions")).not.toBeNull();
  });

  it("a new proposal expires an older open one", async () => {
    const first = await ensureDeloadProposal(db, W6, "sessions");
    await sql`insert into readiness_logs (date, at, kind, source, level)
      values (${W6_TUE}, now(), 'button_ok', 'derived', 'GREEN')`;
    const second = await ensureDeloadProposal(db, "2026-11-04", "sessions");
    expect(second?.id).not.toBe(first?.id);
    expect((await proposalRows()).map((r) => r.status)).toEqual(["expired", "open"]);
  });

  it("an open proposal whose Monday arrived is expired", async () => {
    await ensureDeloadProposal(db, W6, "sessions");
    expect(await ensureDeloadProposal(db, W7, null)).toBeNull();
    expect((await proposalRows())[0]?.status).toBe("expired");
  });
});

describe("applyDeloadProposal", () => {
  async function propose(today = W6_TUE) {
    const p = await ensureDeloadProposal(db, today, "sessions");
    if (!p) throw new Error("no proposal");
    return p.id;
  }
  const apply = (id: number, today: string) =>
    db.transaction((tx) => applyDeloadProposal(tx, id, today));

  it("creates the version from next Monday, marks accepted and writes the ledger row", async () => {
    const id = await propose();
    const r = await apply(id, W6_TUE);
    expect(r.ok).toBe(true);
    const versions = await sql`select * from plan_versions order by version`;
    expect(versions).toHaveLength(2);
    expect(versions[1]?.effective_from).toBe(W7);
    expect(versions[1]?.change).toEqual({
      kind: "deload_earlier",
      insertedWeek: 7,
      droppedWeek: 8,
    });
    expect((await proposalRows())[0]?.status).toBe("accepted");
    const [ledger] = await sql`select * from write_ledger where source_key = ${`r:${id}`}`;
    expect(ledger?.action_index).toBe(0);
    expect(ledger?.result).toEqual({
      kind: "plan_change",
      overrideIds: [],
      versionId: r.ok ? r.versionId : -1,
      createdExerciseId: null,
    });
    const idx = await loadVersionIndex(db);
    expect(idx.weekOf("2026-11-09")?.isDeload).toBe(true);
    expect(idx.weekOf("2026-11-02")?.week).toBe(6);
  });

  it("Undo removes the version and declines the proposal", async () => {
    const id = await propose();
    await apply(id, W6_TUE);
    const out = await db.transaction((tx) => undoPlanChange(tx, `r:${id}`, 0));
    expect(out).toEqual({ ok: true });
    expect(await sql`select id from plan_versions`).toHaveLength(1);
    expect((await proposalRows())[0]?.status).toBe("declined");
  });

  it("refuses on or after the Monday: expired, nothing changed", async () => {
    const id = await propose();
    expect(await apply(id, W7)).toEqual({
      ok: false,
      reason: "closed",
      reply: "This offer is closed; nothing changed.",
    });
    expect(await sql`select id from plan_versions`).toHaveLength(1);
    expect((await proposalRows())[0]?.status).toBe("expired");
  });

  it("refuses when another version was created after the proposal", async () => {
    const id = await propose();
    const latest = await loadLatestContent(db, 1);
    await db.transaction((tx) =>
      createVersion(tx, {
        planId: 1,
        baseVersionId: latest.versionId,
        content: latest.content,
        effectiveFrom: "2026-11-10",
        reason: "other",
        change: { kind: "deload_earlier", insertedWeek: 9, droppedWeek: null },
      }),
    );
    expect(await apply(id, W6_TUE)).toEqual({
      ok: false,
      reason: "closed",
      reply: "This offer is closed; nothing changed.",
    });
    expect(await sql`select id from plan_versions`).toHaveLength(2);
    expect((await proposalRows())[0]?.status).toBe("expired");
  });

  it("a second ✅ does nothing", async () => {
    const id = await propose();
    await apply(id, W6_TUE);
    const again = await apply(id, W6_TUE);
    expect(again).toMatchObject({ ok: false, reason: "decided" });
    expect(await sql`select id from plan_versions`).toHaveLength(2);
  });

  it("accepting in W5 keeps the W8 deload: 13 weeks", async () => {
    const id = await propose("2026-10-27"); // W5 Tuesday
    expect(await apply(id, "2026-10-27")).toMatchObject({ ok: true });
    const [last] = await sql`
      select count(*)::int as n from plan_weeks
      where plan_version_id = (select id from plan_versions order by version desc limit 1)`;
    expect(last?.n).toBe(13);
    const top = await db
      .select()
      .from(schema.planVersions)
      .orderBy(desc(schema.planVersions.version))
      .limit(1);
    expect(top[0]?.change).toEqual({ kind: "deload_earlier", insertedWeek: 6, droppedWeek: null });
  });
});

describe("/today card", () => {
  const botInfo: UserFromGetMe = {
    id: 1,
    is_bot: true,
    first_name: "GymBot",
    username: "gymbot",
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  };
  const CHAT = { id: 42, type: "private" as const, first_name: "F" };
  const FROM = { id: 42, is_bot: false, first_name: "F" };

  let clock = rome10(W6);
  function setup() {
    const calls: { method: string; payload: Record<string, unknown> }[] = [];
    let mid = 1000;
    const transformer: Transformer = async (_p, method, payload) => {
      calls.push({ method, payload: payload as Record<string, unknown> });
      if (method === "sendMessage") {
        return {
          ok: true,
          result: { message_id: ++mid, date: 0, chat: CHAT, text: "x" },
        } as never;
      }
      return { ok: true, result: true } as never;
    };
    const bot = createBot({
      db,
      now: () => clock,
      token: "123:abc",
      botInfo,
      transformer,
      ai: { model: createFakeModel([]), dailyTokenCap: 1_000_000, monthlyTokenCap: 10_000_000 },
    });
    let uid = 5000;
    const say = (body: string) =>
      bot.handleUpdate({
        update_id: ++uid,
        message: {
          message_id: uid,
          date: 0,
          chat: CHAT,
          from: FROM,
          text: body,
          entities: [{ type: "bot_command", offset: 0, length: body.length }],
        },
      });
    const tap = (data: string) =>
      bot.handleUpdate({
        update_id: ++uid,
        callback_query: {
          id: `cb${uid}`,
          chat_instance: "x",
          from: FROM,
          message: { message_id: 1, date: 0, chat: CHAT },
          data,
        },
      });
    const sent = () => calls.filter((c) => c.method === "sendMessage");
    const cards = () => sent().filter((c) => String(c.payload.text).includes("Move the deload"));
    const buttons = (c: { payload: Record<string, unknown> } | undefined) =>
      (
        (
          c?.payload.reply_markup as {
            inline_keyboard?: { text: string; callback_data: string }[][];
          }
        )?.inline_keyboard ?? []
      )
        .flat()
        .map((b) => ({ text: b.text, data: b.callback_data }));
    const lastEdit = () => calls.filter((c) => c.method === "editMessageText").at(-1);
    return { say, tap, sent, cards, buttons, lastEdit };
  }

  /** Last session (Fri 30 Oct) and today (Mon 2 Nov) both frozen RED. */
  async function twoReds() {
    const [ex] = await sql`select id from exercises where slug = 'squat'`;
    await sql`insert into log_groups (session_date, performed_at, exercise_id, source, bw_kg)
      values ('2026-10-30', '2026-10-30T08:00:00Z', ${ex?.id}, 'text', 70)`;
    await sql`insert into readiness_logs (date, at, kind, source, level) values
      ('2026-10-30', '2026-10-30T08:00:00Z', 'button_tired', 'derived', 'RED'),
      (${W6}, ${rome10(W6).toISOString()}, 'button_tired', 'derived', 'RED')`;
  }

  beforeEach(() => {
    clock = rome10(W6);
  });

  it("sends the card once as its own message, ✅ moves the deload, Undo restores", async () => {
    await twoReds();
    const t = setup();
    await t.say("/today");
    expect(t.cards()).toHaveLength(1);
    const card = t.cards()[0];
    expect(String(card?.payload.text)).toBe(
      "You've been tired 2 sessions in a row. Move the deload earlier? Next week (W7, 9–15 Nov) becomes a deload, weeks 7–12 move one week later. The W8 deload is dropped (it would be only 2 weeks after). The plan still ends Sun 20 Dec.",
    );
    expect(String(t.sent()[0]?.payload.text)).not.toContain("Move the deload");
    const [ok, no] = t.buttons(card);
    expect(ok?.data).toMatch(/^pr:\d+:ok$/);
    expect(no?.data).toMatch(/^pr:\d+:no$/);

    await t.say("/today");
    expect(t.cards()).toHaveLength(1);

    await t.tap(ok?.data as string);
    const edit = t.lastEdit();
    expect(String(edit?.payload.text)).toContain("W7");
    const undo = t.buttons(edit)[0];
    expect(undo?.data).toMatch(/^up:r:\d+:0$/);
    expect(await sql`select id from plan_versions`).toHaveLength(2);

    await t.tap(undo?.data as string);
    expect(await sql`select id from plan_versions`).toHaveLength(1);
    expect((await proposalRows())[0]?.status).toBe("declined");
  });

  it("❌ declines and the card does not come back that week", async () => {
    await twoReds();
    const t = setup();
    await t.say("/today");
    const no = t.buttons(t.cards()[0])[1]?.data as string;
    await t.tap(no);
    expect((await proposalRows())[0]?.status).toBe("declined");
    await t.say("/today");
    expect(t.cards()).toHaveLength(1);
  });

  it("a recovery trigger uses the recovery lead-in", async () => {
    await sql`insert into weekly_metrics (plan_week, metric, value_num, source) values
      (4, 'recovery', 2, 'bot'), (5, 'recovery', 1, 'bot')`;
    const [ex] = await sql`select id from exercises where slug = 'squat'`;
    await sql`insert into log_groups (session_date, performed_at, exercise_id, source, bw_kg)
      values ('2026-10-30', '2026-10-30T08:00:00Z', ${ex?.id}, 'text', 70)`;
    const t = setup();
    await t.say("/today");
    expect(String(t.cards()[0]?.payload.text)).toMatch(
      /^Your recovery score was 2 or lower two weeks in a row\. Move the deload earlier\?/,
    );
    const [row] = await proposalRows();
    expect(row?.payload).toMatchObject({ trigger: "recovery" });
  });

  it("a lost version race closes the offer and does not promise to ask again", async () => {
    await twoReds();
    const t = setup();
    await t.say("/today");
    const ok = t.buttons(t.cards()[0])[0]?.data as string;
    fail.stale = true;
    await t.tap(ok);
    expect(String(t.lastEdit()?.payload.text)).toBe("This offer is closed; nothing changed.");
    expect((await proposalRows())[0]?.status).toBe("expired");
    expect(await sql`select id from plan_versions`).toHaveLength(1);
  });

  it("✅ and ❌ on an offer the Monday sweep expired say it is closed", async () => {
    await twoReds();
    const t = setup();
    await t.say("/today");
    const [ok, no] = t.buttons(t.cards()[0]);
    clock = rome10(W7);
    await t.say("/today");
    expect((await proposalRows())[0]?.status).toBe("expired");
    await t.tap(ok?.data as string);
    expect(String(t.lastEdit()?.payload.text)).toBe("This offer is closed; nothing changed.");
    expect(t.buttons(t.lastEdit())).toEqual([]);
    await t.tap(no?.data as string);
    expect(String(t.lastEdit()?.payload.text)).toBe("This offer is closed; nothing changed.");
    expect(await sql`select id from plan_versions`).toHaveLength(1);
  });

  it("✅ after the Monday says it expired", async () => {
    await twoReds();
    const t = setup();
    await t.say("/today");
    const ok = t.buttons(t.cards()[0])[0]?.data as string;
    clock = rome10(W7);
    await t.tap(ok);
    expect(String(t.lastEdit()?.payload.text)).toBe("This offer is closed; nothing changed.");
    expect(await sql`select id from plan_versions`).toHaveLength(1);
  });
});
