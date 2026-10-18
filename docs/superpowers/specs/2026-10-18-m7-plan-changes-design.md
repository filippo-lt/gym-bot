# M7: plan changes (swaps with a scope, plan versions)

Status: design. The user delegated the design calls on 18 Oct 2026 ("skip the questions, you decide"), then asked (through the parent session) for an independent agent to answer the open design questions. A fresh Opus agent answered 17 neutral questions (`.superpowers/sdd/2026-10-18-m7-plan-changes/design-questions.md`, git-ignored) without seeing this draft. Its answers are adopted below and marked "(independent review)". Other calls beyond SPEC.md are marked "(Claude's call)". See "Open points for the user" at the end.

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
- **Week count is per version, derived from its `plan_weeks` rows** (independent review: a stored count is a second source that can drift; `plans.weeks` is never changed, because that would change how v1 dates render). A deload insert can make the plan 13 weeks. "Plan finished" uses the effective version's week count, never `plans.weeks`.
- **Week numbers stay date arithmetic.** Weeks are always contiguous Monday–Sunday blocks from `plans.start_date` (an insert shifts later weeks, it never leaves gaps), so `planWeekFor(date, start, weeks)` stays right as long as `weeks` is the effective version's count.
- **What changed:** new column `plan_versions.change` (jsonb, nullable for v1): `{ kind: "swap", from: exerciseId, to: exerciseId, weekdays: Weekday[] | "all", fromDate }` or `{ kind: "deload_earlier", insertedWeek, droppedWeek: number | null }`. `reason` holds a short human line. `/plan` lists changes from these rows.
- `source_hash` / `resolved_hash` on a copied version are copied from the source version (they describe the plan file, and `seedPlan` only ever compares version 1).

### One-off swaps: `session_overrides` (new table)

`session_overrides (id, session_date, planned_item_id → planned_items, replaced_exercise_id → exercises, replacement_exercise_id → exercises, created_at)`, unique `(session_date, planned_item_id, replaced_exercise_id)`, RLS on, no policies.

On read, an override replaces `replaced_exercise_id` with `replacement_exercise_id` inside that item's options for that date only (an OR item keeps its other option; if the replacement is already an option, it is not listed twice). The planned item id does not change, so logs, session items and suggestions keep working.

**Re-point rule.** Item ids are new in every version, so `createVersion` moves each override dated on/after the new `effective_from` (and sitting on the base version) to the new item on the same date whose options contain the replaced exercise, preferring the same `item_key`. No such item (e.g. a deload insert changed that day) → the override is deleted and returned as `droppedOverrides`; the reply adds "Your one-off swap on <date> (<A> → <B>) no longer applies." Undo of a version re-points overrides on its items back to the previous version by the same rule instead of blocking.

### Swapping OR items (Claude's call)

The swap replaces only the named option ("swap hack squat for leg press" on "Squat / hack squat" → "Squat / leg press"). Same rule for overrides and versions.

### HSPU items (independent review)

