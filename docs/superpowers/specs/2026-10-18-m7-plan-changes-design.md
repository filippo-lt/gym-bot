# M7: plan changes (swaps with a scope, plan versions)

Status: design. The user delegated every design call to Claude on 18 Oct 2026 ("skip the questions, you decide"), so every decision below is Claude's call and is marked as such where it goes beyond SPEC.md.

## Why

Today the plan is frozen at version 1. The user cannot swap an exercise (equipment taken, a sore joint, a preference), and the fatigue engine can only print a text hint ("move the next deload earlier") because applying it needs plan versions. M7 adds both, without ever rewriting history: logs, suggestions and session items keep pointing at the planned item and version they were made with.

## Goals

- `/swap` and chat swaps ("swap face pulls for band pull-aparts", "only today", "from now on").
- Scope: **Only today** (one-off, `session_overrides`) or **Rest of plan** (new plan version). If the exercise appears on more than one weekday, Rest of plan also asks **This day only / Every day**.
- The replacement inherits the replaced item's tags, priority, block and prescription (sets × reps × RIR), so Friday rules, readiness filters and `/short` keep working.
- Always show the change on a card and save only on ✅.
- "Move the next deload earlier" (SPEC §5.6c last row, §6 `plan_weeks`): proposed by the fatigue engine, saved only on the user's tap.
- Every plan reader picks the version effective on the date it renders. One function, `planDayOn`, is the way to read the plan for a date (M8's morning message and M9's export rely on it).

## Non-goals

