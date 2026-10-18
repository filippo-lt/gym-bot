import { describe, expect, it } from "vitest";
import { CALLBACK_MAX_BYTES, cb, parseCallback } from "../../src/bot/callbacks.js";

// Worst-case ids: Postgres int4 for rows, a long Telegram update id for source keys.
const ID = 2_147_483_647;
const UPDATE = 999_999_999_999_999;

describe("callback data", () => {
  const all = [
    cb.pending(ID, "ok"),
    cb.pending(ID, "ed"),
    cb.pending(ID, "no"),
    cb.exercise(ID, 5),
    cb.rir(ID, 4),
    cb.clean(ID, false),
    cb.undoGroup(ID),
    cb.undoEdit(`u:${UPDATE}`, 19),
    cb.undoEdit(`p:${ID}`, 19),
    cb.memory(ID),
  ];

  it("is at most 64 bytes", () => {
    for (const data of all)
      expect(Buffer.byteLength(data), data).toBeLessThanOrEqual(CALLBACK_MAX_BYTES);
  });

  it("round-trips", () => {
    expect(parseCallback(cb.pending(7, "ok"))).toEqual({ t: "pa", id: 7, act: "ok" });
    expect(parseCallback(cb.exercise(7, 2))).toEqual({ t: "ex", pendingId: 7, index: 2 });
    expect(parseCallback(cb.rir(9, 4))).toEqual({ t: "rir", groupId: 9, value: 4 });
    expect(parseCallback(cb.clean(9, false))).toEqual({ t: "cl", groupId: 9, clean: false });
    expect(parseCallback(cb.undoGroup(9))).toEqual({ t: "ug", groupId: 9 });
    expect(parseCallback(cb.undoEdit("u:123", 1))).toEqual({ t: "ue", key: "u:123", index: 1 });
    expect(parseCallback(cb.undoEdit("p:5", 0))).toEqual({ t: "ue", key: "p:5", index: 0 });
    expect(parseCallback(cb.memory(3))).toEqual({ t: "md", id: 3 });
  });

  it("rejects junk", () => {
    for (const bad of [
      "",
      "noop",
      "pa:1",
      "pa:x:ok",
      "pa:1:zz",
      "rir:1:5",
      "cl:1:2",
      "ue:x:1",
      "ug:1:2",
    ]) {
      expect(parseCallback(bad), bad).toBeNull();
    }
  });
});
