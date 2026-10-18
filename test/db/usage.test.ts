import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { countedTokens } from "../../src/ai/budget.js";
import { createUsageStore } from "../../src/logging/usage.js";
import { connect } from "./logging-fixture.js";

const { sql, db } = connect();
afterAll(async () => {
  await sql.end({ timeout: 5 });
});
beforeEach(async () => {
  await sql`truncate table usage_logs restart identity`;
});

type Row = { date: string; i: number; o: number; cr: number; cw: number; stt?: number };
async function insert(rows: Row[]) {
  for (const r of rows) {
    await sql`insert into usage_logs (date, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, stt_seconds)
      values (${r.date}, 'm', ${r.i}, ${r.o}, ${r.cr}, ${r.cw}, ${r.stt ?? 0})`;
  }
}
const counted = (r: Row) =>
  countedTokens({
    inputTokens: r.i,
    outputTokens: r.o,
    cacheReadTokens: r.cr,
    cacheWriteTokens: r.cw,
  });

describe("usage store", () => {
  it("totals count cache tokens with weights", async () => {
    const rows: Row[] = [
      { date: "2026-10-19", i: 100, o: 50, cr: 1000, cw: 20 },
      { date: "2026-10-19", i: 10, o: 5, cr: 300, cw: 0 },
      { date: "2026-10-05", i: 200, o: 100, cr: 0, cw: 40 },
      { date: "2026-09-30", i: 999, o: 999, cr: 999, cw: 999 },
    ];
    await insert(rows);
    const t = await createUsageStore(db).totals(new Date("2026-10-19T10:00:00Z"));
    expect(t.day).toBeCloseTo(counted(rows[0] as Row) + counted(rows[1] as Row), 6);
    expect(t.month).toBeCloseTo(
      counted(rows[0] as Row) + counted(rows[1] as Row) + counted(rows[2] as Row),
      6,
    );
  });

  it("weekTotals covers the Rome Mon-Sun week, Sunday night included", async () => {
    const rows: Row[] = [
      { date: "2026-10-18", i: 1, o: 1, cr: 0, cw: 0, stt: 7 }, // Sunday before
      { date: "2026-10-19", i: 100, o: 50, cr: 1000, cw: 20, stt: 60 }, // Monday
      { date: "2026-10-25", i: 10, o: 5, cr: 300, cw: 8, stt: 30 }, // Sunday
      { date: "2026-10-26", i: 5, o: 5, cr: 0, cw: 0, stt: 9 }, // next Monday
    ];
    await insert(rows);
    const store = createUsageStore(db);
    const expected = counted(rows[1] as Row) + counted(rows[2] as Row);
    // Sunday 23:59 Rome (CET, UTC+1) and Monday 00:00 Rome are in the same week.
    for (const now of ["2026-10-19T00:00:00+01:00", "2026-10-25T23:59:00+01:00"]) {
      const w = await store.weekTotals(new Date(now));
      expect(w.tokens).toBeCloseTo(expected, 6);
      expect(w.sttSeconds).toBe(90);
    }
  });

  it("weekTotals is zero with no rows", async () => {
    expect(await createUsageStore(db).weekTotals(new Date("2026-10-19T10:00:00Z"))).toEqual({
      tokens: 0,
      sttSeconds: 0,
    });
  });
});
