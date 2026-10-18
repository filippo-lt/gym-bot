# M7 Plan Changes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Exercise swaps with a scope (one-off overrides or a new plan version) and "move the next deload earlier", with every plan reader using the version effective on its date.

**Architecture:** A new `src/plan/` module owns plan versions: `effective.ts` (the one reader, `planDayOn`), `versions.ts` (full-copy version creation), `deload.ts` and `swap-transform.ts` (pure transforms). Existing readers become thin layers over `planDayOn` / `loadVersionIndex`. Swaps are a new staged action going through the existing pending/confirm-card machinery; the deload move is an `earlier_deload` proposal using the existing `pr:` buttons.

**Tech Stack:** TypeScript strict, Drizzle + postgres-js, grammY, Vitest (projects `unit` and `db`), Luxon, Zod, Biome.

**Spec:** `docs/superpowers/specs/2026-10-18-m7-plan-changes-design.md` (read it in full before any task).

## Global Constraints

- Read `CLAUDE.md` first. Anything with a number shown to the user is computed and formatted in code, never taken from model text.
- History is never rewritten: no UPDATE/DELETE of `log_groups`, `log_entries`, `session_items`, `suggestions`, `weekly_metrics` rows because of a plan change.
- A persistent change has `effective_from >= tomorrow` (Rome, 03:00 boundary, use `src/domain/calendar.ts` helpers). The deload insert uses next Monday.
- Version lookup rule: highest `version` of the newest plan with `effective_from <= date`, else the lowest version.
- New tables: RLS enabled, no policies (`.enableRLS()`), exported from `src/db/schema/index.ts`.
- Callback data ≤ 64 bytes. New prefix: `sw:<pendingId>:t|r|d|a`.
- Replies: short, simple English.
- DB access: never `Promise.all` queries on the same connection (session pooler pipelining hazard, see CLAUDE.md). Sequential awaits.
- Commits: author `filippo-lt <filippo.tosetto@leadtech.com>` (`git commit --author=...`), concise message, no AI attribution lines.
- Every task ends green on: `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm test:db` when it touches the DB (needs `pnpm db:up`).
- Do not touch M8 (morning message, charts) or M9 (backup/export, cost guard) files.

## Review Focus

1. A past date after a plan change: `/session mon` for last week must render exactly as before (same items, same stored suggestions). Test in Task 5.
2. A week that straddles two versions (swap saved on a Tuesday): `/week` must count Mon from v1 and Wed–Fri from v2 without losing statuses. Test in Task 5.
3. The day after a deload insert that made the plan 13 weeks: a date in W13 must render, not "plan finished". Test in Task 4.
4. ✅ tapped twice (or a webhook retry) on a swap card must create one version, not two. Test in Task 8.
5. The replacement exercise's first session must not show "back after a break" because the replaced exercise's earlier occurrences look missed. Test in Task 6.

---

### Task 1a: Amend Tasks 1–2 after the independent design review

Spec changes after Tasks 1–2 were built: week count is derived from `plan_weeks` rows (no column), swapped items get RIR recomputed and `fallback_prescription` cleared with the HSPU step.

**Files:** `src/db/schema/plan.ts`, `drizzle/0007_*` + `drizzle/meta` (regenerate), `src/db/seed-plan.ts`, `test/db/plan-seed.test.ts`, `src/plan/swap-transform.ts`, `test/plan/swap-transform.test.ts`

**Interfaces:**
- Produces: `applySwap(content, s: { fromExerciseId; toExerciseId; fromDate; weekdays; clearHspuStep: boolean; rirFor: (item: ItemSpec, newOptionIds: number[], weekIsDeload: boolean) => { rirMin: number | null; rirMax: number | null } })`. Changed items get `rirMin/rirMax` from `rirFor`; when `clearHspuStep`, also `fallbackPrescription = null`. Callers build `rirFor` from `computeRir` (src/plan-import/rir.ts) with exercise rows from the DB.

- [ ] Remove `plan_versions.weeks` from the schema, delete the generated `drizzle/0007_*.sql` + its snapshot/journal entry, regenerate so 0007 contains only `change` + `session_overrides`; revert the seed's `weeks` write and its test assertion (keep the `change` null assertion). Add indexes on `session_overrides.planned_item_id` and `replacement_exercise_id` (deferred minor from Task 1).
- [ ] Tests: `applySwap` recomputes RIR via `rirFor` only on changed items (stub returns a marker value); `clearHspuStep` nulls `fallbackPrescription` on changed items only.
- [ ] Lint, typecheck, unit, db green. Commit `M7: derive week count from plan_weeks; RIR and fallback on swapped items`.