Swapping the HSPU exercise away clears `hspu_step_id` and `fallback_prescription` on the new items (the replacement has no ladder; a leftover step would drive its reps and HSPU advance proposals). Overrides render without the ladder step and without the fallback prescription (a pull-up's closed-gate fallback must not apply to its replacement). If the replacement the user names is an HSPU ladder step (e.g. "pike push-up"), it is not a plan change: the bot replies that the HSPU step is tracked from logs (SPEC §5.2) and saves nothing.

### RIR of swapped items (independent review)

Tags, priority, block and sets × reps are inherited; **RIR is not**. RIR comes from rules (`computeRir` in src/plan-import/rir.ts: main lift / deload / easy / test, SPEC §5.2), so a changed item's `rir_min`/`rir_max` are recomputed over the item's new option list (the replacement plus any surviving OR option, the same rule the plan import uses): squat 1–2 → leg press 1–3; "Squat / hack squat" with hack → leg press stays 1–2 because squat is still an option. For a one-off override, `planDayOn` recomputes the RIR of the overridden item the same way at read time.

## The central reader (contract for M8 and M9)

New module `src/plan/effective.ts`:

```ts
/** The plan version that renders `date` (Rome calendar date, YYYY-MM-DD). */
versionOn(db, date): Promise<{ planId, versionId, version, startDate, weeks /* count of its plan_weeks */ } | null>

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
- `classQuestionJob` — "plan active" check through `versionOn` and the version's week count.
- `getAlternativeFacts` — "where it is planned" from the version effective today (future items only).
- Lookups by planned item id (logging-flow echo, execute.ts edit, resolve.ts reps_max) need no change: they read the row they point at.
- Hard-coded 12s: `formatFinished` text ("The plan is finished."), `plan_week` Zod max and the tool description use the version's week count (max 13 is not enough after two inserts; use `.max(52)` and validate against the version in code).
- History import: keeps mapping to version 1 by `item_key` (SPEC §8 Transition). New guard (independent review): refuse import rows dated on or after the first `effective_from` of a version above 1, with a clear error, since those dates may render a different version.

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
- `replacement.new` only when the replacement is not a catalog exercise. `type` is one of the exercise types, `load_basis` one of the four bases, `equipment_slug` one of `equipment.slug` (Zod-validated; unknown values → the card asks the user to describe it again). When unsure, the model picks a no-load-math type (prompt rule). `is_main_lift` is always false for a new exercise. Code builds the slug from the name and adds `said` as an alias. The card shows the classification ("New exercise: Band pull-apart · reps only"), so a wrong guess is visible before ✅. New exercises reach the resolver and STT vocabulary automatically (the catalog is read from the DB). No suggestion until the first log (SPEC §5.2 "No valid session yet → ask for the load"). (Independent review agrees: refusing would break SPEC §1's own "band pull-aparts" example.)
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

Everything is computed at ✅ time, not card time (independent review): the base version is the latest version *at ✅*, and `effective_from` uses "tomorrow" *at ✅* (a card confirmed after the 03:00 boundary moves with the day).

- **Only today:** refuse "This card is for <date>, which has passed; nothing changed." when the reference date is before today at ✅. Re-read the reference date's items at ✅ (the card's ids may belong to an older version); none holding the exercise → "The plan changed since the card; ask again." Insert a `session_overrides` row for (reference date, planned item, replaced → replacement). If the item on that date already has a log group for the replaced exercise, refuse: "You already logged face pulls today; nothing changed." Several items on that day with the exercise (rare) → all of them.
- **Rest of plan:** with no later session that has the exercise, refuse "<A> isn't in a later session; use only today." (at staging and again at ✅). `effective_from = max(tomorrow, reference date)`. Create the new version as a full copy of the latest version, swapping the option on every item dated `>= effective_from` that has the exercise as an option (restricted to the chosen weekday for "this day only"). If the reference date is today and today's item has no log for the replaced exercise yet, also insert today's override, so the swap covers today too.
- Create the new exercise first when `replacement.new` is set (slug unique; if it exists by then, reuse it).
- Reply: `Saved. <same change line>` with an **Undo** button (`up:<sourceKey>:<idx>`, independent review; matches the `uw:`/`us:` undo pattern).
- **Concurrency:** the version number is `max(version)+1` inside the transaction; the `(plan_id, version)` unique constraint turns a race into a retry-safe failure ("plan changed meanwhile, try again").

### Undo of a plan change (independent review)

`up:<sourceKey>:<idx>` reads the ledger result (`versionId`, `overrideIds`, `createdExerciseId`). Undo succeeds only when:
- the version (if any) is still the highest version of the plan, and no `session_items`, `log_groups` or `suggestions` row references its planned items, and no open pending action's jsonb mentions one of its planned item ids;
- each override has no log group for the replacement exercise on its date.

Then, in one transaction: delete the overrides, then the version's `planned_item_options`, `planned_items`, `plan_weeks` and the `plan_versions` row, then the created exercise if nothing references it. Reply `Undone. The plan is back as it was.` Otherwise reply `Too late to undo: it's already in use. Swap back instead.` and change nothing. With `effective_from >= tomorrow`, the undo window is naturally "until the change is first used". A second tap → "Already undone."

The same Undo button follows an accepted deload move (source key `r:<proposalId>`, ledger row written on ✅); its undo also sets the proposal to `declined`, so it is not asked again until the trigger resets.

### `/swap` command

- `/swap` alone → short help: `Tell me what to swap, e.g. "swap face pulls for band pull-aparts only today". Today: <exercise names>.`
- `/swap <text>` → the text goes through the normal AI pipeline (same as free text), so all the rules above apply.

## Deload earlier

### When it is proposed

Replaces today's text hint (`earlierDeloadHint` / `deloadHint` keep their trigger rule: the last two frozen session levels RED, or the last two weekly recovery scores ≤ 2). It becomes a `proposals` row of kind `earlier_deload` (the enum value already exists), created when `/today` computes live advice for today (the same hook `hspuProposal` uses in src/bot/inputs-flow.ts; M8's morning message can call the same function) and:

