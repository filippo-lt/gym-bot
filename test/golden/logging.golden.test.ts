import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { runIntent } from "../../src/ai/loop.js";
import { createAnthropicModel, type IntentModel } from "../../src/ai/model.js";
import type {
  EditLastInput,
  LoggingBackend,
  LogSetsInput,
  PromptContext,
  PromptStatic,
  StagedAction,
  UsageStore,
} from "../../src/logging/types.js";
import { CATALOG } from "../../src/plan-import/exercise-catalog.js";

const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);

type Call =
  | { tool: "log_sets"; input: LogSetsInput }
  | { tool: "edit_last_entry"; input: EditLastInput }
  | { tool: "undo_last_entry" }
  | { tool: "get_session" };

function recordingBackend() {
  const calls: Call[] = [];
  const snapshot = {
    groupId: 1,
    sessionDate: "2026-10-27",
    performedAt: "2026-10-27T17:00:00Z",
    exercise: {
      id: 1,
      slug: "bench_press",
      name: "Bench press",
      type: "weighted" as const,
      loadBasis: "barbell_total" as const,
      equipment: null,
    },
    plannedItemId: null,
    hspuStep: null,
    bwKg: null,
    entries: [],
  };
  const backend: LoggingBackend = {
    async getSession() {
      calls.push({ tool: "get_session" });
      return {
        date: "2026-10-27",
        items: [{ name: "Overhead press", prescription: "3 x 5 @ RIR 2", status: "open" }],
      };
    },
    async stageLogSets(input) {
      calls.push({ tool: "log_sets", input });
      const slug = input.exercise.slug;
      const action: StagedAction = slug
        ? ({
            kind: "log_sets",
            input,
            resolved: {
              said: input.exercise.said,
              exercise: {
                id: 1,
                slug,
                name: slug,
                type: "weighted",
                loadBasis: "barbell_total",
                isMainLift: false,
                needsClean: false,
                equipment: null,
              },
              sessionDate: "2026-10-27",
              match: "today",
              plannedItem: null,
              hspuStep: null,
              entries: [],
              bwKg: null,
              note: null,
              missingFields: [],
              guessedFields: input.guessed_fields,
              needsConfirmation: input.needs_confirmation,
              lastSession: null,
            },
          } as StagedAction)
        : { kind: "clarify_exercise", input, said: input.exercise.said, candidates: [] };
      return { ok: true, action, preview: `Staged ${input.exercise.said} for Tue 27 Oct.` };
    },
    async stageEdit(input) {
      calls.push({ tool: "edit_last_entry", input });
      return {
        ok: true,
        action: {
          kind: "edit_group",
          input,
          before: snapshot,
          after: snapshot,
          setIndexes: [1],
          lastSession: null,
        },
        preview: "Staged edit of the last Bench press entry.",
      };
    },
    async stageUndoLast() {
      calls.push({ tool: "undo_last_entry" });
      return {
        ok: true,
        action: { kind: "delete_group", snapshot },
        preview: "Staged removal of the last Bench press entry.",
      };
    },
  };
  return { backend, calls };
}

const ladder = JSON.parse(readFileSync("seed/hspu-ladder.json", "utf8")) as {
  slug: string;
  name: string;
}[];
const promptStatic: PromptStatic = {
  catalog: CATALOG.map((e) => ({
    slug: e.slug,
    name: e.name,
    aliases: e.aliases,
    type: e.type,
    loadBasis: e.load_basis,
  })),
  hspuLadder: ladder.map((l) => ({ slug: l.slug, name: l.name })),
};
const promptContext: PromptContext = {
  todayLabel: "Tue 27 Oct 2026 · Week 5 · Strength",
  todayItems: [
    {
      name: "HSPU progression",
      options: [{ slug: "hspu", name: "HSPU" }],
      prescription: "4 x 3-4",
      status: "open",
    },
    {
      name: "Overhead press",
      options: [{ slug: "overhead_press", name: "Overhead press" }],
      prescription: "3 x 5 @ RIR 2",
      status: "open",
    },
    {
      name: "Bench press",
      options: [{ slug: "bench_press", name: "Bench press" }],
      prescription: "3 x 6-8",
      status: "open",
    },
    {
      name: "Squat or Hack squat",
      options: [
        { slug: "squat", name: "Squat" },
        { slug: "hack_squat", name: "Hack squat" },
      ],
      prescription: "3 x 8",
      status: "open",
    },
    {
      name: "Lateral raise",
      options: [{ slug: "lateral_raise", name: "Lateral raise" }],
      prescription: "3 x 12-15",
      status: "open",
    },
  ],
  aliases: [],
  pending: null,
  lastSaved: [],
  recent: [],
};
const usage: UsageStore = { totals: async () => ({ day: 0, month: 0 }), record: async () => {} };

