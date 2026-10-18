import type { Weekday } from "../../src/plan-import/types.js";
import type { HeavyGroup, ItemTarget } from "../../src/progression/types.js";
import { sessionFor } from "../bot/helpers.js";

/** Real plan items of a session as engine `ItemTarget`s, with unique plannedItemIds (1-based, in plan order). */
export function targetsFor(week: number, weekday: Weekday, date = "2026-10-26"): ItemTarget[] {
  const s = sessionFor(week, weekday, date);
  return s.items.map((i, idx) => ({
    plannedItemId: idx + 1,
    subItem: i.subItem,
    exerciseIds: i.options.map((_, k) => (idx + 1) * 10 + k),
    setsMin: i.setsMin,
    setsMax: i.setsMax,
    repsMin: i.repsMin,
    repsMax: i.repsMax,
    rirMin: i.rirMin,
    rirMax: i.rirMax,
    modifiers: i.modifiers,
    tags: i.tags,
    priority: i.priority,
    isDeload: s.isDeload,
    isTest: s.isTest,
    hiit: i.hiit,
    fallback: i.fallback,
    hspuStepOrder: null,
    order: i.itemOrder,
    planName: i.planName,
  }));
}

export const byName = (items: ItemTarget[], needle: string): ItemTarget => {
  const f = items.find((i) => i.planName.toLowerCase().includes(needle.toLowerCase()));
  if (!f) throw new Error(`no item ${needle}`);
  return f;
};

export const HEAVY_COMBOS: HeavyGroup[][] = [
  [],
  ["pull"],
  ["push"],
  ["legs"],
  ["pull", "push"],
  ["pull", "legs"],
  ["push", "legs"],
  ["pull", "push", "legs"],
];
