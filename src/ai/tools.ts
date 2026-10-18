import { z } from "zod";
import {
  editLastInputSchema,
  getAlternativesInputSchema,
  getExerciseHistoryInputSchema,
  getSessionInputSchema,
  type LoggingBackend,
  logSetsInputSchema,
  type ReadResult,
  type StagedAction,
  type StageResult,
  saveMemoryInputSchema,
  skipItemsInputSchema,
  undoLastInputSchema,
} from "../logging/types.js";
import type { ToolDef } from "./model.js";

export type ToolName =
  | "get_session"
  | "get_exercise_history"
  | "get_alternatives"
  | "log_sets"
  | "edit_last_entry"
  | "undo_last_entry"
  | "skip_items"
  | "save_memory";

/** Read-only tools: their errors never make a confirm card "partly understood". */
export const READ_TOOLS: readonly string[] = [
  "get_session",
  "get_exercise_history",
  "get_alternatives",
];

function inputSchema(schema: z.ZodType): ToolDef["input_schema"] {
  const json = z.toJSONSchema(schema, { io: "input", target: "draft-7" }) as Record<
    string,
    unknown
  >;
  delete json.$schema;
  return { ...json, type: "object" } as ToolDef["input_schema"];
}

const UNITS = `Units: barbell load_kg is the TOTAL including the bar. Dumbbell load_kg is PER HAND; if the user gives the sum of both dumbbells use pair_total_kg instead. For "bar plus 20 each side" use plates_per_side_kg: 20 (code adds the bar). Pull-ups: added_kg for extra weight, assist_kg for assistance. Machines: the stack value. NEVER compute or convert numbers yourself: pass exactly what the user said.`;

export const TOOLS: ToolDef[] = [
  {
    name: "get_session",
    description:
      "Read-only. Returns the planned session for a day with each item's prescription and what is already logged, plus the next open item. With no day and no date it is today. Pass day or date only when the user named one (day: today, yesterday, tomorrow, mon..sun; date: YYYY-MM-DD). Never both.",
    input_schema: inputSchema(getSessionInputSchema),
  },
  {
    name: "get_exercise_history",
    description:
      "Read-only. Returns the user's logged sessions of ONE exercise, newest first, each with a ready-made 'line' in code-formatted text. Use it for 'what did I do', 'when did I last', 'my history of X'. Give exercise.said (the user's words) and slug only when sure. last_n is how many sessions (default 5, max 10). period (this_week or last_week) or plan_week (1-12) narrows the dates: code turns them into dates, never you. Never both period and plan_week. If the result says found:false, tell the user briefly (ambiguous: name the candidates).",
    input_schema: inputSchema(getExerciseHistoryInputSchema),
  },
  {
    name: "get_alternatives",
    description:
      "Read-only. Returns facts for 'what can I do instead of X': the exercise, its movement tags, where it is planned, other catalog exercises with the same movement pattern, and the user's saved limitations and preferences. Give exercise.said and slug only when sure; 'want' is what the user asked for in their words (e.g. 'machine version').",
    input_schema: inputSchema(getAlternativesInputSchema),
  },
  {
    name: "log_sets",
    description: `Stage the logging of sets for ONE exercise (nothing is saved yet; code decides whether to save or ask the user). Call it once per exercise: two exercises in one message means two calls. ${UNITS} Give exercise.slug only when you are sure, and always give exercise.said (the user's own words). Use "sets" as an array with one object per set, or as a uniform block with count (e.g. 3x8 at 60). If the user gives one RIR for the whole group, put it in "rir" (not on each set). List in guessed_fields anything the user did not say (e.g. "sets" when only reps were said, "reps", "load_kg"). For HSPU pass hspu_step only when the user names the variation. Omit day unless the user named one. Use day "today" only when the user says it was today or rejects an earlier day (then no make-up of an earlier session is proposed); otherwise a weekday only when named. Set clean for pull-ups/HSPU only when the user says it.`,
    input_schema: inputSchema(logSetsInputSchema),
  },
  {
    name: "edit_last_entry",
    description: `Stage a correction to the most recent logged entry (nothing is saved yet). Put only the changed fields in "changes". Use set_indexes (1-based) only when the user refers to specific sets. A bare "rir 3" or "clean" after a log is an edit of the last entry. ${UNITS} List in guessed_fields anything the user did not say.`,
    input_schema: inputSchema(editLastInputSchema),
  },
  {
    name: "undo_last_entry",
    description:
      "Stage the removal of the most recent logged entry (nothing is removed until the user confirms). Use for 'undo', 'delete that', 'remove the last one'.",
    input_schema: inputSchema(undoLastInputSchema),
  },
  {
    name: "skip_items",
    description:
      "Stage marking a planned item of today (or of a named weekday) as skipped, or the whole session (nothing is saved yet; code decides whether to save or ask). Give exercise.said (the user's words) and slug only when sure, or whole_session: true. Use it when the user says they skipped, will skip or won't do an exercise, or today's session. Omit day unless the user named one.",
    input_schema: inputSchema(skipItemsInputSchema),
  },
  {
    name: "save_memory",
    description:
      "Stage remembering a LASTING limitation (injury, sore joint, exercise to avoid) or preference (equipment, exercise variant) the user states about themselves. Nothing is saved until the user confirms. Write content as a short neutral fact (e.g. 'left shoulder sensitive on dips'). Never use it for a one-off feeling or today's condition ('slept badly', 'tired today'): just reply.",
    input_schema: inputSchema(saveMemoryInputSchema),
  },
];

