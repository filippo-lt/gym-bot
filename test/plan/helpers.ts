import type { ItemSpec, PlanContent, WeekSpec } from "../../src/plan/types.js";
import { addDays } from "../../src/plan-import/build-plan.js";
import type { Weekday } from "../../src/plan-import/types.js";

const pad = (n: number) => String(n).padStart(2, "0");

export function makeItem(
  week: number,
  weekday: Weekday,
  order: number,
  over: Partial<ItemSpec> = {},
): ItemSpec {
  return {
    itemKey: `w${pad(week)}-${weekday}-${pad(order)}-0`,
    week,
    weekday,
    itemOrder: order,
    subItem: 0,
    block: "main",
    planName: `ex-${week}-${weekday}-${order}`,
    variantLabel: null,
    prescriptionRaw: "3x5",
    extrasRaw: null,
    setsMin: 3,
    setsMax: 3,
    repsMin: 5,
    repsMax: 5,
    perSide: false,
    durationSMin: null,
    durationSMax: null,
    hiit: null,
    tempo: null,
    modifiers: [],
    hspuStepId: null,
    rirMin: null,
    rirMax: null,
    tags: [],
    restRaw: "2m",
    priority: "high",
    note: `note-${week}`,
    timeRaw: "10",
    timeMinMin: 10,
    timeMinMax: 10,
    fallbackPrescription: null,
    optionExerciseIds: [100 + order],
    ...over,
  };
}

export function buildContent(): PlanContent {
  const weeks: WeekSpec[] = [];
  const items: ItemSpec[] = [];
  for (let w = 1; w <= 12; w++) {
    const isDeload = w === 4 || w === 8;
    const isTest = w === 12;
    weeks.push({
      week: w,
      phase: isDeload ? "Deload" : isTest ? "Test" : "Build",
      isDeload,
      isTest,
      startDate: addDays("2026-09-28", 7 * (w - 1)),
    });
    for (const wd of ["mon", "tue", "fri"] as const) {
      items.push(makeItem(w, wd, 1), makeItem(w, wd, 2));
    }
  }
  return { weeks, items };
}