### Task 1: Schema + migration 0007

**Files:**
- Modify: `src/db/schema/plan.ts` (plan_versions: `weeks`, `change`; new `sessionOverrides`)
- Modify: `src/db/schema/index.ts`
- Create: `drizzle/0007_*.sql` via `pnpm db:generate`, then hand-edit
- Modify: `src/db/seed-plan.ts` (set `weeks` when creating version 1)
- Test: `test/db/migrate.test.ts` (or the existing RLS test file) + `test/db/plan-seed.test.ts`

**Interfaces:**
- Produces:
  - `planVersions.weeks: integer not null`, `planVersions.change: jsonb<PlanChange | null>`
  - `type PlanChange = { kind: "swap"; from: number; to: number; weekdays: Weekday[] | "all"; fromDate: string } | { kind: "deload_earlier"; insertedWeek: number; droppedWeek: number | null }` exported from `src/plan/types.ts` (create the file with just this type).
  - `sessionOverrides` table: `id serial pk, sessionDate date(string) not null, plannedItemId int not null → planned_items.id, replacedExerciseId int not null → exercises.id, replacementExerciseId int not null → exercises.id, createdAt`, unique `session_overrides_slot_unique (session_date, planned_item_id, replaced_exercise_id)`, RLS on.

- [ ] **Step 1:** Add a db test asserting `plan_versions.weeks` exists and equals 12 after `seedPlan`, and `session_overrides` has RLS enabled with no policies (extend the existing RLS check if it iterates all tables; otherwise assert directly via `pg_class.relrowsecurity`).
- [ ] **Step 2:** Run `pnpm test:db` → FAIL.
- [ ] **Step 3:** Change the schema; `pnpm db:generate`; hand-edit the SQL so `weeks` is added nullable, backfilled with `UPDATE plan_versions pv SET weeks = p.weeks FROM plans p WHERE p.id = pv.plan_id`, then `SET NOT NULL`. `seedPlan` writes `weeks` on version 1.
- [ ] **Step 4:** `pnpm test:db` → PASS; `pnpm lint && pnpm typecheck && pnpm test`.
- [ ] **Step 5:** Commit `M7: schema for plan versions weeks/change and session overrides`.

### Task 2: Pure plan transforms (deload insert, swap)

**Files:**
- Create: `src/plan/deload.ts`, `src/plan/swap-transform.ts`, extend `src/plan/types.ts`
- Test: `test/plan/deload.test.ts`, `test/plan/swap-transform.test.ts`

**Interfaces:**
- Produces (in `src/plan/types.ts`):
  ```ts
  interface WeekSpec { week: number; phase: string; isDeload: boolean; isTest: boolean; startDate: string }
  interface ItemSpec {            // a planned_items row without id/planVersionId, plus its options
    itemKey: string; week: number; weekday: Weekday; itemOrder: number; subItem: number;
    /* every other planned_items column, same names as the Drizzle insert type */
    hspuStepId: number | null;
    optionExerciseIds: number[];  // in option_index order
  }
  interface PlanContent { weeks: WeekSpec[]; items: ItemSpec[] }
  ```
- Produces:
  - `insertDeload(content: PlanContent, insertAt: number): { content: PlanContent; droppedWeek: number | null }` (`src/plan/deload.ts`)
  - `applySwap(content: PlanContent, s: { fromExerciseId: number; toExerciseId: number; fromDate: string; weekdays: Weekday[] | "all"; clearHspuStep: boolean }): { content: PlanContent; changedItems: number }` (`src/plan/swap-transform.ts`)
  - `itemDate(content: PlanContent, item: ItemSpec): string` helper (week start + weekday offset).