export interface ToolExecution {
  toolResultContent: string;
  isError: boolean;
  staged?: StagedAction;
  /** Set for read tools: the code-formatted answer, used when the reply fails the number guard. */
  read?: { fallbackHtml: string | null };
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.length ? i.path.join(".") : "(input)"}: ${i.message}`)
    .join("; ");
}

function fromStage(result: StageResult): ToolExecution {
  if (!result.ok) return { toolResultContent: result.error, isError: true };
  return { toolResultContent: result.preview, isError: false, staged: result.action };
}

function fromRead(result: ReadResult): ToolExecution {
  return {
    toolResultContent: JSON.stringify(result.facts),
    isError: result.isError === true,
    read: { fallbackHtml: result.fallbackHtml },
  };
}

export async function executeTool(
  name: string,
  rawInput: unknown,
  backend: LoggingBackend,
): Promise<ToolExecution> {
  const invalid = (error: z.ZodError): ToolExecution => ({
    toolResultContent: `Invalid input for ${name}. Fix and call again. ${describeIssues(error)}`,
    isError: true,
  });
  switch (name) {
    case "get_session": {
      const p = getSessionInputSchema.safeParse(rawInput ?? {});
      if (!p.success) return invalid(p.error);
      return fromRead(await backend.getSession(p.data));
    }
    case "get_exercise_history": {
      const p = getExerciseHistoryInputSchema.safeParse(rawInput);
      if (!p.success) return invalid(p.error);
      return fromRead(await backend.getExerciseHistory(p.data));
    }
    case "get_alternatives": {
      const p = getAlternativesInputSchema.safeParse(rawInput);
      if (!p.success) return invalid(p.error);
      return fromRead(await backend.getAlternatives(p.data));
    }
    case "save_memory": {
      const p = saveMemoryInputSchema.safeParse(rawInput);
      if (!p.success) return invalid(p.error);
      return fromStage(await backend.stageSaveMemory(p.data));
    }
    case "log_sets": {
      const p = logSetsInputSchema.safeParse(rawInput);
      if (!p.success) return invalid(p.error);
      return fromStage(await backend.stageLogSets(p.data));
    }
    case "edit_last_entry": {
      const p = editLastInputSchema.safeParse(rawInput);
      if (!p.success) return invalid(p.error);
      return fromStage(await backend.stageEdit(p.data));
    }
    case "undo_last_entry": {
      const p = undoLastInputSchema.safeParse(rawInput ?? {});
      if (!p.success) return invalid(p.error);
      return fromStage(await backend.stageUndoLast(p.data));
    }
    case "skip_items": {
      const p = skipItemsInputSchema.safeParse(rawInput);
      if (!p.success) return invalid(p.error);
      return fromStage(await backend.stageSkip(p.data));
    }
    default:
      return { toolResultContent: `Unknown tool: ${name}`, isError: true };
  }
}
