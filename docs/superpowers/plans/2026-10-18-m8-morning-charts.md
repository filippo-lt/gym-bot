# M8 Morning message + charts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A 06:00 Mon–Fri morning message (today's adjusted session + readiness buttons that re-render it in place), and chart images via `/chart` and the `render_chart` chat tool.

**Architecture:** The morning job is a new `Job` in `src/jobs/` that renders through the same `getSession` + `loadSessionAdvice` + `formatSession` path as `/today`. Charts live in a new `src/charts/` module: pure series builders over `SessionRec` (the engine's own history records), Vega-Lite spec builders, and one renderer (Vega headless SVG → `@resvg/resvg-js` PNG with a bundled font). `/chart` and `render_chart` both call one `buildChart` entry point.

**Tech Stack:** TypeScript (ESM, Node 24), grammY, Drizzle/postgres-js, Luxon, Vitest, `vega` 6, `vega-lite` 6, `@resvg/resvg-js` 2.6.

**Spec:** `docs/superpowers/specs/2026-10-18-m8-morning-charts-design.md` (read it; the decisions there are binding). Also CLAUDE.md, SPEC.md §5.2, 5.6, 5.6c, 5.7, 5.8.

## Global Constraints

- Every number shown to the user (message, image, caption) is computed and formatted in code; the model only phrases text and the number guard still applies.
- Callback data ≤ 64 bytes. New prefixes only: `rd:<t|o|s>:m:<yyyymmdd>`, `ch:<exerciseId>` and `ch:v` (volume). The old `rd:<t|o|s>` keeps working unchanged.
- Do not change `bot.ts` `sendSession` or what `/today` renders (M7 edits that area). Do not query `planned_items` from new code; go through `getSession` / `loadSessionAdvice`.
- Job registration is additive: append to `JOBS` in `src/jobs/index.ts`; M9 adds its own entry.
- No migration, no new env vars.
- Renderer: no native build, no network call. Fonts: bundled file only (`loadSystemFonts: false`).
- Units on chart axes: barbell total incl. bar → "kg"; dumbbells → "kg per hand"; machines → "kg (stack)"; pull-ups → "kg system load".
- Commits: `git -c user.name=filippo-lt -c user.email=filippo.tosetto@leadtech.com commit` (or the configured identity, which is already filippo-lt). No AI attribution lines. Commit only your own task's files (`git add <paths>`, never `git add -A`): another task may be running in the same worktree.
- Before reporting done: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:db` (Postgres is up on 127.0.0.1:54329).

## Review Focus

1. **DST:** the morning tick on Mon 26 Oct 2026 (05:00Z = 06:00 CET) must send; 04:45Z must not. Covered in Task 6 tests.
2. **A readiness tap on yesterday's morning message** must write nothing and say so; Telegram refuses edits after 48 h anyway. Covered in Task 7.
3. **Pull-up sessions with no bodyweight** must not plot a load point (system load unknown) but still plot reps. Covered in Task 2.
4. **An exercise with only imported sessions lacking per-set data** (`perSetUnknown`): no e1RM point, no crash; sessions with valid sets are marked `estimate`. Covered in Task 2.
5. **A caption or tool result with an unformatted float** (e.g. `92.50000001`) leaking to the user. Values must go through the existing kg formatter. Covered in Task 3 caption tests.

---

## Execution order

Two tracks can run in parallel because their files don't overlap: **Track A** (Tasks 1 → 2 → 3) and **Track B** (Tasks 6 → 7). Then Task 4 (after 3 and 7, it touches `callbacks.ts` / `bot.ts`), then Task 5, then Task 8 (docs, orchestrator).

---

### Task 1: Chart renderer foundation

**Files:**
- Modify: `package.json` (deps `vega@^6.4.0`, `vega-lite@^6.5.0`, `@resvg/resvg-js@^2.6.2`), `pnpm-lock.yaml`, `vercel.json`
- Create: `assets/fonts/<OFL font>.ttf` + its `OFL.txt` license; `src/charts/render.ts`
- Test: `test/charts/render.test.ts`

**Interfaces:**
- Produces: `renderPng(spec: TopLevelSpec, opts?: { width?: number }): Promise<Buffer>` in `src/charts/render.ts`. Compiles Vega-Lite → Vega, `new View(parse(spec), { renderer: "none" }).toSVG()`, then `new Resvg(svg, { font: { loadSystemFonts: false, fontFiles: [FONT_PATH], defaultFontFamily: FONT_FAMILY }, fitTo: { mode: "width", value: opts.width ?? 1000 }, background: "white" }).render().asPng()`.
- Produces: `export const FONT_FAMILY: string` (the family name to put in Vega-Lite `config.font`).

- [ ] **Step 1:** Add the three deps with `pnpm add`. Check `pnpm-lock.yaml` lists `@resvg/resvg-js-linux-x64-gnu` among the optional platform packages (needed on Vercel/CI). If pnpm's build-script allowlist complains, resvg has no install script, so nothing should be needed. Report if it does.
- [ ] **Step 2:** Pick an OFL sans font (Inter or DejaVu Sans; a single Regular TTF is enough), commit it under `assets/fonts/` with its license. Resolve its path with `fileURLToPath(new URL("../../assets/fonts/<file>", import.meta.url))` so Vercel's tracer sees it, and also add `"includeFiles": "assets/fonts/**"` to the `api/telegram.ts` entry in `vercel.json` (belt and braces).
- [ ] **Step 3: Write the failing test** `test/charts/render.test.ts`: `renderPng` of a 3-point line spec returns a Buffer starting with the PNG signature `89 50 4E 47 0D 0A 1A 0A`; the IHDR width (bytes 16–19, big-endian) equals 1000; a second call with `{ width: 600 }` gives 600. Run: `pnpm exec vitest run --project unit test/charts/render.test.ts`. Expected FAIL (module missing).
- [ ] **Step 4:** Implement `src/charts/render.ts`. Run the test. Expected PASS. Make sure `vitest.config` includes `test/charts/**` in the unit project (add the glob if the project lists dirs).
- [ ] **Step 5:** Lint, typecheck, unit tests. Commit "M8: chart renderer (Vega-Lite → SVG → PNG)".

### Task 2: Chart series (pure) and history loader

**Files:**
- Create: `src/charts/series.ts` (pure), `src/charts/load.ts` (DB)
- Test: `test/charts/series.test.ts` (unit), `test/db/charts.test.ts` (db)

**Interfaces:**
- Consumes: `SessionRec`, `ExerciseInfo` from `src/progression/types.ts`; `validSets`, `sessionEstimate`, `systemLoadOf` from `src/progression/e1rm.ts`; `loadPlanEnv`, `loadExerciseInfos`, `loadSessionRecs` from `src/progression/load-history.ts`.
- Produces (in `series.ts`):
  ```ts
  export interface LoadPoint { date: string; week: number | null; e1rm: number | null; flagged: boolean; estimate: boolean } // flagged = deload or test week (shaded, never an e1RM point); estimate = import-only session
  export interface RepsPoint { date: string; week: number | null; bestSet: number | null; seconds: number | null; step: string | null; flagged: boolean }
  export type ChartKind = "load" | "load_reps" | "reps" | "hspu" | "timed" | "none";
  export function chartKindFor(type: ExerciseType): ChartKind;
  export function loadSeries(sessions: SessionRec[], ex: ExerciseInfo): LoadPoint[]; // oldest first
  export function repsSeries(sessions: SessionRec[], ex: ExerciseInfo, stepNames?: Map<number, string>): RepsPoint[]; // oldest first
  export interface VolumeCell { week: number; muscleGroup: string; sets: number }
  export function volumeSeries(rows: { week: number | null; muscleGroup: string; type: ExerciseType; sets: number }[], currentWeek: number): VolumeCell[];
  export const VOLUME_TYPES: readonly ExerciseType[]; // weighted, bodyweight_plus, bodyweight_reps, skill_ladder (NOT timed)
  ```
- Produces (in `load.ts`):
  ```ts
  export interface ExerciseHistoryData { ex: ExerciseInfo; name: string; sessions: SessionRec[]; stepNames: Map<number, string> } // sessions oldest first
  export async function loadExerciseChartData(db: Db, exerciseId: number, sinceDate?: string): Promise<ExerciseHistoryData | null>;
  export async function loadVolumeRows(db: Db, sinceDate?: string): Promise<Parameters<typeof volumeSeries>[0]>;
  ```

Rules (from the spec): e1RM per session = `sessionEstimate(s, ex)` → `max(strict, withPlus)` (same "4+ may raise" rule as the engine; check `currentE1rm` for exactly how it combines `strict` and `withPlus` and mirror it for a single session), null when no valid set (so deload/test/RED sessions never get an e1RM point). No top-set series: the design plots e1RM only. `flagged` = `isDeload || isTest`; `estimate` = `source === "import"`. Chart kinds: `weighted` → `load`; `bodyweight_plus` → `load_reps` (e1RM on system load + most reps); `bodyweight_reps` → `reps`; `skill_ladder` → `hspu`; `timed` → `timed`; `distance` → `reps`-style with the distance as the metric if logged (builder's call, document it), else `none`; `skill_practice`/`hiit`/`mobility` → `none`. Volume: one set = one `log_entries` row; for an imported group with no entry rows, use the group's stated set count if the schema has one, else 0, and document which.

- [ ] **Step 1: Write failing unit tests** in `test/charts/series.test.ts`, building `SessionRec`s by hand:
  - `loadSeries`: a session with sets `{reps 5, rir 2, loadKg 80}` and `{reps 5, rir null, loadKg 85}` → `e1rm` equals `setE1rm(80,5,2)` (the RIR-less 85 kg set doesn't count).
  - deload session → `flagged: true` and `e1rm: null`.
  - an import session with valid sets → `estimate: true`.
  - RED-readiness session → `e1rm: null`.
  - pull-up (`bodyweight_plus`) with `bwKg: null` → `e1rm: null`; the same session in `repsSeries` still has `bestSet`.
  - `perSetUnknown` import session → `e1rm: null`, no throw.
  - output is oldest first even when the input is newest first.
  - `repsSeries` for `skill_ladder` carries `step` from `stepNames` by `hspuStepOrder`.
  - `timed` → `seconds` = longest `durationS`.
  - `volumeSeries`: mobility, hiit and timed rows ignored; cells summed per (week, muscleGroup); weeks 1..currentWeek present (empty weeks produce no cells, the spec handles gaps); rows with `week: null` (outside the plan) dropped.
  - `chartKindFor` table above.
  Run: `pnpm exec vitest run --project unit test/charts/series.test.ts`. Expected FAIL.
- [ ] **Step 2:** Implement `series.ts`. Run. Expected PASS.
- [ ] **Step 3: Write failing db test** `test/db/charts.test.ts` using `resetAndSeed` from `test/db/logging-fixture.ts`: insert two squat log groups on different dates (and one hack squat group): `loadExerciseChartData(db, squatId)` returns 2 sessions oldest first, none of them hack squat; `loadVolumeRows` returns the squat's muscle group with the right set counts and plan weeks. Run `pnpm exec vitest run --project db test/db/charts.test.ts`. Expected FAIL.
- [ ] **Step 4:** Implement `load.ts` (reuse `loadPlanEnv` / `loadExerciseInfos` / `loadSessionRecs(…, null)` and reverse; exercise display name from `exercises.name`; HSPU step names from `hspu_ladder`). Run. Expected PASS.
- [ ] **Step 5:** Lint, typecheck, test, test:db. Commit "M8: chart series and loaders".

### Task 3: Chart specs, captions and `buildChart`

**Files:**
- Create: `src/charts/spec.ts`, `src/charts/caption.ts`, `src/charts/index.ts`
- Test: `test/charts/spec.test.ts`, `test/charts/caption.test.ts`, `test/db/charts.test.ts` (extend)

**Interfaces:**
- Consumes: Task 1 `renderPng`, `FONT_FAMILY`; Task 2 series and loaders.
- Produces (in `index.ts`):
  ```ts
  export type ChartMetric = "load" | "reps" | "auto"; // auto = by type (the /chart command)
  export type ChartRequest = { kind: "exercise"; exerciseId: number; metric: ChartMetric; weeks?: number } | { kind: "volume"; weeks?: number };
  export type ChartResult =
    | { ok: true; png: Buffer; caption: string; facts: Record<string, unknown> }
    | { ok: false; reason: "no_numbers" | "not_enough_data" | "unknown_exercise"; text: string };
  export async function buildChart(db: Db, req: ChartRequest, now: Date): Promise<ChartResult>;
  export const MIN_SESSIONS = 2;
  ```
- Produces (in `spec.ts`): `exerciseSpec(name: string, ex: ExerciseInfo, kind: ChartKind, load: LoadPoint[], reps: RepsPoint[], metric: ChartMetric): TopLevelSpec`, `volumeSpec(cells: VolumeCell[], currentWeek: number): TopLevelSpec`, `axisUnit(ex: ExerciseInfo): string`.
- Produces (in `caption.ts`): `exerciseCaption(...)`, `volumeCaption(...)`, plain text, HTML-escaped, ≤ 1024 chars.

Rules: `metric: "auto"` → by kind: `load` → e1RM panel; `load_reps` (pull-ups) → `vconcat` of e1RM over most-reps; `reps`/`hspu` → most-reps panel (HSPU: one colour per step); `timed` → seconds panel. `"load"` → the e1RM panel (on a kind without load: the reps/seconds panel instead, and `facts.note` says so). `"reps"` → most-reps panel (seconds for timed). Deload/test weeks shaded (a rect layer behind), no e1RM point there; `estimate` points hollow. x axis = formatted date strings (`"29 Sep"`, via Luxon) as an ordinal axis, so no "12 PM" ticks. Flagged points hollow (builder's call on style). Volume = stacked bars, x = `"W1"…"W<current>"` (all weeks shown, including empty), color = muscle group. `weeks` limits to sessions with `date >= today − 7·weeks`. Fewer than `MIN_SESSIONS` points with data → `not_enough_data`, text `Not enough data to chart <name> yet (<n> session).` / `(<n> sessions)`. Kind `none` → `no_numbers`, text `Nothing to chart for <name>: it's logged as done / skipped.` Caption (exercise with load): `<name> · e1RM <first> → <last> <unit> · <n> sessions since <d LLL>`, counting sessions with an e1RM point (fewer than 2 → `not_enough_data`); reps kinds use best-set reps (`best set <a> → <b> reps`); timed `<a> → <b> s`; HSPU names the current step; volume: `Weekly sets per muscle group · this week: <n> sets`. Format kg with the existing formatter used by `/history` (find it in `src/bot/query-format.ts` / `log-format.ts`; reuse, don't write a new one). `facts` mirrors the caption values (numbers already rounded the same way) plus `sessions`, `firstDate`, `lastDate`, for the chat tool.

- [ ] **Step 1: Write failing tests:** `spec.test.ts`: `axisUnit` returns "kg", "kg per hand", "kg (stack)", "kg system load" for barbell/dumbbell/machine/pull-up `ExerciseInfo`s (check `LoadBasis` values in `src/plan-import/types.ts`); `exerciseSpec(… "auto")` has a `vconcat` of length 2 for `load_reps` and a single panel (no `vconcat`) for `load` and `reps`; the x field is a string-typed ordinal; `volumeSpec` x domain is `["W1",…,"W5"]` for `currentWeek` 5. `caption.test.ts`: e1RM 85 → 92.50000001 renders "85 → 92.5 kg"; 1 vs 2 sessions wording; HTML in a name is escaped. Run unit. Expected FAIL.
- [ ] **Step 2:** Implement `spec.ts` and `caption.ts`. Run. Expected PASS.
- [ ] **Step 3: Extend `test/db/charts.test.ts`:** `buildChart` for squat with 2 sessions → `ok`, PNG signature; with 1 session → `not_enough_data`; for handstand → `no_numbers`; volume → `ok`. `buildChart` is the only export later tasks import, and they import it lazily (`await import("../charts/index.js")`), so keep `src/charts/index.ts` free of side effects at module load beyond the imports. Run db. Expected FAIL, then implement `index.ts`, run, PASS.
- [ ] **Step 4:** Lint, typecheck, test, test:db. Commit "M8: chart specs, captions, buildChart".

### Task 4: `/chart` command and `ch:` callback

**Files:**
- Modify: `src/bot/bot.ts` (new command + `ch:` handler next to the `hx:` one; do NOT touch `sendSession`), `src/bot/callbacks.ts` (`chart` builder + `parseChartCallback`, like `parseHistoryCallback`), `src/bot/log-format.ts` (`HELP_TEXT` line), `src/bot/query-format.ts` (usage + choice text if it fits there), `scripts/telegram-setup.ts` (`{ command: "chart", description: "Progress chart" }` after `history`)
- Test: `test/bot/callbacks.test.ts`, `test/bot/bot.test.ts` or a new `test/db/bot-chart.test.ts`

**Interfaces:**
- Consumes: `buildChart` (Task 3), `lookupExercise` (`src/queries/exercise-lookup.ts`, via `reads` seam), `formatHistoryChoice` pattern.
- Produces: `cb.chart(exerciseId: number | "v"): string` → `ch:<id>` / `ch:v`; `parseChartCallback(data: string): { exerciseId: number } | { volume: true } | null`. A `BotDeps.charts?: { buildChart: typeof buildChart }` test seam.

Behaviour: `/chart` (no arg) → usage `"Usage: /chart squat · /chart pull-up · /chart volume"` (exact wording builder's call) **plus buttons**: one per main lift (`exercises.is_main_lift`, `ch:<id>`) and one "Volume" (`ch:v`). Load `buildChart` lazily (`await import`). `/chart volume` → volume chart. `/chart <name>` → `lookupExercise`; one match → `buildChart({ kind: "exercise", exerciseId, metric: "auto" })`; ambiguous → choice buttons with `ch:<id>` (same layout as `/history`); unknown → the `/history` unknown text adapted to charts. `ok` → `ctx.replyWithPhoto(new InputFile(png, "chart.png"), { caption, parse_mode: "HTML" })`; not ok → `ctx.reply(text)`. `ch:<id>` tap → answer the callback, send the photo.

- [ ] **Step 1: Failing tests:** callbacks round-trip `ch:123`, `parseChartCallback("ch:x")` null, length ≤ 64. Bot tests with the transformer capturing API calls: `/chart` → `sendMessage` with usage and buttons including `ch:v`; `ch:v` tap → `sendPhoto`; `/chart volume` → `sendPhoto`; `/chart squat` (single match) → `sendPhoto` with the caption; ambiguous → `sendMessage` whose `reply_markup` buttons start with `ch:`; `ch:<id>` callback → `sendPhoto`. Use the `charts` seam with a fake `buildChart` in unit bot tests, and one real db test for `/chart squat`. Run. Expected FAIL.
- [ ] **Step 2:** Implement. Run. Expected PASS.
- [ ] **Step 3:** Lint, typecheck, test, test:db. Commit "M8: /chart command".

### Task 5: `render_chart` tool in chat

**Files:**
- Modify: `src/logging/types.ts` (`renderChartInputSchema`, `LoggingBackend.renderChart`), `src/ai/tools.ts` (`ToolName`, `READ_TOOLS`, tool def, `executeTool` case), `src/ai/prompt.ts` (one rule line), the backend implementation (find where `getExerciseHistory` is implemented for the flow, likely `src/queries/read-tools.ts` + the backend factory in `src/bot/logging-flow.ts`), `src/bot/logging-flow.ts` (send the photo after the reply), `src/ai/fake-model.ts` only if needed
- Test: `test/ai/tools.test.ts`, `test/db/logging-flow.test.ts` (or `read-tools.test.ts`)

**Interfaces:**
- Consumes: `buildChart`, `lookupExercise`.
- Produces: `renderChartInputSchema = z.object({ metric: z.enum(["load","reps","volume"]), exercise: z.string().min(1).max(60).optional(), weeks: z.number().int().min(1).max(52).optional() })`; `LoggingBackend.renderChart(input): Promise<ReadResult>`; the turn-level pending chart: the backend keeps `{ png, caption } | null` for the current message, readable by the flow after `runIntent` (builder's call how: a field on the backend object created per message is simplest).

Behaviour: tool description: "Read-only. Renders a progress chart image for an exercise (load = e1RM per session, reps = most reps in one set) or weekly volume per muscle group (hard sets); the image is sent after your reply. Returns the chart's key numbers. Call it when the user asks about trends, progress or a chart." Prompt rule: "For trend/progress/chart questions call render_chart; describe the trend in one or two sentences using only the numbers in its result; don't describe the image." Exercise missing for load/reps → `isError` result "exercise is required". Ambiguous/unknown → facts with `found: false` and candidates (same shape as `get_exercise_history`), no chart. Second call in the same message → `isError` "one chart per message". `not_enough_data` / `no_numbers` → facts with the text, no chart, `fallbackHtml` = that text. After the loop: in the no-staged-writes branch, after the reply is sent, if a chart is pending, `replyWithPhoto`, **also when the number guard rejected the reply and the code fallback was sent instead**. Import the chart module lazily. A chart never goes with a confirm card (if writes were staged, drop the chart). The number guard treats the tool's `facts` as a read (it already does for reads via `result.reads`).

- [ ] **Step 1: Failing tests:** `tools.test.ts`: `render_chart` is in `READ_TOOLS`; invalid metric → invalid-input error; `executeTool` calls `backend.renderChart`. Flow test with the fake model scripted to call `render_chart({ metric: "load", exercise: "squat" })` then reply "Your e1RM went from 85 to 92.5 kg." → one `sendMessage` with the text, then one `sendPhoto`; a reply with an unknown number (guard fallback) → fallback text, then still one `sendPhoto`; a script calling it twice → the second result is an error and one photo is sent; unknown exercise → no photo. Run. Expected FAIL.
- [ ] **Step 2:** Implement. Run. Expected PASS.
- [ ] **Step 3:** Add 2 golden phrases to the opt-in golden suite (`test/golden/`): "how is my squat going?" → `render_chart` with metric load and exercise squat; "show me my weekly volume" → `render_chart` metric volume. Don't run the golden suite (it costs API money); the orchestrator decides.
- [ ] **Step 4:** Lint, typecheck, test, test:db. Commit "M8: render_chart tool".

### Task 6: Morning job

**Files:**
- Create: `src/bot/morning.ts` (rendering), `src/jobs/morning.ts` (the job)
- Modify: `src/jobs/index.ts` (append `morningJob`), `src/bot/callbacks.ts` (`cb.readinessMorning(level, date)` → `rd:<l>:m:<yyyymmdd>` and its parse case; the `CallbackAction` `rd` variant gains optional `morningDate?: string`)
- Test: `test/jobs/morning-window.test.ts` (unit, or put it in an existing unit dir the vitest config covers), `test/db/jobs.test.ts` (extend with a `describe("morning job")`), `test/bot/callbacks.test.ts`

**Interfaces:**
- Consumes: `getSession` (`src/bot/session.ts`), `loadSessionAdvice` (`src/progression/session-advice.ts`), `formatSession`, `formatFinished` (`src/bot/format.ts`), `classCard` (`src/bot/inputs-flow.ts`), `CLASS_QUESTION` (`src/jobs/class-question.ts`), `planWeekFor`, `weekdayOf`, `trainingDate` (`src/domain/calendar.ts`), `READINESS_QUESTION` / `READINESS_EMOJI` (wherever `readinessCard` gets them).
- Produces:
  ```ts
  // src/bot/morning.ts
  export const MORNING_GREETING = "☀️ Good morning.";
  export async function renderTodayText(db: Db, date: string, now: Date): Promise<{ text: string; askClassFirst: boolean; thursday: string | null }>; // the exact /today text; engine errors → plain session (advice null)
  export function morningMessage(todayText: string, date: string, readiness?: "t" | "o" | "s"): Message; // greeting + today + (readiness ? "Noted: <emoji>" line, no keyboard : READINESS_QUESTION + 3 buttons rd:<l>:m:<yyyymmdd>)
  // src/jobs/morning.ts
  export const morningJob: Job; // name "morning"
  export function morningWindow(now: Date): { date: string } | null;
  export function isFirstWeekdayAfterPlan(date: string, startDate: string, weeks: number): boolean;
  ```

Behaviour (spec "Morning job"): window Mon–Fri, `06:00 <= local < 10:00` Rome. `run`: latest plan (as `class_question` does); `planWeekFor(date, …).status`: `active` → continue; `finished` and `isFirstWeekdayAfterPlan` → `send({ text: formatFinished(), keyboard: [] })`, `"sent"`; else `"skipped"`. A `log_groups` row for `date` → `"skipped"`. `renderTodayText`; if `askClassFirst`, first `send` the class card for the preceding Thursday (`CLASS_QUESTION` + `classCard(thursday, 0)`, like the Thursday job), then `send(morningMessage(text, date))`. `renderTodayText` must produce byte-identical text to what `/today` sends at the same `now`: build it from `getSession` + the same `advise` fallback + `formatSession`, without touching `bot.ts`.

- [ ] **Step 1: Failing unit tests** for `morningWindow`: `2026-10-26T05:00:00Z` → `{ date: "2026-10-26" }`; `2026-10-26T04:45:00Z` → null; `2026-10-23T04:00:00Z` → `{ date: "2026-10-23" }`; `2026-10-23T07:45:00Z` (09:45 CEST) → due; `2026-10-23T08:00:00Z` (10:00) → null; Sat `2026-10-24T05:00:00Z` and Sun → null. `isFirstWeekdayAfterPlan("2026-12-21", "2026-09-28", 12)` true, `"2026-12-22"` false, `"2026-12-18"` false. Callbacks: `cb.readinessMorning("t", "2026-10-26")` = `rd:t:m:20261026`, parses back, and `rd:t` still parses as before. Run. Expected FAIL.
- [ ] **Step 2:** Implement window, helper, callbacks. Run. Expected PASS.
- [ ] **Step 3: Failing db tests** (extend `test/db/jobs.test.ts`, fake `send` collecting messages, `resetAndSeed` fixture; check how the existing class-question tests seed the plan and dates):
  - a W5 weekday (e.g. Tue 27 Oct 05:00Z) → one message starting with `MORNING_GREETING`, containing exactly `renderTodayText(...)`'s text, with 3 buttons `rd:t|o|s:m:20261027`; a derived `readiness_logs` row now exists for the date; `suggestions` rows exist.
  - second run the same day → `busy`, nothing sent.
  - a log group exists for the date → `skipped`.
  - a date before the plan start → `skipped`.
  - Mon 21 Dec 2026 06:00 → one message `formatFinished()`; Tue 22 Dec → `skipped`.
  - Friday 30 Oct with no class row for Thu 29 Oct → two messages: the class card (buttons `cg:`) first, then the morning message; with a class row → one message.
  Run db. Expected FAIL.
- [ ] **Step 4:** Implement `src/bot/morning.ts`, `src/jobs/morning.ts`, register in `JOBS`. Run. Expected PASS.
- [ ] **Step 5:** Lint, typecheck, test, test:db. Commit "M8: morning job".

### Task 7: Morning readiness tap + Friday class Save follow-up

**Files:**
- Modify: `src/bot/inputs-flow.ts` (`readinessTap` handles the morning variant; `classTap` sends today after Save on the following Friday), `src/bot/bot.ts` only to pass a `renderToday` dep into `createInputs` if needed (do not modify `sendSession`)
- Test: `test/db/progression-bot.test.ts` or a new `test/db/bot-morning.test.ts`

**Interfaces:**
- Consumes: Task 6 `renderTodayText`, `morningMessage`, `cb.readinessMorning`, the parsed `rd` action with `morningDate`.
- Produces: no new exports beyond what Task 6 defined.

Behaviour: `rd:<l>:m:<yyyymmdd>` tap: if `morningDate !== trainingDate(now)` → `answerCallbackQuery({ text: "That button is from another day." })`, nothing written. Otherwise the same ledger write as the plain tap (`log_readiness` with `button`), then, unchanged from M5, the re-freeze happens through the existing path. Then **edit the tapped message in place** with `morningMessage(await renderTodayText(db, date, now), date, level)` (no keyboard). If the user had already started (log group exists and level frozen): keep the existing "You already started today, so today stays X. I'll use this tomorrow." reply. No `sendToday` call on the morning path. The plain `rd:<l>` path is unchanged. `classTap` Save: after the existing edit, if `trainingDate(now)` is the Friday right after `date` (the Thursday), call `deps.sendToday(ctx)`.

- [ ] **Step 1: Failing db tests** (bot with the transformer, as other `bot-*.test.ts` files do): morning tap 😴 before any log on a W5 weekday → one `editMessageText` whose text has `MORNING_GREETING`, "Noted: 😴" and the re-rendered session, no `reply_markup` buttons; the derived readiness row was rewritten (level changed if the signal changes it; pick a setup where 😴 turns GREEN into YELLOW); no `sendMessage` with a second session. Tap after a log exists → the edit happens and the "today stays" reply is sent; level unchanged. Tap with yesterday's date → callback answer text "That button is from another day.", no `readiness_logs` insert. Class Save for Thu 29 Oct with `now` = Fri 30 Oct → edit + a `sendMessage` with the Friday session; with `now` = Thu 29 Oct 21:30 → no session sent. Old `rd:t` tap still edits to "Noted: 😴" and sends today (regression). Run. Expected FAIL.
- [ ] **Step 2:** Implement. Run. Expected PASS.
- [ ] **Step 3:** Lint, typecheck, test, test:db. Commit "M8: morning readiness tap, Friday class follow-up".

### Task 8: Docs and demo (orchestrator)

**Files:** `SPEC.md` (§5.6 morning decisions, §5.7 `/chart` usage, §5.8 renderer line, §7 `render_chart` signature), `CLAUDE.md` (an "M8" architecture paragraph: `src/charts/`, the morning job, the new callback prefixes in the list), `docs/STATUS.md` (M8 row, decisions, open items: run `pnpm telegram:setup` to register `/chart`, live test), demo script in the PR body and STATUS.

- [ ] Write, lint (Biome ignores md?), commit "M8: docs".
