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
    cb.exercise(ID, 5, 19),
    cb.rir(ID, 4),
    cb.clean(ID, false),
    cb.undoGroup(ID),
    cb.undoEdit(`u:${UPDATE}`, 19),
    cb.undoEdit(`p:${ID}`, 19),
    cb.memory(ID),
    cb.undoWrite(`u:${UPDATE}`, 19),
    cb.readiness("t"),
    cb.classMask(7, "2026-10-01"),
    cb.classSave(7, "2026-10-01"),
    cb.proposal(ID, "ok"),
  ];

  it("is at most 64 bytes", () => {
    for (const data of all)
      expect(Buffer.byteLength(data), data).toBeLessThanOrEqual(CALLBACK_MAX_BYTES);
  });

  it("round-trips", () => {
    expect(parseCallback(cb.pending(7, "ok"))).toEqual({ t: "pa", id: 7, act: "ok" });
    expect(parseCallback(cb.exercise(7, 2, 1))).toEqual({
      t: "ex",
      pendingId: 7,
      index: 2,
      action: 1,
    });
    // buttons sent before the clarify position was encoded
    expect(parseCallback("ex:7:2")).toEqual({ t: "ex", pendingId: 7, index: 2, action: null });
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

describe("M5 callbacks", () => {
  it("round-trips", () => {
    expect(parseCallback(cb.readiness("s"))).toEqual({ t: "rd", level: "s" });
    expect(parseCallback(cb.classMask(5, "2026-10-01"))).toEqual({
      t: "cg",
      mask: 5,
      date: "2026-10-01",
      save: false,
    });
    expect(parseCallback(cb.classSave(5, "2026-10-01"))).toEqual({
      t: "cg",
      mask: 5,
      date: "2026-10-01",
      save: true,
    });
    expect(parseCallback(cb.proposal(12, "no"))).toEqual({ t: "pr", id: 12, act: "no" });
    expect(parseCallback(cb.undoWrite("u:123", 0))).toEqual({ t: "uw", key: "u:123", index: 0 });
    expect(parseCallback(cb.undoWrite("p:9", 2))).toEqual({ t: "uw", key: "p:9", index: 2 });
  });

  it("rejects malformed data", () => {
    for (const bad of [
      "rd:x",
      "rd",
      "cg:8",
      "cg:3:no",
      "cg:a",
      "pr:1",
      "pr:1:ed",
      "uw:x:1",
      "uw:u:1",
    ]) {
      expect(parseCallback(bad), bad).toBeNull();
    }
  });
});
