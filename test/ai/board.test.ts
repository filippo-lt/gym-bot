import { describe, expect, it } from "vitest";
import { readBoard } from "../../src/ai/board.js";
import { createFakeModel, toolUse, turn } from "../../src/ai/fake-model.js";

const run = (script: ReturnType<typeof turn>[]) => {
  const model = createFakeModel(script);
  return {
    model,
    out: readBoard({
      model,
      image: new Uint8Array([1, 2, 3]),
      caption: "legs were heavy",
      signal: new AbortController().signal,
    }),
  };
};

const move = { name: "Squat", sets: 3, reps: 10, groups: ["legs"] };

describe("readBoard", () => {
  it("sends the image and forces record_board", async () => {
    const { model, out } = run([
      turn(
        toolUse("record_board", {
          is_board: true,
          moves: [move],
          heavy_groups_from_caption: ["legs"],
        }),
      ),
    ]);
    const res = await out;
    const req = model.requests[0];
    expect(req?.tool_choice).toEqual({ type: "tool", name: "record_board" });
    const content = req?.messages[0]?.content as { type: string }[];
    expect(content.map((b) => b.type)).toEqual(["image", "text"]);
    expect(res.result).toEqual({ kind: "board", moves: [move], heavyGroups: ["legs"] });
    expect(res.usage.inputTokens).toBe(100);
  });

  it("is_board false -> not_board", async () => {
    const { out } = run([turn(toolUse("record_board", { is_board: false }))]);
    expect((await out).result).toEqual({ kind: "not_board" });
  });

  it("invalid moves -> not_board", async () => {
    const { out } = run([
      turn(toolUse("record_board", { is_board: true, moves: [{ name: "x", groups: ["arms"] }] })),
    ]);
    expect((await out).result).toEqual({ kind: "not_board" });
  });
});
