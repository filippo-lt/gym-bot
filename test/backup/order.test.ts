import { describe, expect, it } from "vitest";
import { type CatalogTable, restoreOrder } from "../../src/backup/catalog.js";

const t = (name: string, dependsOn: string[] = []): CatalogTable => ({
  name,
  columns: ["id"],
  primaryKey: ["id"],
  dependsOn,
  sequences: [],
});

describe("restoreOrder", () => {
  it("puts parents before children", () => {
    const names = restoreOrder([t("c", ["b"]), t("b", ["a"]), t("a")]).map((x) => x.name);
    expect(names).toEqual(["a", "b", "c"]);
  });

  it("ignores self references", () => {
    expect(restoreOrder([t("a", ["a"])]).map((x) => x.name)).toEqual(["a"]);
  });

  it("ignores parents that are not in the list", () => {
    expect(restoreOrder([t("a", ["gone"])]).map((x) => x.name)).toEqual(["a"]);
  });

  it("is stable by name among independent tables", () => {
    expect(restoreOrder([t("z"), t("m"), t("a")]).map((x) => x.name)).toEqual(["a", "m", "z"]);
  });

  it("throws on a cycle", () => {
    expect(() => restoreOrder([t("a", ["b"]), t("b", ["a"])])).toThrow(/cycle/i);
  });
});