- [ ] **Step 1: Write the failing tests** using a builder for a 12-week content (deloads W4, W8, test W12, start 2026-09-28, two items per weekday Mon/Tue/Fri):
  - `insertDeload(c, 7)` → 12 weeks, W7 `isDeload`, phase "Deload", W7 items are copies of old W8's items with keys `d07-…`, old W7 items now `week 8`, old W8 gone, `droppedWeek === 8` (old number), W9–12 unchanged numbers, start dates contiguous (each = start + 7·(week−1)).
  - `insertDeload(c, 6)` → 13 weeks, deloads at 4, 6, 9, `droppedWeek === null`.
  - `insertDeload(c, 11)` → 13 weeks, template = old W8, test week is W13.
  - `insertDeload(c, 12)` (right before test) → test week is W13, never dropped.
  - Every result: `itemKey` unique, week numbers 1..n with no gap.
  - `applySwap`: items before `fromDate` untouched; items on/after with the exercise swapped in `optionExerciseIds`; an OR item `[squat, hack]` swapping hack→legpress gives `[squat, legpress]`; when `to` already in options it isn't duplicated; `weekdays: ["tue"]` leaves Friday items; `clearHspuStep` nulls `hspuStepId` only on changed items; `changedItems` counts them; keys preserved.
- [ ] **Step 2:** `pnpm exec vitest run --project unit test/plan` → FAIL.
- [ ] **Step 3:** Implement. Drop rule: after the shift, the first deload week with `week > insertAt` is dropped if `(itsStart − insertedStart) < 21 days` and it is not a test week; later weeks move back by one. Template: first deload week `>= insertAt` in the original content, else the last deload week `< insertAt`; if no deload exists at all, throw.
- [ ] **Step 4:** Tests PASS.
- [ ] **Step 5:** Commit `M7: pure deload insert and swap transforms`.

### Task 3: Version creation (DB)

**Files:**
- Create: `src/plan/versions.ts`
- Test: `test/db/plan-versions.test.ts`

**Interfaces:**
- Consumes: Task 1 schema, Task 2 `PlanContent`, `insertDeload`, `applySwap`.
- Produces:
  - `loadLatestContent(tx: Q, planId: number): Promise<{ versionId: number; version: number; content: PlanContent }>`
  - `createVersion(tx: Q, args: { planId: number; baseVersionId: number; content: PlanContent; effectiveFrom: string; reason: string; change: PlanChange }): Promise<{ versionId: number; version: number }>` — inserts plan_versions (`version = max+1`, `weeks = content.weeks.length`, hashes copied from base), plan_weeks, planned_items, planned_item_options. Throws `StaleBaseVersionError` if `baseVersionId` is no longer the latest version. Must run inside the caller's transaction.

- [ ] **Step 1:** db tests on a seeded small plan (reuse the item builder style of `test/db/plan-seed.test.ts`): `createVersion(applySwap(...))` yields version 2 with the same row counts, keys preserved, swapped options only from `effectiveFrom`; v1 rows untouched (compare a full select before/after); `weeks` = 13 after `insertDeload(…, 6)`; a stale `baseVersionId` throws `StaleBaseVersionError`; existing `log_groups`/`session_items` row counts unchanged.
- [ ] **Step 2:** FAIL. **Step 3:** Implement (batch inserts; map old item id → new id for options). **Step 4:** PASS.
- [ ] **Step 5:** Commit `M7: create plan versions as full copies`.

### Task 4: The effective-plan reader

**Files:**
- Create: `src/plan/effective.ts`
- Test: `test/db/plan-effective.test.ts`

**Interfaces:**
- Consumes: Task 1 schema, Task 3 `createVersion` (tests only).
- Week count = number of `plan_weeks` rows of the version (no column). For an overridden item, recompute `rirMin/rirMax` with `computeRir` using the replacement as the option, the item's modifiers and the week's deload flag.
- Produces (exact shapes from the spec section "The central reader"): `versionOn`, `loadVersionIndex` (returns `{ versions; versionFor(date): VersionInfo | null; weekOf(date): WeekInfo | null; fridayOf(week: number, asOf: string): string }`), `planDayOn`, types `VersionInfo { planId; versionId; version; startDate; weeks; effectiveFrom }`, `WeekInfo { versionId; week; phase; isDeload; isTest; startDate }`, `PlanDay`, `PlanDayItem`. Also `planDaysBetween(db, from, to): Promise<PlanDay[]>` for `/week` (one version index load, then per-day items).

- [ ] **Step 1:** db tests: no plan → `no_plan`; before start; Saturday → `rest` with week info; v2 effective 2026-10-20: 2026-10-19 renders v1 items, 2026-10-20 renders v2; after an insert making 13 weeks, a W13 date is `day`, the day after W13 is `finished`; an override on 2026-10-19 swaps that item's option only on that date (`swappedToday` set), not on 2026-10-26; an OR item override keeps the other option.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. `planWeekFor` (calendar.ts) with the version's `weeks`. **Step 4:** PASS.
- [ ] **Step 5:** Commit `M7: planDayOn, the one plan reader`. Then update `side-session-notes/.../m7-plan-reads.md` (orchestrator does this, not the subagent).

