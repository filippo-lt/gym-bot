import type {
  EditLastInput,
  GetAlternativesInput,
  GetExerciseHistoryInput,
  GetSessionInput,
  LoggingBackend,
  LogSetsInput,
  PromptContext,
  PromptStatic,
  SaveMemoryInput,
  SkipItemsInput,
  StagedAction,
  TokenUsage,
  UndoLastInput,
  UsageStore,
} from "../../src/logging/types.js";

export function stubLog(input: LogSetsInput): StagedAction {
  return {
    kind: "clarify_exercise",
    input,
    said: input.exercise.said,
    candidates: [],
  };
}

export function fakeBackend(): LoggingBackend & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getSession(_i: GetSessionInput) {
      calls.push("get_session");
      return { facts: { items: [] }, fallbackHtml: "<b>Plan</b>" };
    },
    async getExerciseHistory(i: GetExerciseHistoryInput) {
      calls.push(`history:${i.exercise.said}`);
      return { facts: { found: true, sessions: [] }, fallbackHtml: "<b>History</b>" };
    },
    async getAlternatives(i: GetAlternativesInput) {
      calls.push(`alternatives:${i.exercise.said}`);
      return { facts: { found: true }, fallbackHtml: null };
    },
    async stageSaveMemory(i: SaveMemoryInput) {
      calls.push(`memory:${i.kind}`);
      return { ok: true, action: { kind: "save_memory", input: i }, preview: "staged memory" };
    },
    async stageLogSets(input: LogSetsInput) {
      calls.push(`log_sets:${input.exercise.said}`);
      return { ok: true, action: stubLog(input), preview: `staged ${input.exercise.said}` };
    },
    async stageEdit(_i: EditLastInput) {
      calls.push("edit");
      return { ok: false, error: "nothing to edit" };
    },
    async stageReadiness() {
      return { ok: false, error: "not in this test" };
    },
    async stageBodyweight() {
      return { ok: false, error: "not in this test" };
    },
    async stageClass() {
      return { ok: false, error: "not in this test" };
    },
    async stageBandKg() {
      return { ok: false, error: "not in this test" };
    },
    async stageUndoLast(_i: UndoLastInput) {
      calls.push("undo");
      return { ok: false, error: "nothing to undo" };
    },
    async stageSkip(i: SkipItemsInput) {
      calls.push(i.whole_session ? "skip:all" : `skip:${i.exercise?.said}`);
      return { ok: false, error: "nothing to skip" };
    },
  };
}

export function fakeUsage(totals = { day: 0, month: 0 }): UsageStore & { recorded: TokenUsage[] } {
  const recorded: TokenUsage[] = [];
  return {
    recorded,
    async totals() {
      return totals;
    },
    async record(u) {
      recorded.push(u);
    },
    async weekTotals() {
      return { tokens: 0, sttSeconds: 0 };
    },
    async sttSecondsToday() {
      return 0;
    },
    async recordStt() {},
  };
}

export const promptStatic: PromptStatic = {
  catalog: [
    {
      slug: "squat",
      name: "Squat",
      aliases: ["back squat"],
      type: "weighted",
      loadBasis: "barbell_total",
    },
  ],
  hspuLadder: [{ slug: "pike_push_up", name: "Pike push-up" }],
};

export const promptContext: PromptContext = {
  todayLabel: "Tue 27 Oct 2026 · Week 5 · Strength",
  todayItems: [],
  aliases: [],
  memory: [],
  pending: null,
  lastSaved: [],
  recent: [],
};
