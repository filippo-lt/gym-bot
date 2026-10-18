import type {
  EditLastInput,
  GetSessionInput,
  LoggingBackend,
  LogSetsInput,
  PromptContext,
  PromptStatic,
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
      return { items: [] };
    },
    async stageLogSets(input: LogSetsInput) {
      calls.push(`log_sets:${input.exercise.said}`);
      return { ok: true, action: stubLog(input), preview: `staged ${input.exercise.said}` };
    },
    async stageEdit(_i: EditLastInput) {
      calls.push("edit");
      return { ok: false, error: "nothing to edit" };
    },
    async stageUndoLast(_i: UndoLastInput) {
      calls.push("undo");
      return { ok: false, error: "nothing to undo" };
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
  pending: null,
  recent: [],
};
