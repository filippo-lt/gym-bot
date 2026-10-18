/**
 * Blackboard photo: one forced `record_board` vision call that reads the class moves.
 * The model only transcribes; the breakdown and every number shown come from code (SPEC §3).
 */
import { z } from "zod";
import { type ClassMove, classMoveSchema } from "../logging/class-moves.js";
import { HEAVY_GROUP_VALUES, type TokenUsage } from "../logging/types.js";
import { tokenUsageOf } from "./budget.js";
import type { IntentModel } from "./model.js";
import { inputSchema } from "./tools.js";

export const BOARD_TIMEOUT_MS = 40_000;
const BOARD_MAX_TOKENS = 2000;

export type HeavyGroup = (typeof HEAVY_GROUP_VALUES)[number];
export type BoardResult =
  | { kind: "board"; moves: ClassMove[]; heavyGroups: HeavyGroup[] }
  | { kind: "not_board" };

const boardInputSchema = z.strictObject({
  is_board: z.boolean(),
  moves: z.array(classMoveSchema).min(1).max(30).optional(),
  heavy_groups_from_caption: z.array(z.enum(HEAVY_GROUP_VALUES)).max(3).optional(),
});

const BOARD_SYSTEM = `You read a photo of a gym class blackboard (or whiteboard) and record it with the record_board tool. Always call record_board.
- If the photo is not a class board with exercises, call it with is_board: false.
- Copy each move's name as written on the board. Do not translate or rename it.
- Tag every move with all the groups it loads: pull, push, legs, core, other.
- sets, reps and duration_s only when written on the board. Never estimate a number that is not there.
- heavy_groups_from_caption: only when the caption explicitly says a group (pull, push or legs) was heavy. Otherwise leave it empty.`;

export async function readBoard(args: {
  model: IntentModel;
  image: Uint8Array;
  caption?: string;
  signal: AbortSignal;
}): Promise<{ result: BoardResult; usage: TokenUsage }> {
  const content: (
    | { type: "image"; source: { type: "base64"; media_type: "image/jpeg"; data: string } }
    | { type: "text"; text: string }
  )[] = [
    {
      type: "image",
      source: {
        type: "base64",
        media_type: "image/jpeg",
        data: Buffer.from(args.image).toString("base64"),
      },
    },
  ];
  if (args.caption?.trim()) content.push({ type: "text", text: `Caption: ${args.caption.trim()}` });

  const res = await args.model.create({
    system: [{ type: "text", text: BOARD_SYSTEM }],
    messages: [{ role: "user", content }],
    tools: [
      {
        name: "record_board",
        description: "Record the class board: its moves, or that the photo is not a board.",
        input_schema: inputSchema(boardInputSchema),
      },
    ],
    tool_choice: { type: "tool", name: "record_board" },
    max_tokens: BOARD_MAX_TOKENS,
    signal: args.signal,
  });
  const usage = tokenUsageOf(args.model.name, res.usage);

  const call = res.content.find((b) => b.type === "tool_use" && b.name === "record_board");
  const parsed = boardInputSchema.safeParse(call && "input" in call ? call.input : undefined);
  if (!parsed.success || !parsed.data.is_board || !parsed.data.moves?.length) {
    return { result: { kind: "not_board" }, usage };
  }
  return {
    result: {
      kind: "board",
      moves: parsed.data.moves,
      heavyGroups: [...new Set(parsed.data.heavy_groups_from_caption ?? [])],
    },
    usage,
  };
}
