# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

GymBot is a single-user Telegram workout bot. `SPEC.md` is the source of truth for behaviour, domain rules and milestones. Read the relevant section before changing anything domain-related. Manual setup (BotFather, Supabase, Vercel, keys) is in `docs/SETUP.md`.

## Commands

```bash
pnpm db:up                 # local Postgres 17 in Docker (127.0.0.1:54329, dbs: gymbot, gymbot_test)
pnpm lint                  # Biome (pnpm format to auto-fix)
pnpm typecheck
pnpm test                  # unit project (no DB)
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

- **Vercel, no framework.** `api/*.ts` are thin Node functions using Web `Request`/`Response` (`export async function GET/POST`). All logic lives in `src/`. Region `dub1` (next to the Supabase project in eu-west-1). Hobby with Fluid compute allows up to 300 s; the M2 webhook will set `maxDuration: 60` with a 120 s chat lease (SPEC §3: lease = maxDuration + 60 s).
- **DB.** Supabase used as plain Postgres through Drizzle + postgres-js (`src/db/client.ts`: lazy singleton, `prepare: false`, `max: 1`). Runtime goes through the transaction pooler (6543). Migrations go only through the session pooler (`MIGRATION_DATABASE_URL`). Every table has RLS enabled with no policies, and a db test enforces this. Add tables in `src/db/schema/`, export them from `schema/index.ts`, then run `pnpm db:generate`.
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