async function run(text: string) {
  const { backend, calls } = recordingBackend();
  const res = await runIntent({
    text,
    model,
    backend,
    usage,
    promptStatic,
    promptContext,
    now: new Date("2026-10-27T17:00:00Z"),
    dailyTokenCap: Number.POSITIVE_INFINITY,
    monthlyTokenCap: Number.POSITIVE_INFINITY,
  });
  if (res.kind !== "ok") throw new Error("budget");
  return { calls, res };
}

const logs = (calls: Call[]) =>
  calls
    .filter((c): c is Extract<Call, { tool: "log_sets" }> => c.tool === "log_sets")
    .map((c) => c.input);
const uniform = (i: LogSetsInput) => (Array.isArray(i.sets) ? null : i.sets);

let model: IntentModel;
beforeAll(() => {
  if (hasKey) model = createAnthropicModel();
});

describe.skipIf(!hasKey)("golden: logging intents (real API)", () => {
  it("3x8 squat 60 rir 2", async () => {
    const [l, ...rest] = logs((await run("3x8 squat 60 rir 2")).calls);
    expect(rest).toHaveLength(0);
    expect(l?.exercise.slug).toBe("squat");
    const u = l && uniform(l);
    expect(u).toMatchObject({ count: 3, reps: 8, load_kg: 60 });
    const rir = l?.rir ?? u?.rir;
    expect(rir).toBe(2);
  });

  it("15 face pulls with 20 kg", async () => {
    const [l] = logs((await run("15 face pulls with 20 kg")).calls);
    expect(l?.exercise.slug).toBe("face_pull");
    const single = Array.isArray(l?.sets) && l.sets.length === 1;
    expect(single || l?.guessed_fields.includes("sets")).toBe(true);
  });

  it("bench 55 then lateral raises 2x15 6kg", async () => {
    const ls = logs((await run("bench 55 then lateral raises 2x15 6kg")).calls);
    expect(ls.map((l) => l.exercise.slug)).toEqual(["bench_press", "lateral_raise"]);
  });

  it("lateral raise 2x12 with two 6kg dumbbells", async () => {
    const [l] = logs((await run("lateral raise 2x12 with two 6kg dumbbells")).calls);
    const u = l && uniform(l);
    const first = Array.isArray(l?.sets) ? l.sets[0] : u;
    expect(first?.load_kg === 6 || first?.pair_total_kg === 12).toBe(true);
  });

  it("squat 3x6 bar plus 20 each side", async () => {
    const [l] = logs((await run("squat 3x6 bar plus 20 each side")).calls);
    const u = l && uniform(l);
    const first = Array.isArray(l?.sets) ? l.sets[0] : u;
    expect(first?.plates_per_side_kg).toBe(20);
    expect(first?.load_kg).toBeUndefined();
  });

  it("weighted pull-ups 4x3 +10", async () => {
    const [l] = logs((await run("weighted pull-ups 4x3 +10")).calls);
    expect(l?.exercise.slug).toBe("pull_up");
    const u = l && uniform(l);
    const first = Array.isArray(l?.sets) ? l.sets[0] : u;
    expect(first?.added_kg).toBe(10);
  });

  it("no it was 22.5", async () => {
    const { calls } = await run("no it was 22.5");
    const e = calls.find((c) => c.tool === "edit_last_entry");
    expect(e && "input" in e && e.input.changes.load_kg).toBe(22.5);
  });

  it("undo that", async () => {
    const { calls } = await run("undo that");
    expect(calls.map((c) => c.tool)).toContain("undo_last_entry");
  });

  it("fp 2x15 25", async () => {
    const [l] = logs((await run("fp 2x15 25")).calls);
    expect(l?.exercise.said.toLowerCase()).toContain("fp");
  });

  it("what's today?", async () => {
    const { calls } = await run("what's today?");
    expect(calls.map((c) => c.tool)).toContain("get_session");
  });

  it("hack squat 3x8 40", async () => {
    const [l] = logs((await run("hack squat 3x8 40")).calls);
    expect(l?.exercise.slug).toBe("hack_squat");
  });

  it("rir 3", async () => {
    const { calls } = await run("rir 3");
    const e = calls.find((c) => c.tool === "edit_last_entry");
    expect(e && "input" in e && e.input.changes.rir).toBe(3);
  });

  it("pull ups 5 5 4 clean", async () => {
    const [l] = logs((await run("pull ups 5 5 4 clean")).calls);
    expect(l?.exercise.slug).toBe("pull_up");
    expect(Array.isArray(l?.sets) && l.sets.map((s) => s.reps)).toEqual([5, 5, 4]);
    expect(l?.clean).toBe(true);
  });

  it("ohp 3x6 40 last set rir 1", async () => {
    const [l] = logs((await run("ohp 3x6 40 last set rir 1")).calls);
    const sets = l?.sets;
    const lastRir = Array.isArray(sets) ? sets.at(-1)?.rir : undefined;
    expect(l?.rir === 1 || lastRir === 1).toBe(true);
  });

  it("hi", async () => {
    const { calls, res } = await run("hi");
    expect(calls).toHaveLength(0);
    expect(res.replyText).toBeTruthy();
    expect((res.replyText ?? "").length).toBeLessThan(200);
  });
});
