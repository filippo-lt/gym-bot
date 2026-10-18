import type { TopLevelSpec } from "vega-lite";
import { describe, expect, it } from "vitest";
import { FONT_FAMILY, renderPng } from "../../src/charts/render";

const spec: TopLevelSpec = {
  $schema: "https://vega.github.io/schema/vega-lite/v6.json",
  width: 400,
  height: 200,
  config: { font: FONT_FAMILY },
  data: {
    values: [
      { x: 1, y: 60 },
      { x: 2, y: 62.5 },
      { x: 3, y: 65 },
    ],
  },
  mark: { type: "line", point: true },
  encoding: {
    x: { field: "x", type: "quantitative", title: "Session" },
    y: { field: "y", type: "quantitative", title: "kg" },
  },
};

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("renderPng", () => {
  it("renders a PNG at the default width of 1000", async () => {
    const png = await renderPng(spec);
    expect(png.subarray(0, 8).equals(SIGNATURE)).toBe(true);
    expect(png.readUInt32BE(16)).toBe(1000);
  });

  it("honours a custom width", async () => {
    const png = await renderPng(spec, { width: 600 });
    expect(png.readUInt32BE(16)).toBe(600);
  });
});
