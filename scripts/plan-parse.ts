import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyOverrides,
  buildPlan,
  loadEquipment,
  loadHspuLadder,
  loadOverrides,
  readPlanFile,
  renderReview,
} from "../src/plan-import/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const p = (...parts: string[]) => resolve(root, ...parts);

const raw = readPlanFile(p("seed/hybrid-strength-plan.json"));
const plan = buildPlan(raw, {
  equipment: loadEquipment(p("seed/equipment.json")),
  hspuLadder: loadHspuLadder(p("seed/hspu-ladder.json")),
});

const overridesPath = p("seed/plan-overrides.json");
if (!existsSync(overridesPath)) {
  writeFileSync(
    overridesPath,
    `${JSON.stringify({ source_hash: plan.source_hash, items: {} }, null, 2)}\n`,
  );
  console.log("Created seed/plan-overrides.json");
}

const resolved = applyOverrides(plan, loadOverrides(overridesPath));
const review = renderReview(resolved);

mkdirSync(p("seed/review"), { recursive: true });
writeFileSync(p("seed/plan.parsed.json"), `${JSON.stringify(resolved.plan, null, 2)}\n`);
writeFileSync(p("seed/review/plan-review.md"), review.markdown);
writeFileSync(p("seed/review/plan-review.csv"), review.csv);

const byScope = new Map<string, number>();
for (const i of resolved.open_issues) byScope.set(i.scope, (byScope.get(i.scope) ?? 0) + 1);
console.log(
  `Weeks: ${plan.weeks_count}, items: ${plan.items.length}, exercises: ${resolved.plan.exercises.length}`,
);
console.log(`Resolved hash: ${resolved.resolved_hash}`);
console.log(
  `Open issues: ${resolved.open_issues.length} (${[...byScope].map(([k, v]) => `${k}: ${v}`).join(", ") || "none"})`,
);
