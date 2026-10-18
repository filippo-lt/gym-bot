# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

GymBot is a single-user Telegram workout bot. `SPEC.md` is the source of truth for behaviour, domain rules and milestones. Read the relevant section before changing anything domain-related. Manual setup (BotFather, Supabase, Vercel, keys) is in `docs/SETUP.md`. Progress, open items and the live-testing playbook are in `docs/STATUS.md`: read it first and update it at the end of each milestone.

## Commands

```bash
pnpm db:up                 # local Postgres 17 in Docker (127.0.0.1:54329, dbs: gymbot, gymbot_test; parallel branches may use their own *_test db via TEST_DATABASE_URL)
pnpm lint                  # Biome (pnpm format to auto-fix)
pnpm typecheck
pnpm test                  # unit project (no DB)
pnpm test:golden           # opt-in, real Anthropic API: ~15 logging phrases -> expected staged actions
pnpm test:db               # db project; migrates gymbot_test first, refuses non-local/non-_test URLs
pnpm exec vitest run --project unit test/plan-import/rules.test.ts   # single file
pnpm exec vitest run --project unit -t "RIR"                         # by test name
pnpm db:generate           # drizzle-kit: schema change → new SQL in drizzle/
pnpm db:migrate            # needs MIGRATION_DATABASE_URL (Supabase session pooler, 5432); no fallback
pnpm plan:parse            # plan JSON → seed/plan.parsed.json + seed/review/plan-review.{md,csv}
pnpm plan:seed [--dry-run] # refuses while any open issue remains
pnpm check:setup           # env + DB + Telegram getMe + Anthropic ping
pnpm backup                # read-only: JSON + CSV zip of DATABASE_URL into backups/ (git-ignored)
pnpm backup:restore <file> [--dry-run] [--allow-remote]   # needs RESTORE_DATABASE_URL; empty, migrated target only
```

Scripts load `.env.local`, then `.env`, via `scripts/load-env.ts`. Production code (`src/`, `api/`) never loads dotenv.

## Architecture

- **Vercel, no framework.** `api/*.ts` are thin Node functions using Web `Request`/`Response` (`export async function GET/POST`). All logic lives in `src/`. Region `dub1` (next to the Supabase project in eu-west-1). Hobby with Fluid compute allows up to 300 s; the webhook and cron tick set `maxDuration: 90` with a 150 s chat lease (SPEC §3: lease = maxDuration + 60 s).
- **DB.** Supabase used as plain Postgres through Drizzle + postgres-js (`src/db/client.ts`: lazy singleton, `prepare: false`, `max: 1`). Runtime and migrations both use the **session pooler** (5432). The transaction pooler (6543) hangs when postgres-js pipelines concurrent queries on one connection (e.g. a `Promise.all` of reads, or two Fluid requests sharing the instance), local Postgres never shows it, and `dbEnv` rejects port 6543. Don't work around it with `max_pipeline: 0`: that breaks transactions in postgres-js 3.4. Migrations need `MIGRATION_DATABASE_URL`, with no fallback. Every table has RLS enabled with no policies, and a db test enforces this. Add tables in `src/db/schema/`, export them from `schema/index.ts`, then run `pnpm db:generate`.
- **Env.** `src/config/env.ts` has one memoized Zod parser per feature (`dbEnv`, `telegramEnv`, `aiEnv`, `sttEnv`, `cronEnv`), so a script only needs the variables it uses. `APP_TIMEZONE` (`Europe/Rome`) is in `src/config/constants.ts`.
- **Calendar.** `src/domain/calendar.ts` (Luxon) handles "today" in Rome with a 03:00 day boundary, the plan week from the start date (2026-09-28), and Sat/Sun → no session.

### Plan import pipeline (`src/plan-import/`, M1)

`seed/hybrid-strength-plan.json` → `buildPlan` → `applyOverrides` → review file → (user OK) → `seedPlan` (`src/db/seed-plan.ts`).