- the trigger fires,
- the week after the current week exists in the effective version, is not a deload and is not the test week, and at least one week exists after it to shift (independent review),
- **asked once until the trigger resets** (independent review, mirrors the HSPU "a no is respected until the next HSPU log" rule): no new proposal while an `earlier_deload` proposal exists (open, accepted or declined) that was created after the last moment the trigger was off. "Trigger off" = a frozen session level that is not RED, or a weekly recovery score > 2, recorded after that proposal. An open proposal whose `mondayDate` has arrived is set to `expired`.

Payload: `{ currentWeek, insertAt: currentWeek + 1, mondayDate, versionId }`.

### What the user sees

A **separate card sent after the session view** (independent review: exactly like `hspuProposal`, deduped by `proposals.message_id`), replacing the old text hint at src/bot/format.ts:354. Code-built text:

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

On ✅: refuse if `mondayDate` is today or earlier ("This proposal expired; nothing changed.") or if a newer version was created after the proposal (`versionId` no longer latest → "The plan changed since; I'll ask again if needed."), and re-check that week `insertAt` is still not a deload or the test week. Else create the version (`effective_from = mondayDate`, `change = { kind: "deload_earlier", insertedWeek, droppedWeek }`) in one transaction with the proposal's status change and a `write_ledger` row (`r:<proposalId>`, index 0) holding `{ kind: "plan_change", versionId, overrideIds: [], createdExerciseId: null }`, then refresh `user_state` as after any write. Reply with the change line and the Undo button.

Weekly metrics stay keyed by `plan_week`: only future weeks shift, so past numbers never change meaning.

## Telegram surface

- New callback prefix `sw:<pendingId>:t|r|d|a` (scope / days answers on a swap pending). Handled before the generic callback handler; stale or replaced pendings reply "this expired, nothing saved" like other pendings.
- New callback prefix `up:<sourceKey>:<idx>` (Undo of a plan change; source key `p:<pendingId>` for swaps, `r:<proposalId>` for an accepted deload move).
- `pr:<id>:ok|no` now also handles `earlier_deload`.
- `/swap` registered in `setMyCommands` (scripts/telegram-setup.ts) and listed in the help text.
- `/plan` gains a "Changes" section: `• From Tue 20 Oct: Face pull → Band pull-apart (Mon, Fri)` / `• From Mon 9 Nov: deload moved to W7 (W8 deload dropped)`.
- Today's session marks a one-off swap: `Band pull-apart (instead of Face pull today)`.

## Data model changes (migration 0007)

- `plan_versions.change jsonb` nullable.
- New table `session_overrides` as above, RLS enabled, no policies (the RLS db test covers it).
- `PENDING_KINDS` / staged-action union: a new staged action `swap` (jsonb, no enum change unless the code needs a new `pending_kind`; if so, add it in the same migration).
- If M8 or M9 lands a migration on `dev` first, sync and regenerate this one before the PR.

## Tests that must exist

- `insertDeload`: the three examples above; insert right before the test week; template choice; keys unique; weeks contiguous; drop rule at exactly 3 weeks (kept) and 2 (dropped).
- Version copy: identical rows before `effective_from`, swap applied only on/after it, only on the chosen weekday for "this day only", OR item keeps the other option, `item_key` preserved, HSPU step cleared.
- `planDayOn`: date in v1 range after v2 exists renders v1; date after v2 renders v2; week straddling two versions in `/week`; finished uses the version's week count (W13 after an insert is not "finished"); override applied only on its date, with RIR recomputed.
- Undo: undo right after ✅ deletes version + override; undo after a log/suggestion references the version is refused; undo twice → "Already undone."; deload undo sets the proposal to declined.
- RIR: swapping a main lift for a non-main weighted exercise gives 1–3 on non-deload items and 3–4 on deload items.
- History import guard: a row dated on/after a version-2 `effective_from` is refused.
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

## Open points for the user

No strong disagreement with the independent answers; all were adopted. Two points worth a look:

1. **Deload drop threshold.** SPEC §6 says the next deload is dropped if it is "< 3 weeks away". Implemented literally: start dates less than 21 days apart → dropped; exactly 21 days → kept. At exactly 21 days only 2 training weeks sit between the two deloads, against the plan's 3-on/1-off rhythm. If you'd rather drop it unless 3 full training weeks sit between them (≤ 21 days → dropped), it is a one-line change in `src/plan/deload.ts`.
2. **No proposal before the test week.** The deload move is not proposed when next week is the test week (W12), so a late-plan fatigue streak gets no deload offer. (Independent review's call.)