- No undo button for plan changes (Claude's call). The confirm card is the safety net; swapping back creates another version.
- No free editing of prescriptions (sets/reps/RIR) from chat. Only swaps and the deload move.
- No plan upload or regeneration (Phase 2).
- No change to how history import maps rows: it keeps mapping to version 1 by `item_key`.

## Anti-goals (would be a failure even if it "works")

- A past session renders differently after a plan change.
- A log, suggestion or session item is moved to another planned item or version.
- Any number on a card comes from model text.
- A plan change is saved without a ✅ tap.

## Core model

### Versions are full copies (Claude's call)

A new version copies **every** `plan_weeks` row and every `planned_items` + `planned_item_options` row of the **latest** version (highest `version` number), with new ids, then applies the change to the items whose date is on or after `effective_from`. Rows before `effective_from` stay identical to the source version, so the copy is consistent whichever version a reader lands on.

Why a full copy and not a delta table: every reader already reads "items of version V for week W, weekday D". A full copy keeps that shape; the only change readers need is "which V for this date". A copy is about 300 rows; one transaction.

- **Version lookup (unchanged rule, now in one place):** for a date, the highest `version` of the current plan whose `effective_from <= date`; if none, the lowest version.
- **`effective_from` is never today or earlier.** A persistent change applies from tomorrow at the earliest (03:00 day boundary, Rome). This is what guarantees that no existing `session_items`, `log_groups` or `suggestions` row ever points at a planned item of a version that does not cover its date. (Claude's call; see "Rest of plan" below for how today is still covered.)
- **`item_key` is the stable identity across versions.** Copied items keep their `item_key` (unique per version already). The `wNN` part is the item's *origin* week, not its current week number after a deload insert. Items of an inserted deload week get keys `dNN-<weekday>-NN-<sub>` (`NN` = the week number they were inserted at).
- **Week count is per version:** new column `plan_versions.weeks` (backfilled from `plans.weeks` = 12). A deload insert can make the plan 13 weeks. "Plan finished" uses the effective version's `weeks`, never `plans.weeks`.
- **Week numbers stay date arithmetic.** Weeks are always contiguous Monday–Sunday blocks from `plans.start_date` (an insert shifts later weeks, it never leaves gaps), so `planWeekFor(date, start, weeks)` stays right as long as `weeks` comes from the effective version.
- **What changed:** new column `plan_versions.change` (jsonb, nullable for v1): `{ kind: "swap", from: exerciseId, to: exerciseId, weekdays: Weekday[] | "all", fromDate }` or `{ kind: "deload_earlier", insertedWeek, droppedWeek: number | null }`. `reason` holds a short human line. `/plan` lists changes from these rows.
- `source_hash` / `resolved_hash` on a copied version are copied from the source version (they describe the plan file, and `seedPlan` only ever compares version 1).

### One-off swaps: `session_overrides` (new table)

`session_overrides (id, session_date, planned_item_id → planned_items, replaced_exercise_id → exercises, replacement_exercise_id → exercises, created_at)`, unique `(session_date, planned_item_id, replaced_exercise_id)`, RLS on, no policies.

On read, an override replaces `replaced_exercise_id` with `replacement_exercise_id` inside that item's options for that date only (an OR item keeps its other option; if the replacement is already an option, it is not listed twice). The planned item id does not change, so logs, session items and suggestions keep working.

### Swapping OR items (Claude's call)

The swap replaces only the named option ("swap hack squat for leg press" on "Squat / hack squat" → "Squat / leg press"). Same rule for overrides and versions.

### HSPU items (Claude's call)

Swapping the HSPU exercise away clears `hspu_step_id` on the new items (the replacement has no ladder). Overrides of an HSPU item render without the ladder step.

## The central reader (contract for M8 and M9)

New module `src/plan/effective.ts`:

```ts
/** The plan version that renders `date` (Rome calendar date, YYYY-MM-DD). */
versionOn(db, date): Promise<{ planId, versionId, version, startDate, weeks } | null>

/** Loads all versions once; sync lookup for engines that walk many dates. */
loadVersionIndex(db): Promise<{ versionFor(date): VersionInfo | null; weekOf(date): WeekInfo | null }>

/** Everything needed to render or reason about one date. */
planDayOn(db, date): Promise<PlanDay>

type PlanDay =
  | { kind: "no_plan" }
  | { kind: "before_start"; startDate }
  | { kind: "finished"; lastDate }
  | { kind: "rest"; date; versionId; week; phase; isDeload; isTest; weeksTotal }      // Sat/Sun
  | { kind: "day"; date; weekday; versionId; week; phase; isDeload; isTest; weeksTotal;
      items: PlanDayItem[] }

interface PlanDayItem {
  plannedItemId; itemKey; itemOrder; subItem; block; planName; variantLabel;
  prescriptionRaw; extrasRaw; setsMin; setsMax; repsMin; repsMax; perSide;
  durationSMin; durationSMax; hiit; tempo; modifiers; hspuStepId; rirMin; rirMax;
  tags; priority; note; timeMinMin; timeMinMax; fallback;
  options: { id; slug; name; type; loadBasis; equipmentId; isMainLift }[];  // overrides applied
  swappedToday: { from: { id; name }; to: { id; name } } | null;          // set when an override applies
}
```

`planDayOn` does not read logs or session status; callers that need status join `session_items` / `log_groups` by `plannedItemId` and `date` as they do today. `getSession` (src/bot/session.ts) and `loadDayPlan` (src/logging/plan-context.ts) become thin layers on top of it, so code that already calls them gets versions and overrides for free. M8 should call `planDayOn` (or keep calling `getSession` + `loadSessionAdvice`); M9's export must include `plan_versions`, `plan_weeks`, `planned_items`, `planned_item_options`, `session_overrides` and any exercises created by swaps.

## Readers to switch

Every one of these must use `versionOn` / `loadVersionIndex` / `planDayOn` for the date it handles (file map from the M7 recon):

- `loadPlanContext` + `loadDayPlan` (logging resolver, make-ups, skip) — per-date version; make-up search walks each earlier date with its own version.
- `getSession`, `getWeek`, `loadWeekRow` (src/bot/session.ts) — `getWeek` resolves the version per day (a week can straddle two versions).
- `getPlanOverview` (/plan) — current version's weeks; next deload from the effective version; adds a "Changes" list.
- `getExerciseHistory` (src/queries/history.ts) — week/phase/deload flags per listed date, not from the newest date's version.
- `historyWindow` (read-tools.ts) — plan_week → dates through the version effective today.
- `loadPlanEnv` / `versionIdFor` / `weekFor` / `fridayOfWeek` (src/progression/load-history.ts) — replaced by `loadVersionIndex`. `loadOccurrences` (break rule) matches each earlier week in the version effective on that week's date (same weekday + sub_item + identical option set, overrides applied).
- `loadSessionInput` / `ensureSuggestions` / `storedAdvice` — items from `planDayOn` (overrides applied). A suggestion for an overridden item is stored for the replacement exercise; the unique key already includes `exercise_id`. Past dates read stored suggestions for the exercise now shown.
- `classQuestionJob` — "plan active" check through `versionOn` and the version's `weeks`.
- `getAlternativeFacts` — "where it is planned" from the version effective today (future items only).
- Lookups by planned item id (logging-flow echo, execute.ts edit, resolve.ts reps_max) need no change: they read the row they point at.
- Hard-coded 12s: `formatFinished` text ("The plan is finished."), `plan_week` Zod max and the tool description use the version's week count (max 13 is not enough after two inserts; use `.max(52)` and validate against the version in code).
- History import: unchanged (version 1 by `item_key`).

## Swap flow

### Intent

New write tool `swap_exercise` (stages, never saves):

```
swap_exercise({
  exercise:    { said, slug? },                   // what to replace
  replacement: { said, slug?, new?: { name, type, load_basis?, equipment_slug?, muscle_group } },
  scope?: "today" | "rest",                       // only when the user said it
  days?: "this_day" | "every_day",                // only when the user said it
  day?: weekday | "today"                         // which session the user means, when named
})
```

- `scope` "today" = "only today / just this time / today"; "rest" = "from now on / for the rest of the plan / always". Absent if not said.
- `replacement.new` only when the replacement is not a catalog exercise. `type` is one of the exercise types, `load_basis` one of the four bases, `equipment_slug` one of `equipment.slug` (Zod-validated; unknown values → the card asks the user to describe it again). Code builds the slug from the name and adds `said` as an alias. The card shows the classification ("New exercise: Band pull-apart · reps only"), so a wrong guess is visible before ✅. (Claude's call: allow new exercises, because alternatives come from Claude's general knowledge and are often not in the catalog.)
- `get_alternatives` stays read-only. The prompt tells the model to call `swap_exercise` only when the user asks to swap, never after merely listing alternatives.

### Resolution (code)

1. **Reference day:** `day` if named, else today. If the exercise is not in that day's session (after overrides), the reference is the next session date (today included, within the plan) that contains it. None → reply "X isn't in the plan from today on." No write.
2. **Same exercise or already the same** → reply, no write.
3. **Scope missing** → card with buttons **Only <Mon 19 Oct | today>** / **Rest of plan** (`sw:<pendingId>:t|r`).
4. **Rest of plan + days missing + the exercise appears on more than one weekday in future items of the latest version** → buttons **Only Tuesdays** / **Every day** (`sw:<pendingId>:d|a`). On one weekday only, `days` = that weekday, no question.
5. **Confirm card** (✅ ✏️ ❌, existing `pa:` pending, reason `plan_change`), text built in code, e.g.:

   - Only today: `Swap for Mon 19 Oct: Face pull → Band pull-apart (3 × 15, same tags). Nothing else changes.`
   - Rest of plan: `From Tue 20 Oct, Face pull → Band pull-apart on Mon and Fri (14 sessions). Today: swapped too. Past sessions and logs stay as they are.`
   - New exercise line when relevant: `New exercise: Band pull-apart · reps only (no load math).`

   ✏️ works like other cards (the next message corrects the staged swap).

### Saving (on ✅, one transaction, through `write_ledger` with `p:<pendingId>`)

- **Only today:** insert a `session_overrides` row for (reference date, planned item, replaced → replacement). If the item on that date already has a log group for the replaced exercise, refuse: "You already logged face pulls today; nothing changed." Several items on that day with the exercise (rare) → all of them.
- **Rest of plan:** `effective_from = max(tomorrow, reference date)`. Create the new version as a full copy of the latest version, swapping the option on every item dated `>= effective_from` that has the exercise as an option (restricted to the chosen weekday for "this day only"). If the reference date is today and today's item has no log for the replaced exercise yet, also insert today's override, so the swap covers today too.
- Create the new exercise first when `replacement.new` is set (slug unique; if it exists by then, reuse it).
- Reply: `Saved. <same change line>`. No Undo button.
- **Concurrency:** the version number is `max(version)+1` inside the transaction; the `(plan_id, version)` unique constraint turns a race into a retry-safe failure ("plan changed meanwhile, try again").

### `/swap` command

- `/swap` alone → short help: `Tell me what to swap, e.g. "swap face pulls for band pull-aparts only today". Today: <exercise names>.`
- `/swap <text>` → the text goes through the normal AI pipeline (same as free text), so all the rules above apply.

## Deload earlier

### When it is proposed

Replaces today's text hint (`earlierDeloadHint` / `deloadHint` keep their trigger rule: the last two frozen session levels RED, or the last two weekly recovery scores ≤ 2). It becomes a `proposals` row of kind `earlier_deload` (the enum value already exists), created when `/today` (and M8's morning message, through `loadSessionAdvice`) computes advice for today and:

- the trigger fires,
- the week after the current week exists in the effective version and has `is_deload = false`,
- no `earlier_deload` proposal was created in the current plan week (open, accepted or declined) — one ask per week (Claude's call).

Payload: `{ currentWeek, insertAt: currentWeek + 1, mondayDate, versionId }`.

### What the user sees

The session view shows the proposal card (instead of the old text hint) with code-built text:

`You've been tired 2 sessions in a row. Move the deload earlier? Next week (W7, 9–15 Nov) becomes a deload, weeks 7–12 move one week later. The W8 deload is dropped (it would be only 2 weeks after). The plan still ends Sun 20 Dec.`

Buttons ✅ Move deload / ❌ Not now (`pr:<id>:ok|no`, the existing proposal handler, extended for the new kind). The proposal text is the confirmation (SPEC §5.6d "any proposal from 5.6c").

### Applying it (pure function + one transaction)

`insertDeload(weeks, items, insertAt)` in `src/plan/deload.ts`, pure, heavily unit-tested:

1. **Template:** the inserted week's items are a copy of the next scheduled deload week at or after `insertAt` (W8 from W5–7); if none (W9–W11), the most recent earlier deload week (W8). Phase "Deload", `is_deload = true`, `is_test = false`. Keys `dNN-…`.
2. Every week `>= insertAt` moves to `week + 1` (start date + 7 days, item `week` + 1).
3. **Drop rule:** the first deload week after the inserted one, if it now starts less than 3 weeks after the inserted week's Monday, is removed and every later week moves back by one. The test week is never removed.
4. `weeks` = old count + 1 − (1 if dropped).

Examples (12-week plan, deloads W4, W8, test W12):
- Accept in W6 → insert W7; old W7→W8, old W8 deload→W9 is 2 weeks after → dropped; old W9–12 stay W9–12. Still 12 weeks.
- Accept in W5 → insert W6; old W8 deload→W9 is 3 weeks after → kept. 13 weeks, ends a week later.
- Accept in W10 → insert W11 (template = W8); old W11→W12, test→W13. 13 weeks.

On ✅: refuse if `mondayDate` is today or earlier ("This proposal expired; nothing changed.") or if a newer version was created after the proposal (`versionId` no longer latest → "The plan changed since; I'll ask again if needed."). Else create the version (`effective_from = mondayDate`, `change = { kind: "deload_earlier", insertedWeek, droppedWeek }`) in one transaction with the proposal's status change, then refresh `user_state` as after any write.

Weekly metrics stay keyed by `plan_week`: only future weeks shift, so past numbers never change meaning.

## Telegram surface

- New callback prefix `sw:<pendingId>:t|r|d|a` (scope / days answers on a swap pending). Handled before the generic callback handler; stale or replaced pendings reply "this expired, nothing saved" like other pendings.
- `pr:<id>:ok|no` now also handles `earlier_deload`.
- `/swap` registered in `setMyCommands`.
- `/plan` gains a "Changes" section: `• From Tue 20 Oct: Face pull → Band pull-apart (Mon, Fri)` / `• From Mon 9 Nov: deload moved to W7 (W8 deload dropped)`.
- Today's session marks a one-off swap: `Band pull-apart (instead of Face pull today)`.

## Data model changes (migration 0007)

- `plan_versions.weeks integer not null` (hand-edit the generated SQL: add nullable, backfill from `plans.weeks`, set not null).
- `plan_versions.change jsonb` nullable.
- New table `session_overrides` as above, RLS enabled, no policies (the RLS db test covers it).
- `PENDING_KINDS` / staged-action union: a new staged action `swap` (jsonb, no enum change unless the code needs a new `pending_kind`; if so, add it in the same migration).
- If M8 or M9 lands a migration on `dev` first, sync and regenerate this one before the PR.

## Tests that must exist

- `insertDeload`: the three examples above; insert right before the test week; template choice; keys unique; weeks contiguous; drop rule at exactly 3 weeks (kept) and 2 (dropped).
- Version copy: identical rows before `effective_from`, swap applied only on/after it, only on the chosen weekday for "this day only", OR item keeps the other option, `item_key` preserved, HSPU step cleared.
- `planDayOn`: date in v1 range after v2 exists renders v1; date after v2 renders v2; week straddling two versions in `/week`; finished uses version weeks (W13 after an insert is not "finished"); override applied only on its date.
- Past session renders identically before and after a swap and after a deload insert (snapshot of `getSession` for a past date).
- Logs keep `planned_item_id` and render under the old version; `session_items` untouched by a version create.
- Swap policy: scope missing → scope question; multi-weekday → days question; always a card; ✅ twice → one version (ledger); swap of an already-logged exercise today refused; tomorrow-or-later `effective_from`.
- Break rule: an item swapped mid-plan does not fire "back after a break" on the replacement's first session; occurrences cross the version boundary correctly.
- Deload proposal: created once per week; not when next week is a deload; ✅ after its Monday expired; ✅ when a newer version exists refused.
- Golden (opt-in): "swap face pulls for band pull-aparts only today" → `swap_exercise` scope today; "from now on use leg press instead of hack squat" → scope rest.

## Left to the builder

- Exact module split under `src/plan/` (beyond `effective.ts`, `deload.ts`, a `versions.ts` for the copy).
- Card wording details within the examples' spirit (short, simple English, numbers from code).
- How `getWeek` batches per-day version lookups.
