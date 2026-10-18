/**
 * Writes seed/review/progression-worksheet.md: the INPUTS and FORMULAS for the three
 * hand-simulation dates (SPEC 9), so the user can work out the expected suggestions by hand.
 * It never calls the progression engine and never prints a computed e1RM, load or label.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionRec } from "../src/progression/types.js";
import {
  buildSessionInput,
  daysBetween,
  exerciseId,
  expectedSlots,
  HAND_SIM_DATES,
  itemsFor,
  plan,
  thursdayClasses,
  weekdayOf,
  weekOf,
} from "../test/fixtures/progression/history.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outPath = resolve(root, "seed/review/progression-worksheet.md");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function nice(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
const num = (n: number) => String(Math.round(n * 100) / 100);
const exName = (slug: string) => plan.exercises.find((e) => e.slug === slug)?.name ?? slug;

const L: string[] = [];
const p = (s = "") => L.push(s);

// ---------------------------------------------------------------------------
// Intro and formulas
// ---------------------------------------------------------------------------

p("# Progression worksheet (hand simulation)");
p();
p("This file is for you to work out, by hand, what the bot should suggest on three days:");
p("**Mon 26 Oct (W5)**, **Fri 30 Oct (W5, heavy legs on Thursday)** and **Mon 23 Nov (W9)**.");
p("All numbers are made up (a fake lifter). The file shows only the inputs and the rules.");
p("It does not show any answer. The bot is not used to make this file.");
p();
p("How to use it:");
p("1. Read the rules in section A.");
p("2. For each item in section C, read the inputs and work out the answer with a calculator.");
p(
  "3. Write the answer in `test/fixtures/progression/expected.json` (the key is shown for each item).",
);
p("   The accepted shapes are explained at the top of that file.");
p(
  "4. If a rule is not clear for a case, write your doubt on the `Doubts` line. We will fix the rule.",
);
p();
p("## A. Rules (from SPEC 5.2, 5.6c)");
p();
p("**Load of one set (system load)**");
p(
  "- Barbell: total weight including the bar. Dumbbells: kg per hand. Machine or cable: stack value.",
);
p("- Pull-up: `system load = bodyweight + added kg - assistance kg`.");
p();
p("**1. e1RM of one set** (e1RM = estimated best single)");
p("`e1RM = system load x (1 + (reps + RIR) / 30)`");
p();
p("**2. Which sets can be used (valid set)**. A set is valid only if ALL of these are true:");
p("- the RIR was logged (an empty RIR means the set is not used)");
p("- reps are 15 or less");
p("- the week is not a deload week and not a test week");
p("- the set is not marked unclean (`clean = no`)");
p("- the session level was not RED (YELLOW and GREEN are fine)");
p(
  "- Imported sessions (W1-W4) have a RIR only on the LAST set of each exercise. The other sets are not valid.",
);
p("- `4+` counts as RIR 4. A `4+` set may make the e1RM higher, but must never make it lower.");
p();
p(
  "**3. Session e1RM** = the highest valid set e1RM in that session. A session with no valid set does not count.",
);
p();
p("**4. Current e1RM** (use the newest sessions first, valid sessions only):");
p("- 3 or more valid sessions: the **median** of the last 3");
p("- 2 valid sessions: the **lower** of the two");
p("- 1 valid session: that one (label `estimate`)");
p(
  "- 0 valid sessions: no suggestion, the bot asks for the load (`ask: load`, label `baseline_ask_load`)",
);
p("- If all the valid sessions are imported (W1-W4): label `estimate_check_first_set`.");
p('  Imported sessions keep the label "estimate" until the exercise has 2 bot-logged sessions.');
p(
  "- Tuesday and Friday squat share one e1RM. Hack squat is a separate exercise with its own history.",
);
p(
  "- For OR items (squat / hack squat, cable / machine row) each option has its own history and its own answer.",
);
p();
p("**5. Needed load** for the target");
p("`RIR mid = (rir_min + rir_max) / 2`");
p(
  "`needed load = current e1RM / (1 + (reps_min + RIR mid) / 30)`   (use `reps_min`, the lower rep number)",
);
p(
  "- Pull-up: `needed added = needed load - bodyweight` (use the LATEST bodyweight). Positive = added kg.",
);
p("  Zero or negative = no added weight: plain bodyweight (added 0), or a band for assistance.");
p();
p("**6. Rounding: always toward EASIER** (never round up to a heavier load)");
p(
  "- Barbell: `total = bar + k x step` (bar and step are in each item below). Take the largest total that is not above the needed load.",
);
p(
  "- Dumbbells (per hand) and stacks: the largest multiple of the step that is not above the needed load.",
);
p(
  "- Pull-up added weight: round DOWN to the step. Assistance (band): choose the smallest band that gives at least the needed assistance.",
);
p(
  "- A band colour with no kg value is unknown (see section B): the bot asks for it (`ask: band`).",
);
p();
p(
  "**7. Accessories** (exercises that are not main lifts: lat pulldown, rows, incline DB bench, face pull, triceps, Bulgarian, lateral raise).",
);
p(
  "They do NOT use e1RM. Look at the last non-deload session only (its sets and the RIR of the LAST set):",
);
p("- All sets reached `reps_max` and the last-set RIR is at least `rir_min`: **+1 step**");
p("- Any set below `reps_min`, or last-set RIR 0 in 2 sessions in a row: **-1 step**");
p("- Otherwise: keep the same load");
p("- Deload or easy sessions are not used for this rule. Use the newest non-deload session.");
p("- With no non-deload session at all: no suggestion (ask for the load).");
p();
p(
  '**8. Break rule** ("back after a break"): take 10% off the system load, label `back_after_break`.',
);
p(
  "It fires when the planned item was scheduled and NOT logged 2 or more times in a row (see the item's schedule list),",
);
p("or when no training at all was logged for 10 or more days (class days count as training).");
p(
  "For pull-ups the 10% is taken from the total system load but removed from the added weight only, never below 0.",
);
p();
p("**9. Friday rules** (by the item's tags and the heavy groups of Thursday's class):");
p(
  "- heavy PULL: items tagged `row` are reduced to 2 sets x `reps_min` at RIR 3-4, or can be skipped (label `friday_reduced`)",
);
p("- heavy PUSH: items tagged `horizontal_press`: same");
p(
  "- heavy LEGS: items tagged `squat`: same. Items tagged `unilateral_leg` are only offered as skip (label `friday_offer_skip`, normal prescription)",
);
p(
  "- Deload Friday and heavy: the matching items drop to 1 easy set or skip. Unilateral leg: skipped.",
);
p(
  "- When the prescription changes, write the new sets / reps / RIR in your answer, and the load for those reps and that RIR.",
);
p("- Friday rules do not change which e1RM is used.");
p();
p("**10. Pull-up gate** (weighted pull-ups are allowed only when the gate is open)");
p("- Opens on a clean bodyweight set of 6 or more reps, or a check-in / test max of 6 or more.");
p(
  "- Stays open. Closes only if a later bodyweight max test is below 6, or the e1RM implies less than 5 bodyweight reps in 2 sessions in a row.",
);
p(
  "- Gate closed: use the plan's fallback shown on the item: bodyweight if the last bodyweight max is at least the stated number, otherwise assisted.",
);
p(
  "  Labels `fallback_bw` / `fallback_assisted`. If the gate is closed and there is no max on record: start with one max-clean test set (`max_test_first`).",
);
p(
  "- Bodyweight entries older than 14 days: label `bw_stale` and the bot also asks for today's weight (`ask: bodyweight`).",
);
p();
p(
  "**11. Readiness**: a session is GREEN with no active signals. Signals expire: button and chat after 24 h, recovery score after 3 days.",
);
p("Heavy Thursday is NOT a readiness signal. If the level is GREEN the plan is used as written.");
p();

// ---------------------------------------------------------------------------
// Equipment (section B)
// ---------------------------------------------------------------------------

p("## B. Equipment and bands");
p();
p("| Equipment | Bar / base | Step |");
p("|---|---|---|");
for (const e of plan.equipment) {
  p(
    `| ${e.name} | ${e.base_kg === null ? "-" : `${num(e.base_kg)} kg`} | ${e.step_kg === null ? "-" : `${num(e.step_kg)} kg`} |`,
  );
}
p();
p(
  "**Band colours are NOT known yet.** Fill in the real kg of assistance for each colour if you need a band in an answer.",
);
p(
  "(The made-up lifter never used a band, so the answers below should not need one. If you think one is needed, tell us.)",
);
p();
p("- red = ? kg");
p("- black = ? kg");
p("- purple = ? kg");
p("- green = ? kg");
p("- blue = ? kg");
p();

// ---------------------------------------------------------------------------
// Per date (section C)
// ---------------------------------------------------------------------------

function setRows(rec: SessionRec, isPullUp: boolean, isAccessory: boolean): string[] {
  const rows: string[] = [];
  rec.sets.forEach((s, i) => {
    const load = isPullUp
      ? `${num(rec.bwKg ?? 0)} + ${num(s.addedKg ?? 0)} - ${num(s.assistKg ?? 0)}${s.band ? ` (band ${s.band})` : ""}`
      : `${num(s.loadKg ?? 0)}`;
    const rir = s.rir === null ? "not logged" : s.rirPlus ? "4+" : String(s.rir);
    const why: string[] = [];
    if (rec.isDeload) why.push("deload week");
    if (rec.isTest) why.push("test week");
    if (rec.readiness === "RED") why.push("RED session");
    if (s.rir === null) why.push("no RIR");
    if ((s.reps ?? 0) > 15) why.push("reps over 15");
    if (s.clean === false) why.push("unclean");
    const e1 = isAccessory
      ? "(not used: accessory)"
      : why.length
        ? `no (${why.join(", ")})`
        : "yes";
    const sysLoad = isPullUp ? num((rec.bwKg ?? 0) + (s.addedKg ?? 0) - (s.assistKg ?? 0)) : "";
    rows.push(
      `| ${nice(rec.date)} (W${rec.week}, ${rec.source}${rec.readiness && rec.readiness !== "GREEN" ? `, ${rec.readiness}` : ""}) | ${i + 1} | ${s.reps} | ${load}${isPullUp ? ` = ${sysLoad}` : ""} | ${rir} | ${s.clean === null ? "-" : s.clean ? "yes" : "no"} | ${e1} |`,
    );
  });
  return rows;
}

for (const date of HAND_SIM_DATES) {
  const input = buildSessionInput(date);
  const slots = expectedSlots(date);
  const week = weekOf(date);
  const weekday = weekdayOf(date);
  const wk = plan.weeks.find((w) => w.week === week);
  const thursday =
    weekday === "fri"
      ? thursdayClasses.find(
          (c) =>
            c.date ===
            new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10),
        )
      : undefined;

  p(
    `## C. ${nice(date)} ${date.slice(0, 4)} - plan week ${week}, ${weekday.toUpperCase()}${wk?.is_deload ? " (deload week)" : ""}`,
  );
  p();
  p("**Day context**");
  p(
    `- Readiness signals on record (they expire, see A.11): ${
      input.readinessSignals.length
        ? input.readinessSignals.map((s) => `${s.kind} at ${s.at}`).join("; ")
        : "none"
    }.`,
  );
  if (input.bodyweight) {
    p(
      `- Latest bodyweight: **${num(input.bodyweight.kg)} kg** on ${nice(input.bodyweight.date)} (${daysBetween(input.bodyweight.date, date)} days before this session; stale means more than 14).`,
    );
  }
  p(
    `- Last day with any training logged before this date (class days count): ${input.lastTrainingDate ? `${nice(input.lastTrainingDate)} (${daysBetween(input.lastTrainingDate, date)} day(s) before)` : "none"}.`,
  );
  if (weekday === "fri") {
    p(
      `- Thursday class (${thursday ? nice(thursday.date) : "-"}): reported = ${input.classReported ? "yes" : "no"}; heavy groups = ${input.heavyGroups.length ? input.heavyGroups.join(", ").toUpperCase() : "none"}.`,
    );
    p(`- This Friday is ${wk?.is_deload ? "a deload week" : "a normal week"}.`);
  }
  if (slots.some((x) => x.slug === "pull_up")) {
    const byDay = new Map<string, string[]>();
    for (const e of input.gateEvents) {
      const k = `${e.kind === "test_max" ? "check-in max" : "clean bodyweight sets"} on ${nice(e.date)}`;
      byDay.set(k, [...(byDay.get(k) ?? []), String(e.reps)]);
    }
    p(
      `- Pull-up gate events on record (oldest first, reps): ${
        byDay.size ? [...byDay].map(([k, v]) => `${k}: ${v.join(", ")}`).join("; ") : "none"
      }.`,
    );
  }
  p();

  const loadItemKeys = new Set(slots.map((s) => s.itemKey));
  const other = itemsFor(date).filter((i) => !loadItemKeys.has(i.key));
  if (other.length) {
    p(`No load math, nothing to fill: ${other.map((i) => i.plan_name).join("; ")}.`);
    p();
  }

  for (const slot of slots) {
    const item = itemsFor(date).find((i) => i.key === slot.itemKey);
    if (!item) continue;
    const ex = plan.exercises.find((e) => e.slug === slot.slug);
    if (!ex) continue;
    const isPullUp = ex.type === "bodyweight_plus";
    const isAccessory = !ex.is_main_lift;
    const equipment = plan.equipment.find((e) => e.slug === ex.equipment_slug);
    const rirMid =
      item.rir_min !== null && item.rir_max !== null ? (item.rir_min + item.rir_max) / 2 : null;
    const sets =
      item.sets_min === item.sets_max ? `${item.sets_min}` : `${item.sets_min}-${item.sets_max}`;
    const reps =
      item.reps_min === item.reps_max ? `${item.reps_min}` : `${item.reps_min}-${item.reps_max}`;
    const multi = item.exercise_options.length > 1;

    p(`### ${slot.key} - ${item.plan_name}${multi ? ` -> option: ${exName(slot.slug)}` : ""}`);
    p();
    p(
      `- Plan target: **${sets} sets x ${reps} reps**, RIR ${item.rir_min}-${item.rir_max}, RIR mid = ${rirMid}. Use reps_min = ${item.reps_min} for the load. Tags: ${item.tags.join(", ") || "-"}.${item.modifiers.length ? ` Modifiers: ${item.modifiers.join(", ")}.` : ""}`,
    );
    p(
      `- Rule to use: ${isAccessory ? "accessory rule (section A.7), no e1RM" : "main lift: e1RM rule (section A.1-A.6)"}${isPullUp ? "; pull-up gate (A.10)" : ""}.`,
    );
    if (equipment) {
      p(
        `- Equipment: ${equipment.name}. ${equipment.base_kg !== null ? `Bar = ${num(equipment.base_kg)} kg. ` : ""}Step = ${equipment.step_kg === null ? "?" : num(equipment.step_kg)} kg.`,
      );
    }
    if (isPullUp) {
      const fb = item.fallback_prescription;
      p(
        `- Pull-up bodyweight to use: latest = ${input.bodyweight ? num(input.bodyweight.kg) : "?"} kg. Bands: not mapped yet (section B).`,
      );
      if (fb) {
        p(
          `- If the gate is closed: if last bodyweight max >= ${fb.if_bw_max_gte} -> ${fb.then.sets} x ${fb.then.reps_min}-${fb.then.reps_max} bodyweight; otherwise assisted ${fb.else.sets} x ${fb.else.reps_min}.`,
        );
      }
    }
    const sched = input.occurrences.find((o) => o.plannedItemId === slot.plannedItemId);
    p(
      `- Schedule for the break rule (earlier non-deload weeks, oldest first): ${
        sched?.occurrences.length
          ? sched.occurrences
              .map((o) => `${nice(o.date)} ${o.logged ? "logged" : "NOT logged"}`)
              .join("; ")
          : "none"
      }.`,
    );
    p();
    const hist = input.history[exerciseId(slot.slug)] ?? [];
    if (hist.length === 0) {
      p("History for this exercise: **none**.");
    } else {
      p(
        `History for ${exName(slot.slug)} (newest first)${isPullUp ? "; load = bodyweight stored that day + added - assistance" : ""}:`,
      );
      p();
      p(
        `| Session | Set | Reps | ${isPullUp ? "System load (kg)" : "Load (kg)"} | RIR | Clean | Valid for e1RM? |`,
      );
      p("|---|---|---|---|---|---|---|");
      for (const rec of hist) for (const r of setRows(rec, isPullUp, isAccessory)) p(r);
    }
    p();
    p("Your answer (also write it in expected.json):");
    p();
    p("`Answer: ____________________________`");
    p();
    p("`Doubts: ____________________________`");
    p();
  }
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${L.join("\n")}\n`);
console.log(`Wrote ${outPath}`);
for (const date of HAND_SIM_DATES) {
  console.log(`${date}: ${expectedSlots(date).length} answers to fill`);
}
