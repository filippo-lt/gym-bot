import { describe, expect, it } from "vitest";
import { checkNumbers } from "../../src/ai/number-guard.js";

const OK = { ok: true } as const;

describe("checkNumbers", () => {
  const cases: [string, string, string[], string[] | null][] = [
    ["plain integer", "Logged 60 kg", ["weight 60"], null],
    ["dot decimal", "Logged 57.5 kg", ["57.5"], null],
    ["comma decimal in reply", "Logged 12,5 kg", ["12.5"], null],
    ["comma decimal in source", "Logged 12.5 kg", ["12,5"], null],
    ["57.50 vs 57.5", "57.50 kg", ["57.5"], null],
    ["60.0 vs 60", "60.0 kg", ["60"], null],
    ["3x8", "3x8 at 60", ["3 sets 8 reps 60"], null],
    ["3×8", "3×8", ["3 8"], null],
    ["3 x 8", "3 x 8", ["3 8"], null],
    ["5x5x5 chain", "5x5x5", ["5"], null],
    ["range en dash", "8–10 reps", ["8 10"], null],
    ["range hyphen", "8-10 reps", ["8 10"], null],
    ["date slash", "on 26/10", ["26 10"], null],
    ["date dot", "on 26.10", ["26 10"], null],
    ["date iso", "2026-10-26", ["2026 10 26"], null],
    ["Mon 26 Oct", "Mon 26 Oct", ["26"], null],
    ["time", "at 18:00", ["18 0"], null],
    ["ordinals", "the 2nd and 3rd set", ["2 3"], null],
    ["e1RM skipped", "Your e1RM is great", [""], null],
    ["W1b skipped", "see W1b", [""], null],
    ["W5 checked ok", "Week W5", ["5"], null],
    ["W5 checked fails", "Week W5", ["6"], ["5"]],
    ["RIR2", "RIR2", ["2"], null],
    ["plus sign", "+10 kg", ["10"], null],
    ["negative percent", "-10%", ["10"], null],
    ["sign still checks number", "-10%", ["11"], ["10"]],
    ["user message only", "Got it, 62.5", ["no numbers here", "I did 62.5"], null],
    ["hallucinated", "Nice: 62.5 kg", ["60"], ["62.5"]],
    ["empty reply", "", ["60"], null],
    ["no numbers", "Great work!", ["60"], null],
    ["no sources", "Done: 5", [], ["5"]],
    ["emoji around", "💪60kg✅ 🔥8", ["60 8"], null],
    ["unicode letters glued", "é1é", [""], null],
    ["dedup in order", "9 then 7 then 9 then 7 then 60", ["60"], ["9", "7"]],
    ["comma is decimal only", "12,5 kg", ["12 and 5"], ["12,5"]],
    ["60.5 not via sides", "60.5 kg", ["60 kg, 5 reps"], ["60.5"]],
    ["62.5 not via sides", "62.5 kg", ["60 and 5"], ["62.5"]],
    ["60.50 not a date", "60.50", ["60 and 50"], ["60.50"]],
    ["date 26.10 both present", "on 26.10", ["26 Oct", "week 10"], null],
    ["date 26.10 only 26 present", "on 26.10", ["26 Oct"], ["26.10"]],
    ["date 31.13 invalid month", "31.13", ["31 13"], ["31.13"]],
    ["decimal part only is not enough alone", "5.5", ["6"], ["5.5"]],
    ["rounding to 2 decimals", "57.504", ["57.5"], null],
  ];

  it.each(cases)("%s", (_name, reply, sources, unknown) => {
    const r = checkNumbers(reply, sources);
    if (unknown === null) expect(r).toEqual(OK);
    else expect(r).toEqual({ ok: false, unknown });
  });
});

describe("decimals in sources never allow their sides", () => {
  it("rejects 5 reps when the source only has 12.5", () => {
    expect(checkNumbers("You did 5 reps", ["Squat 12.5 kg"])).toEqual({
      ok: false,
      unknown: ["5"],
    });
  });

  it("rejects 60 kg when the source only has 60.5", () => {
    expect(checkNumbers("60 kg", ["60.5 kg"])).toEqual({ ok: false, unknown: ["60"] });
  });
});