### Task 5: Switch bot/query/logging readers to the effective plan

**Files:**
- Modify: `src/db/import-history.ts` (guard: refuse rows dated on/after the first `effective_from` of a version > 1, clear error), `src/bot/session.ts` (`getSession`, `getWeek`, `loadWeekRow`), `src/logging/plan-context.ts` (`loadPlanContext`, `weekRefFor`, `loadDayPlan`), `src/logging/resolve.ts` (make-up walk uses per-date context), `src/logging/skip.ts` if it reads weeks, `src/queries/plan-overview.ts`, `src/queries/history.ts`, `src/queries/read-tools.ts` (`historyWindow`, `plan_finished`), `src/queries/alternatives.ts` ("where planned" = items of the version effective today, dates ≥ today), `src/jobs/class-question.ts`, `src/bot/format.ts` (`formatFinished` → "The plan is finished."), `src/logging/types.ts` + `src/ai/tools.ts` (`plan_week` max 52, description "plan_week (week number of the plan)"; code rejects a week beyond the version's `weeks`).
- Test: extend `test/db/bot-session.test.ts`, `test/db/queries.test.ts`, `test/db/logging-flow.test.ts` (make-up), unit snapshots as needed.

**Interfaces:**
- Consumes: Task 4 `planDayOn`, `planDaysBetween`, `versionOn`, `loadVersionIndex`.
- Produces: unchanged public signatures of `getSession`, `getWeek`, `loadDayPlan`, `getPlanOverview` (callers untouched). `SessionItem` gains `swappedFrom: string | null` (name of the replaced exercise, for "instead of X today").

- [ ] **Step 1:** db tests: (a) `getSession` for a past date returns deep-equal results before and after creating v2 (swap) and v3 (deload insert); (b) a week straddling v1/v2 — Monday logged in v1 shows done in `getWeek`, Wednesday counts v2 items; (c) `getPlanOverview` after an insert shows 13 weeks and the moved deload; (d) a make-up on Tuesday for Monday's v1 item still matches when v2 is effective from Tuesday; (e) class question job runs in W13 of a 13-week version; (f) history import refuses a row dated on/after a version-2 `effective_from`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement: `getSession`/`loadDayPlan` build from `planDayOn` and keep their extra joins (status, groups, HSPU step name, Thursday class). Remove the duplicated version lookup in `loadPlanContext` (delegate to `versionOn`). **Step 4:** All four commands pass full suite.
- [ ] **Step 5:** Commit `M7: plan readers use the version effective on the date`.

### Task 6: Switch progression readers

**Files:**
- Modify: `src/progression/load-history.ts` (`loadPlanEnv`/`versionIdFor`/`weekFor`/`fridayOfWeek` → `loadVersionIndex`; `loadOccurrences` per-week effective version; `loadSessionInput` from `planDayOn` so overrides apply), `src/progression/store.ts` (`ensureSuggestions` stores suggestions for the shown exercise of an overridden item), `src/progression/session-advice.ts` (`storedAdvice` picks the suggestion for the exercise shown on that date), `src/queries/read-tools.ts` (`e1rmFact`).
- Test: `test/db/progression.test.ts`, `test/db/progression-bot.test.ts`.

**Interfaces:**
- Consumes: Task 4 `loadVersionIndex`, `planDayOn`.
- Produces: no new public API; `PlanEnv` removed or re-exported as an alias of the version index.

- [ ] **Step 1:** db tests: (a) Review Focus 5 — face pull logged W1–W5 Mondays, v2 from W6 Monday swaps to band pull-apart; W6 Monday `ensureSuggestions` for the band pull-apart has no `back after a break` label; (b) the face pull is not "missed" in W6+ (no break label on any remaining face-pull item); (c) an override today on a weighted item stores a suggestion row keyed by the replacement exercise and `/today` shows it; (d) the existing M5 hand-simulation fixtures still pass unchanged.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS incl. fixtures.
- [ ] **Step 5:** Commit `M7: progression reads the plan per date`.

### Task 7: Swap intent and staging

**Files:**
- Modify: `src/ai/tools.ts` (`swap_exercise` schema + description), `src/ai/prompt.ts` (when to call it; never after just listing alternatives), `src/logging/types.ts` (`SwapExerciseInput` Zod schema, staged action `swap`), `src/logging/resolve.ts` (dispatch), `src/logging/policy.ts` (`swap` → always a card; reason `plan_change`; missing scope/days → question)
- Create: `src/plan/swap-stage.ts` (resolution), `src/bot/plan-change-format.ts` (card texts)
- Test: `test/plan/swap-stage.test.ts` (pure parts), `test/db/plan-swap.test.ts`, `test/bot/plan-change-format.test.ts`, `test/ai/tools.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/logging/types.ts
  type StagedAction = ... | { kind: "swap"; input: SwapExerciseInput; resolved: ResolvedSwap }
  interface ResolvedSwap {
    from: { id: number; name: string };
    to: { id: number | null; name: string; slug: string; isNew: boolean;
          newSpec: { type: ExerciseType; loadBasis: LoadBasis | null; equipmentSlug: string | null; muscleGroup: string } | null };
    referenceDate: string;              // YYYY-MM-DD
    scope: "today" | "rest" | null;     // null = ask
    days: "this_day" | "every_day" | null;
    referenceWeekday: Weekday;
    futureWeekdays: Weekday[];          // weekdays with the exercise in future items of the latest version
    todayItemIds: number[];             // items on referenceDate with the exercise (after overrides)
    loggedOnReference: boolean;         // a log group for `from` exists on referenceDate
    affectedSessions: number;           // future sessions changed by "rest", for the card
  }
  // src/plan/swap-stage.ts
  resolveSwap(db: Q, input: SwapExerciseInput, today: string): Promise<{ ok: true; resolved: ResolvedSwap } | { ok: false; reply: string }>
  // src/bot/plan-change-format.ts
  swapScopeQuestion(r: ResolvedSwap, pendingId: number): { text: string; buttons: [label: string, data: string][] }
  swapDaysQuestion(r: ResolvedSwap, pendingId: number): { text: string; buttons: [label: string, data: string][] }
  swapCardText(r: ResolvedSwap): string
  ```
- `cb.swap(pendingId, ans: "t" | "r" | "d" | "a")` → `sw:<id>:<ans>`; `parseCallback` returns `{ t: "sw"; id; ans }`.

- [ ] **Step 1:** Tests: tool schema rejects unknown `type` / `load_basis`; `resolveSwap` cases from the spec's "Resolution" list (reference day fallback to the next session; exercise not in plan → reply; same exercise → reply; catalog slug wins over `new`; `futureWeekdays` for squat Tue+Fri = `["tue","fri"]`); `decidePolicy` with a swap → confirm card always; card texts for "today" / "rest" / new exercise match the spec examples (dates via code, "14 sessions" from `affectedSessions`); callback round-trip and ≤ 64 bytes.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `M7: swap_exercise tool and staging`.

### Task 8: Saving swaps, `sw:` buttons, `/swap`, rendering

**Files:**
- Modify: `src/logging/execute.ts` (`swap` execution through `write_ledger`), `src/logging/types.ts` (`LedgerResult` kind `swap`), `src/bot/logging-flow.ts` (scope/days questions on the pending card, `sw:` handling, card refresh), `src/bot/callbacks.ts`, `src/bot/bot.ts` (`/swap` command + `setMyCommands`), `src/bot/format.ts` ("Band pull-apart (instead of Face pull today)"), `src/queries/plan-overview.ts` + `src/bot/query-format.ts` ("Changes" section from `plan_versions.change`)
- Test: `test/db/plan-swap.test.ts` (flow), `test/bot/callbacks.test.ts`, `test/bot/query-format.test.ts`

**Interfaces:**
- Consumes: Task 3 `createVersion`/`loadLatestContent`, Task 2 `applySwap`, Task 7 types and formatters.
- Produces: `executeSwap(tx: Q, r: ResolvedSwap, today: string): Promise<PlanChangeResult>` with `PlanChangeResult = { kind: "plan_change"; overrideIds: number[]; versionId: number | null; createdExerciseId: number | null }` (also the `LedgerResult` variant). `undoPlanChange(tx: Q, sourceKey: string, index: number): Promise<{ ok: true } | { ok: false; reply: string }>` in `src/plan/undo.ts`. `cb.undoPlan(key, idx)` → `up:<key>:<idx>` (key `p:\d+` or `r:\d+`).
- `today` and `effective_from` are computed at ✅ time; the base version is the latest at ✅ time. `rirFor` built from `computeRir`.

- [ ] **Step 1:** db tests through the bot flow (fake model staging a `swap`): no scope → scope buttons; tap `r` on squat (Tue+Fri) → days buttons; tap `d` → card; ✅ → version 2 with Fri untouched, today override when the reference is today; ✅ again / retry → still one version (ledger); "today" when already logged → refusal, no rows; new exercise created once with the card's classification; `effective_from` = tomorrow when reference is today; stale `sw:` tap on an expired pending → "this expired, nothing saved"; `/swap` alone lists today's exercise names; `/plan` shows the change line; Undo right after ✅ restores the plan (version and override gone); Undo after a log references the version → "Too late to undo"; Undo twice → "Already undone."; swapping HSPU to an HSPU ladder step name → reply, no write; RIR of a main-lift → non-main swap is 1–3.
- [ ] **Step 2:** FAIL. **Step 3:** Implement (one transaction: ledger claim, exercise create, override(s), version). Catch `StaleBaseVersionError` / unique violation → "The plan changed meanwhile, try again." **Step 4:** PASS.
- [ ] **Step 5:** Commit `M7: save swaps, scope buttons, /swap`.

### Task 9: Deload-earlier proposal

**Files:**
- Modify: `src/progression/session-advice.ts` (expose the trigger boolean instead of the text hint), `src/progression/readiness.ts` (keep the trigger, update the comment), `src/bot/format.ts` (remove the text hint), `src/bot/inputs-flow.ts` (`deloadProposal(ctx, advice)` sent after the session view exactly like `hspuProposal`; `pr:` handler for `earlier_deload`), `src/bot/bot.ts` (call it after `/today`)
- Create: `src/plan/deload-proposal.ts` (create + apply), card text in `src/bot/plan-change-format.ts`
- Test: `test/db/plan-deload.test.ts`, `test/bot/plan-change-format.test.ts`

**Interfaces:**
- Consumes: Task 2 `insertDeload`, Task 3 `createVersion`, Task 4 `versionOn`/`loadVersionIndex`.
- Produces:
  - `ensureDeloadProposal(db: Q, today: string, triggered: boolean): Promise<{ id: number; preview: DeloadPreview; messageId: number | null } | null>` — asked once until the trigger resets (spec "When it is proposed"); expires open proposals whose `mondayDate` arrived; none when next week is a deload or the test week or no later week exists.
  - `DeloadPreview { insertedWeek; mondayDate; sundayDate; shiftedFrom; shiftedTo; droppedWeek: number | null; newWeeks; endDate }`
  - `applyDeloadProposal(tx: Q, proposalId: number, today: string): Promise<{ ok: true; versionId } | { ok: false; reply: string }>` — writes ledger row `r:<proposalId>`/0 with a `plan_change` result; the reply carries the `up:r:<id>:0` Undo button (Task 8's `undoPlanChange`; on a deload undo the proposal becomes `declined`).
  - `deloadProposalText(p: DeloadPreview): string` (spec example wording).

- [ ] **Step 1:** db tests: two RED sessions → `/today` sends the card once (separate message); a second `/today` while still RED → no new card; after a GREEN session and two new REDs → asked again; next week already deload or the test week → none; Undo after ✅ → version gone, proposal declined; ✅ → version with `effective_from` = next Monday and `change.kind = "deload_earlier"`; ✅ on Monday or later → "This proposal expired; nothing changed."; ✅ when another version was created after the proposal → refused; ❌ → declined, not asked again that week; unit test for the text with the W6 example (dropped W8, "still ends Sun 20 Dec").
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `M7: deload-earlier proposal applies a new plan version`.

### Task 10: Docs, golden cases, demo script

**Files:**
- Modify: `test/golden/logging.golden.test.ts` (2 swap phrases from the spec), `CLAUDE.md` (Architecture: "Plan versions (M7, `src/plan/`)" section; callback list gains `sw:` and `pr:` earlier_deload), `docs/STATUS.md` (M7 row, what happened, open items incl. "apply migration 0007 before merging"), `SPEC.md` §5.5 only if behaviour diverged (it should not)
- Create: `docs/m7-demo.md` (short Telegram demo script)

- [ ] **Step 1:** Write the docs. **Step 2:** `pnpm lint && pnpm typecheck && pnpm test && pnpm test:db` green. **Step 3:** Commit `M7: docs and demo script`.
