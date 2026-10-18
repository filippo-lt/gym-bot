import type { ItemTarget } from "./types.js";

/** /short (SPEC 5.2): hide `Low` items, flag `Medium` as optional. Keyed by plannedItemId. */
export function applyShort(
  items: ItemTarget[],
): Map<number, { hidden?: boolean; optional?: boolean }> {
  const out = new Map<number, { hidden?: boolean; optional?: boolean }>();
  for (const item of items) {
    if (item.priority === "Low") out.set(item.plannedItemId, { hidden: true });
    else if (item.priority === "Medium") out.set(item.plannedItemId, { optional: true });
  }
  return out;
}
