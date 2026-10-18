import { z } from "zod";
import {
  editLastInputSchema,
  getSessionInputSchema,
  type LoggingBackend,
  logSetsInputSchema,
  type StagedAction,
  type StageResult,
  undoLastInputSchema,
} from "../logging/types.js";
import type { ToolDef } from "./model.js";

export type ToolName = "get_session" | "log_sets" | "edit_last_entry" | "undo_last_entry";

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
      "Read-only. Returns the planned session for a day with each item's prescription and what is already logged. Use it for questions about today's plan or what is done.",
    input_schema: inputSchema(getSessionInputSchema),
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
];

export interface ToolExecution {
  toolResultContent: string;
  isError: boolean;
  staged?: StagedAction;
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
      return {
        toolResultContent: JSON.stringify(await backend.getSession(p.data)),
        isError: false,
      };
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
    default:
      return { toolResultContent: `Unknown tool: ${name}`, isError: true };
  }
}
