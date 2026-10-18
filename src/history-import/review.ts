import { fmt } from "./build.js";
import type { HistoryImport } from "./types.js";

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const STATUSES = ["done", "modified", "skipped"] as const;

function weekList(r: HistoryImport): number[] {
  const weeks = new Set<number>();
  for (const x of r.session_items) weeks.add(x.week);
  for (const x of r.log_groups) weeks.add(x.week);
  for (const x of r.class_logs) weeks.add(x.week);
  for (const x of r.weekly_metrics) weeks.add(x.plan_week);
  return [...weeks].sort((a, b) => a - b);
}

/** Simple-English review file for the user's OK before anything is saved. */
export function renderHistoryReview(r: HistoryImport): string {
  const out: string[] = [];
  const weeks = weekList(r);
  const sets = (w: number) =>
    r.log_groups.filter((g) => g.week === w).reduce((n, g) => n + g.entries.length, 0);

  out.push("# History import: review", "");
  out.push(
    `Export fingerprint: \`${r.export_hash.slice(0, 12)}\`. Nothing is saved yet. This file only shows what the import would do.`,
    "",
  );

  out.push("## Summary", "");
  out.push(
    `- ${r.session_items.length} session items, ${r.log_groups.length} exercise logs, ${r.log_groups.reduce((n, g) => n + g.entries.length, 0)} sets, ${r.class_logs.length} class logs, ${r.weekly_metrics.length} weekly values, ${r.bodyweight ? 1 : 0} bodyweight entry.`,
    "",
    "| Week | Session items | Exercise logs | Sets | Class logs | Weekly values |",
    "|---|---|---|---|---|---|",
  );
  for (const w of weeks) {
    out.push(
      `| ${w} | ${r.session_items.filter((x) => x.week === w).length} | ${r.log_groups.filter((x) => x.week === w).length} | ${sets(w)} | ${r.class_logs.filter((x) => x.week === w).length} | ${r.weekly_metrics.filter((x) => x.plan_week === w).length} |`,
    );
  }
  out.push("");

  out.push("## Open issues", "");
  if (r.open_issues.length === 0) {
    out.push("None. The import can run.", "");
  } else {
    out.push(
      `${r.open_issues.length} open issue(s). The import will not run until they are fixed. Put the fix in \`import/history-overrides.json\`, inside \`records\`.`,
      "",
    );
    r.open_issues.forEach((i, n) => {
      out.push(`${n + 1}. **${i.ref}**: ${i.detail}`);
      if (i.snippet) out.push("   ", "   ```json", `   ${i.snippet}`, "   ```");
    });
    out.push("");
  }

  out.push("## Exercise logs (every one)", "");
  out.push(
    "How to read it: *Raw* is what the old tool has. *Sets* is what we save. *Load* shows how the load was calculated. Total reps are always split only when there is one clear answer.",
    "",
    'Flags: per_set_unknown = the reps per set are not known, only the total; rir_plus = RIR was "4+"; OPEN = an issue blocks the import; not clean = the note says the pull-up was not clean; comment = your override comment.',
    "",
    "| Key | Date | Plan exercise → exercise we save | Raw reps | Raw load | Raw RIR | Sets × reps | Load saved | Flags |",
    "|---|---|---|---|---|---|---|---|---|",
  );
  for (const x of r.review_rows) {
    const target = x.chosen ? `${x.plan_exercise} → ${x.chosen}` : `${x.plan_exercise} → ?`;
    out.push(
      `| ${esc(x.key)} | ${x.date} | ${esc(target)} | ${esc(x.raw.actual)} | ${esc(x.raw.load)} | ${esc(x.raw.rir)} | ${esc(x.sets_text)} | ${esc(x.load_text)} | ${esc(x.flags.join("; "))} |`,
    );
  }
  out.push("");

  out.push("## Session items by status", "");
  out.push(
    'A status-only "done" marks the item as done but creates no sets.',
    "",
    `| Week | ${STATUSES.join(" | ")} |`,
    `|---|${STATUSES.map(() => "---").join("|")}|`,
  );
  for (const w of weeks) {
    const c = STATUSES.map(
      (s) => r.session_items.filter((x) => x.week === w && x.status === s).length,
    );
    out.push(`| ${w} | ${c.join(" | ")} |`);
  }
  out.push("");

  out.push("## Class logs", "");
  if (r.class_logs.length === 0) out.push("None.", "");
  else {
    out.push("| Week | Date | Heavy groups |", "|---|---|---|");
    for (const c of r.class_logs)
      out.push(
        `| ${c.week} | ${c.date} | ${c.heavy_groups.length ? c.heavy_groups.join(", ") : "none heavy"} |`,
      );
    out.push("");
  }

  out.push("## Weekly values", "");
  if (r.weekly_metrics.length === 0) out.push("None.", "");
  else {
    out.push("| Week | Name | Number | Text | Unit |", "|---|---|---|---|---|");
    for (const m of r.weekly_metrics)
      out.push(
        `| ${m.plan_week} | ${m.metric} | ${m.value_num === null ? "" : fmt(m.value_num)} | ${esc(m.value_text ?? "")} | ${m.unit ?? ""} |`,
      );
    out.push("");
  }

  if (r.bodyweight) {
    out.push(
      "## Bodyweight",
      "",
      `${fmt(r.bodyweight.kg)} kg on ${r.bodyweight.date}. Saved on every imported exercise log.`,
      "",
    );
  }

  const withRir = r.log_groups.reduce(
    (n, g) => n + g.entries.filter((e) => e.rir !== null).length,
    0,
  );
  out.push("## Important", "");
  out.push(
    withRir === 0
      ? "No set has an RIR, so none of these sets count for e1RM (strength estimate). The import stores the weekly values. The pull-up gate and HSPU step are computed from them later (M5). There is no strength baseline."
      : `Only ${withRir} set(s) have an RIR. Sets without RIR do not count for e1RM (strength estimate).`,
    "",
  );
  return out.join("\n");
}
