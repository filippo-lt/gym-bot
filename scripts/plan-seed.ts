import "./load-env.js";
import { closeDb, getDb } from "../src/db/client.js";
import { OpenIssuesError, seedPlan } from "../src/db/seed-plan.js";
import {
  applyOverrides,
  buildPlan,
  loadEquipment,
  loadHspuLadder,
  loadOverrides,
  readPlanFile,
} from "../src/plan-import/index.js";

const dryRun = process.argv.includes("--dry-run");

try {
  const plan = buildPlan(readPlanFile("seed/hybrid-strength-plan.json"), {
    equipment: loadEquipment("seed/equipment.json"),
    hspuLadder: loadHspuLadder("seed/hspu-ladder.json"),
  });
  const resolved = applyOverrides(plan, loadOverrides("seed/plan-overrides.json"));

  if (resolved.open_issues.length > 0) {
    console.error(`${resolved.open_issues.length} open issue(s); nothing seeded:`);
    for (const i of resolved.open_issues) console.error(`  - [${i.scope}] ${i.ref}: ${i.detail}`);
    process.exitCode = 1;
  } else {
    const summary = await seedPlan(getDb(), resolved, { dryRun });
    console.log(dryRun ? "Dry run (rolled back):" : "Seed result:");
    console.log(JSON.stringify(summary, null, 2));
    if (summary.action === "unchanged") console.log("Already seeded; plan rows untouched.");
  }
} catch (error) {
  if (error instanceof OpenIssuesError) console.error(error.message);
  else console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await closeDb();
}
