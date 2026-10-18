import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import * as vega from "vega";
import type { TopLevelSpec } from "vega-lite";
import * as vl from "vega-lite";

/** Family name of the bundled font; put it in the Vega-Lite `config.font`. */
export const FONT_FAMILY = "Inter";

const FONT_PATH = fileURLToPath(
  new URL("../../assets/fonts/Inter_400Regular.ttf", import.meta.url),
);

/** Vega-Lite spec → SVG (Vega headless) → PNG (resvg, bundled font only). */
export async function renderPng(
  spec: TopLevelSpec,
  opts: { width?: number } = {},
): Promise<Buffer> {
  const view = new vega.View(vega.parse(vl.compile(spec).spec), { renderer: "none" });
  const svg = await view.toSVG();
  view.finalize();
  return new Resvg(svg, {
    font: { loadSystemFonts: false, fontFiles: [FONT_PATH], defaultFontFamily: FONT_FAMILY },
    fitTo: { mode: "width", value: opts.width ?? 1000 },
    background: "white",
  })
    .render()
    .asPng();
}