- `types.ts` is the contract shared by the parser and the seeder.
- `exercise-catalog.ts` is hand-curated. It maps each of the 35 plan names to canonical exercise slugs and tags. Pull-up variants collapse to one exercise. **OR items are a whitelist (`OR_PLAN_NAMES`)**, so a slash in a prescription is not an OR.
- `parse-prescription.ts` never guesses. Anything it can't parse becomes a flag. `rir.ts` derives RIR from rules (main lift / deload / easy / test), **never from notes**.
- Human decisions live in data, not code:
  - `seed/plan-overrides.json`: per-item field fixes plus `resolve` flags, and `exercises` acknowledgements.
  - `seed/equipment.json`: the only source of rounding steps.
  - `seed/hspu-ladder.json`: HSPU ladder steps.
- `seedPlan` is one transaction and idempotent:
  - Same `resolved_hash` → no-op.
  - Changed plan content → `SeedConflictError`. Later plan changes must become a new plan version (M7).
  - Equipment values can be re-seeded freely.

### Text logging (M3, `src/ai/`, `src/logging/`, `src/bot/`)

**Claude stages, code decides.** The model only parses intent: its write tools (`log_sets`, `edit_last_entry`, `undo_last_entry`, `skip_items`) stage actions and never save. After the loop, pure code (`decidePolicy`, SPEC 5.6d) picks one of three paths: write now (one clear log in today's session), a "Which exercise?" question, or a confirm card (✅ ✏️ ❌). Every number shown to the user is formatted in code (`src/bot/log-format.ts`) from DB or parsed values, never from model text.

- `src/ai/`: Anthropic client, tool schemas, prompt, loop (6 turns, 40 s), cost guard, fake model for tests. `src/logging/`: resolver, units, policy, executor, pending actions, aliases, memory. `src/bot/logging-flow.ts`: the Telegram flow and callbacks.
- **write_ledger** makes writes idempotent. Source key `u:<update_id>` for a direct write, `p:<pending_id>` for a confirmed card. A retry returns the stored results and writes nothing. A pending request is created once per update (`source_update_id`), and ✅ is claimed in the same transaction as the writes.
- Callback prefixes (data <= 64 bytes, see `src/bot/callbacks.ts`): `pa:<id>:ok|ed|no`, `ex:<pendingId>:<i>`, `rir:<groupId>:<0-4>` (4 = 4+), `cl:<groupId>:1|0`, `ug:<groupId>`, `ue:<sourceKey>:<idx>`, `uw:<sourceKey>:<idx>` (undo of a readiness / bodyweight / class write), `sw:<pendingId>:t|r|d|a` (swap questions: only today / rest of plan / this weekday only / every day), `up:<sourceKey>:<idx>` (undo a plan change; key `p:<pendingId>` for a swap, `r:<proposalId>` for a deload move), `md:<memoryId>`, `sk:<yyyymmdd>:<plannedItemId|all>` (/skip list tap), `us:<sourceKey>:<idx>` (undo a skip), `rd:t|o|s` (/readiness 😴 🙂 💪), `rd:t|o|s:m:<yyyymmdd>` (the same buttons on the morning message; the tap edits that message in place, a tap from another day writes nothing), `cg:<mask>:<YYYYMMDD>` / `cg:<mask>:<YYYYMMDD>:ok` (/class toggles and Save for that Thursday; mask = pull 1 + push 2 + legs 4), `cm:<pendingId>:<mask>` / `cm:<pendingId>:<mask>:ok` (class-with-moves card toggles and Save), `pr:<id>:ok|no` (HSPU advance and earlier-deload proposals; `rd`, `cg`, `pr` are handled by `src/bot/inputs-flow.ts` before the generic handler), `hx:<exerciseId>` (/history choice; handled in `bot.ts` before the generic callback handler, parsed by `parseHistoryCallback`, not part of the `CallbackAction` union), `ch:<exerciseId>` / `ch:v` (/chart choice, main-lift and Volume buttons; same handling, parsed by `parseChartCallback`).
- AI is built lazily (`aiEnv()` is read only when free text arrives), so commands work without the key.

### Progression in the bot (M5, `src/progression/`, `src/bot/inputs-flow.ts`)

- `/today`, `/short`, `/session`, `/next` render the engine's adjusted session (`loadSessionAdvice` → `src/bot/format.ts`, texts in `src/bot/progression-format.ts`). Today: readiness is frozen from 05:00 (`freezeReadiness`) and suggestions are stored (`ensureSuggestions`). Past dates show the stored suggestions only; future dates show the plan.
- Before a log is written, `executeActions` freezes the day's readiness and stores today's suggestions (outside the transaction). The log group then gets `suggestion_id` and `readiness_level`. The far-off check compares with the stored suggestion first, then the last session. After every write, undo, edit, RIR/clean tap and history import, `refreshUserState` rebuilds the pull-up gate and the HSPU step.
- Band colours live in `log_entries.band` (`assist_kg` null while unmapped) and map to kg through `equipment.bands`. The first saved log with an unmapped colour triggers one question; the answer is the `set_band_kg` tool (confirm card).
- An accepted `hspu_advance` proposal counts as the current HSPU step until a newer HSPU log (`acceptedHspuStep`).
- `log_readiness`, `log_bodyweight` and a heavy-only text `log_class` save directly with an Undo (`uw:`), like a log. A `log_class` with moves, or any voice-origin write, goes through a card.

### Voice, photo, scheduled jobs (M6, `src/stt/`, `src/ai/board.ts`, `src/jobs/`)

- **Voice.** `message:voice` → `flow.voice` (`src/bot/logging-flow.ts`) → download (`src/telegram/files.ts`, never log the file URL) → `src/stt/stt.ts` (Groq `whisper-large-v3-turbo` default, OpenAI `whisper-1`; no language forced; vocabulary prompt from the catalog; `sttEnv()` read lazily) → `handleInput` with source voice. Every voice write goes through a confirm card (`voice_input` policy reason) that starts with "🎤 heard: …" (`heardLine`); reads get the heard prefix. Memory stores `[voice] <transcript>`; the prompt tells the model such turns may be misheard. Limits: 120 s per note and `STT_DAILY_SECONDS_CAP` (default 1800, counted as `stt_seconds` in `usage_logs`).
- **Photo.** `message:photo` → `flow.photo` → `readBoard` (`src/ai/board.ts`, forced `record_board` tool) → a `log_class` pending with `moves` → `classMovesCard` (per-group breakdown from `classBreakdown`; toggles start unticked unless a non-blank caption names heavy groups; `cm:` callbacks). 3.5 MB cap. Memory stores `[photo] <caption or "class board">`.
- **Class rows.** Heavy-only writes keep moves, photo and raw text; a moves write replaces them; undo restores the whole previous row (stale if the row changed since).
- **Jobs.** `src/jobs/` (`runDueJobs`): `job_runs` claim → send → done, with a 5-minute reclaim. First job `class_question` (Thu 21:00–23:00 Rome; skipped if the class is logged or outside the plan). Runs in `/api/cron/tick` before the inbox sweeper.
- Shared helpers in `src/bot/log-format.ts`: `inlineKeyboard`, `heardLine`.

### Plan versions and swaps (M7, `src/plan/`)

- **Versions are full copies.** `plan_versions` (+ `planned_items`, `planned_item_options`, `plan_weeks`) is copied whole for each change (`createVersion`, `versions.ts`); nothing is edited in place. Lookup rule: the highest `version` of the newest plan with `effective_from <= date`, else the lowest version. The week count is the number of `plan_weeks` rows of a version (no stored column).
- **`planDayOn(db, date)` (`effective.ts`) is the one reader of the plan for a date.** It picks the version and applies `session_overrides`. Don't query `planned_items` directly for a date. `loadVersionIndex` + `planDayFromIndex` are the same thing for many dates. History is never touched: logs, suggestions and `session_items` keep the item and version they were made with.
- **A lasting change has `effective_from >= tomorrow`** (Rome, 03:00 boundary), recomputed at ✅, not at card time. The deload insert starts next Monday.
- **Swaps** (`swap_exercise` tool, `/swap`): `swap-stage.ts` resolves the request. A missing scope → `sw:<pendingId>:t|r` question; "Rest of plan" on an exercise that sits on more than one weekday → `sw:<pendingId>:d|a` question; then a confirm card (`plan_change`). ✅ runs `executeSwap` (`swap-execute.ts`, one transaction, `write_ledger` key `p:<pendingId>`). Only today → a `session_overrides` row (one-off, no new version); rest of plan → a new version. The reply has an Undo button (`undoPlanChange`, `undo.ts`) that works only until the change is used (no logs, suggestions or session items on it).
- The replacement inherits tags, priority, block and prescription. RIR is recomputed over the new option list (`computeRir`, as in plan import), and an override clears `fallback`. A replacement missing from the catalog is created from `replacement.new` (reps only unless a load basis or equipment is given).
- **Deload earlier** (`deload.ts`, `deload-proposal.ts`): when the fatigue trigger fires, `deloadProposal` (`inputs-flow.ts`, same hook as `hspuProposal`) sends a separate card, asked once until the trigger resets. ✅ runs `insertDeload` (pure) and writes a new version from next Monday; Undo uses source key `r:<proposalId>`.
- **History import guard.** `src/db/import-history.ts` refuses rows dated on or after a later version's `effective_from`; it only maps to version 1.

### Morning message and charts (M8, `src/jobs/morning.ts`, `src/bot/morning.ts`, `src/charts/`)

- **Morning job** (`morning`, Mon–Fri 06:00–10:00 Rome, appended to `JOBS`). It decides everything from `getSession(date).kind` (never `plans.weeks`), so plan versions reach it: `session` → the message; `finished` and the previous weekday not finished → "plan finished" once; a log group for the date → skipped. The text is `renderTodayText` (the same `getSession` + `loadSessionAdvice` + `formatSession` as `/today`; a db test compares them byte for byte) between `MORNING_GREETING` and the readiness buttons. Friday with Thursday not reported: the class card is sent first. Saving that card on the Friday sends the session again (`classTap`).
- **Charts.** `src/charts/series.ts` (pure; e1RM from the engine's `sessionEstimate`/`validSets`, most reps per set skipping split-unknown imports and unclean sets, volume = sets per plan week per muscle group), `load.ts` (history only via `loadSessionRecs`, never `planned_items`), `spec.ts` (Vega-Lite; ordinal x keyed by ISO date), `caption.ts` (HTML, code-formatted numbers), `render.ts` (Vega headless SVG → `@resvg/resvg-js` PNG with `assets/fonts/Inter_400Regular.ttf`, no system fonts; `vercel.json` `includeFiles` ships the font with `api/telegram.ts`), `index.ts` (`buildChart(db, req, now)`). Always import `src/charts/index.js` lazily (`await import`), so Vega and resvg don't load on every cold start.
- `/chart <exercise>` / `/chart volume` / `/chart` (buttons) in `bot.ts`; `render_chart` read tool (`src/queries/chart-tool.ts`) queues one chart per message, and the flow sends the photo after the reply (alone, with the caption, when there is no other text). A render failure answers `CHART_FAILED`, never a failed inbox row.

### Hardening (M9, `src/failures/`, `src/backup/`, `src/runtime/deadline.ts`)

- **Failures.** `classify(error, step)` (`src/failures/classify.ts`) is pure: the call site names the step (`ai`, `vision`, `stt`, `download`, `other`), and it reads only class, `name`, `status` and `code` after unwrapping grammY `BotError` and the `cause` chain. Never `.message`: Drizzle's `DrizzleQueryError` (no `name` of its own; match it with `instanceof`) carries SQL and params. Texts are in `src/failures/messages.ts` (`failureText`, `retryingText`, `failedText`). `inbox.error` stores `describeFailure(f)` = `kind (detail)`. Inbox notices: a "⚠️ … I'll retry automatically, so don't send it again" on attempt 1, the reason in the final "after 3 tries" message.
- **Time budget.** `processChat` runs each handler inside `runWithDeadline(startedAt + 85 s)`; flows clamp the AI loop, STT, vision and download timeouts with `clampTimeout`. Before claiming a row it needs `MIN_TIME_LEFT_MS` for the row's kind (voice 75 s, photo 60 s, text/other 45 s), except the first row of an invocation started less than `FIRST_ROW_GRACE_MS` (15 s) ago. A row that doesn't fit stays pending (`deadline`).
- **Cost guard.** Counted tokens = input + output + 1.25 × cache write + 0.1 × cache read (`countedTokens`, weights in `src/ai/constants.ts`, the same formula in SQL in `usage.ts`). Caps stay `AI_DAILY_TOKEN_CAP` / `AI_MONTHLY_TOKEN_CAP` (vision shares them) and `STT_DAILY_SECONDS_CAP`; the reply names the cap and when it resets. `/usage` shows today and the month.
- **Backup.** `buildBackup` reads the table list, columns, keys, FKs and sequences from the Postgres catalog (`src/backup/catalog.ts`), so a new table is backed up with no code change; only `EXCLUDED_TABLES` (`inbox`, `chat_lease`) is listed. Each table is one `jsonb_agg(to_jsonb(t))` query with its row count and sha256, in one read-only snapshot; the file text is assembled from Postgres text, never re-serialised in JS. A db test fails if the catalog and the Drizzle schema exports disagree. JSON is gzipped over 10 MB and refused over 45 MB; the CSV zip (`zip.ts`, no dependency) is for spreadsheets only. `/export` and the `weekly_backup` job (Sun 18:00–23:00 Rome; failure notice only from 22:30; "too large" notice once) send a summary text, then the two documents, via `JobContext.sendFile` (`kind: "document" | "photo"`, shared with M8). The tick purges `done`/`failed` inbox rows older than 30 days after the jobs.
- **Restore.** `pnpm backup:restore` targets `RESTORE_DATABASE_URL` only (no fallback; 6543 refused; non-local needs `--allow-remote`). It refuses an invalid file, any row in the target, or a migration/table/column mismatch, all before any insert. One transaction: the file text goes once into a temp jsonb table, tables are filled in FK order with `jsonb_populate_recordset` (original ids, numbers never pass through JS), sequences are `setval`'d past max(id), sha256 and counts are re-checked (a mismatch rolls back), then `refreshUserState`. `--dry-run` rolls back. `write_ledger`, `pending_actions` and `job_runs` come back verbatim, so old `u:`/`p:` keys still short-circuit. JSON `null` in a jsonb column comes back as SQL `NULL` (`to_jsonb` can't tell them apart). Runbook: `docs/SETUP.md` "Restore from a backup".

## Domain rules that are easy to break

- Anything with a number is computed in code. The LLM only parses intent and phrases replies (SPEC §3).
- Units:
  - Barbell = total including the bar; dumbbells = per hand; machines = stack value.
  - Pull-ups use `added_kg` and `assist_kg` separately, and `system_load = bw + added − assist`.
- Pull-up gate, HSPU step and e1RM are derived from history by pure functions. Any stored state is only a cache.
- History is never rewritten. Plan changes create a plan version that applies from an `effective_from` date.

## Workflow

- Branch `dev`; PRs target `dev`, never `main`.
- Implementation is delegated to Sonnet subagents. QA is done by a separate Haiku subagent at high effort that didn't write the code.
