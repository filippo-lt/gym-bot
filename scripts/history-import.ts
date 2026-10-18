import "./load-env.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { closeDb, getDb } from "../src/db/client.js";
import { HistoryOpenIssuesError, importHistory } from "../src/db/import-history.js";
import {
  buildHistoryImport,
  ensureOverridesFile,
  hashExport,
  renderHistoryReview,
} from "../src/history-import/index.js";
import {
  applyOverrides,
  buildPlan,
  loadEquipment,
  loadHspuLadder,
  loadOverrides,
  readPlanFile,
} from "../src/plan-import/index.js";

const EXPORT_PATH = "import/hybrid-strength-progress.json";
const OVERRIDES_PATH = "import/history-overrides.json";
const REVIEW_PATH = "import/history-review.md";

const reviewOnly = process.argv.includes("--review");
const dryRun = process.argv.includes("--dry-run");

try {
  if (!existsSync(EXPORT_PATH)) throw new Error(`Missing ${EXPORT_PATH}`);
  const exportJson = readFileSync(EXPORT_PATH, "utf8");
  if (ensureOverridesFile(OVERRIDES_PATH, hashExport(exportJson)))
    console.log(`Created ${OVERRIDES_PATH} with defaults. Check it.`);
  let overrides: unknown;
  try {
    overrides = JSON.parse(readFileSync(OVERRIDES_PATH, "utf8"));
  } catch {
    throw new Error(`${OVERRIDES_PATH} is not valid JSON.`);
  }

  const equipment = loadEquipment("seed/equipment.json");
  const plan = buildPlan(readPlanFile("seed/hybrid-strength-plan.json"), {
    equipment,
    hspuLadder: loadHspuLadder("seed/hspu-ladder.json"),
  });
  const resolved = applyOverrides(plan, loadOverrides("seed/plan-overrides.json"));
  if (resolved.open_issues.length > 0)
    throw new Error(`Plan has ${resolved.open_issues.length} open issue(s); fix the plan first.`);

  const result = buildHistoryImport(exportJson, resolved, equipment, overrides);
  writeFileSync(REVIEW_PATH, renderHistoryReview(result));
  console.log(`Wrote ${REVIEW_PATH}`);
  console.log(
    `Session items ${result.session_items.length}, log groups ${result.log_groups.length}, class logs ${result.class_logs.length}, weekly values ${result.weekly_metrics.length}`,
  );
  console.log(`Open issues: ${result.open_issues.length}`);
  for (const i of result.open_issues) console.log(`  - ${i.ref}: ${i.detail}`);

  if (!reviewOnly) {
    const summary = await importHistory(getDb(), result, {
      planName: resolved.plan.name,
      equipment,
      dryRun,
    });
    console.log(dryRun ? "Dry run (rolled back):" : "Import result:");
    console.log(JSON.stringify(summary, null, 2));
  } else if (result.open_issues.length > 0) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(
    error instanceof HistoryOpenIssuesError
      ? error.message
      : error instanceof Error
        ? error.message
        : error,
  );
  process.exitCode = 1;
} finally {
  await closeDb();
}
