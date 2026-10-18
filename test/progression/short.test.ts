import { describe, expect, it } from "vitest";
import { applyShort } from "../../src/progression/short.js";
import { targetsFor } from "./helpers-session.js";

describe("applyShort", () => {
  it("hides Low, flags Medium optional, leaves the rest alone (Mon W1)", () => {
    const items = targetsFor(1, "mon");
    const out = applyShort(items);
    for (const i of items) {
      const r = out.get(i.plannedItemId);
      if (i.priority === "Low") expect(r).toEqual({ hidden: true });
      else if (i.priority === "Medium") expect(r).toEqual({ optional: true });
      else expect(r).toBeUndefined();
    }
    expect(items.some((i) => i.priority === "Low")).toBe(true);
    expect(items.some((i) => i.priority === "Medium")).toBe(true);
  });

  it("Friday: prehab/accessory hidden, Bulgarian optional, squat kept", () => {
    const items = targetsFor(1, "fri");
    const out = applyShort(items);
    const get = (n: string) =>
      out.get(items.find((i) => i.planName.includes(n))?.plannedItemId ?? -1);
    expect(get("Face pull")).toEqual({ hidden: true });
    expect(get("Bulgarian")).toEqual({ optional: true });
    expect(get("Squat")).toBeUndefined();
  });
});
