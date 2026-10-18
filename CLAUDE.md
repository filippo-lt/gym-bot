# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

GymBot is a single-user Telegram workout bot. `SPEC.md` is the source of truth for behaviour, domain rules and milestones. Read the relevant section before changing anything domain-related. Manual setup (BotFather, Supabase, Vercel, keys) is in `docs/SETUP.md`. Progress, open items and the live-testing playbook are in `docs/STATUS.md`: read it first and update it at the end of each milestone.

## Commands

```bash
pnpm db:up                 # local Postgres 17 in Docker (127.0.0.1:54329, dbs: gymbot, gymbot_test)
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
- Callback prefixes (data <= 64 bytes, see `src/bot/callbacks.ts`): `pa:<id>:ok|ed|no`, `ex:<pendingId>:<i>`, `rir:<groupId>:<0-4>` (4 = 4+), `cl:<groupId>:1|0`, `ug:<groupId>`, `ue:<sourceKey>:<idx>`, `uw:<sourceKey>:<idx>` (undo of a readiness / bodyweight / class write), `md:<memoryId>`, `sk:<yyyymmdd>:<plannedItemId|all>` (/skip list tap), `us:<sourceKey>:<idx>` (undo a skip), `rd:t|o|s` (/readiness 😴 🙂 💪), `cg:<mask>:<YYYYMMDD>` / `cg:<mask>:<YYYYMMDD>:ok` (/class toggles and Save for that Thursday; mask = pull 1 + push 2 + legs 4), `cm:<pendingId>:<mask>` / `cm:<pendingId>:<mask>:ok` (class-with-moves card toggles and Save), `pr:<id>:ok|no` (HSPU advance proposal; `rd`, `cg`, `pr` are handled by `src/bot/inputs-flow.ts` before the generic handler), `hx:<exerciseId>` (/history choice; handled in `bot.ts` before the generic callback handler, parsed by `parseHistoryCallback`, not part of the `CallbackAction` union).
- AI is built lazily (`aiEnv()` is read only when free text arrives), so commands work without the key.

### Progression in the bot (M5, `src/progression/`, `src/bot/inputs-flow.ts`)

- `/today`, `/short`, `/session`, `/next` render the engine's adjusted session (`loadSessionAdvice` → `src/bot/format.ts`, texts in `src/bot/progression-format.ts`). Today: readiness is frozen from 05:00 (`freezeReadiness`) and suggestions are stored (`ensureSuggestions`). Past dates show the stored suggestions only; future dates show the plan.
- Before a log is written, `executeActions` freezes the day's readiness and stores today's suggestions (outside the transaction). The log group then gets `suggestion_id` and `readiness_level`. The far-off check compares with the stored suggestion first, then the last session. After every write, undo, edit, RIR/clean tap and history import, `refreshUserState` rebuilds the pull-up gate and the HSPU step.
- Band colours live in `log_entries.band` (`assist_kg` null while unmapped) and map to kg through `equipment.bands`. The first saved log with an unmapped colour triggers one question; the answer is the `set_band_kg` tool (confirm card).
- An accepted `hspu_advance` proposal counts as the current HSPU step until a newer HSPU log (`acceptedHspuStep`).
- `log_readiness`, `log_bodyweight`, `log_class` save directly with an Undo (`uw:`), like a log.

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
