# M9 — Hardening: cost guard, backup, restore, failure messages

_Design, 18 Oct 2026. SPEC.md stays the source of truth; this document records what M9 adds. The user said "skip the questions, you decide", so every decision below is **our call** unless marked otherwise. "Builder's call" marks what is left to the implementer._

## Why

M0–M6 are live and the bot is now the single source of truth for training history (SPEC "Transition"). Three things can still go wrong without the user noticing in time:

1. **Data loss.** Supabase free has no point-in-time restore. A dropped table or a lost project loses everything since the old tool's export.
2. **Silent failures.** When Anthropic, the speech-to-text provider, a Telegram download or the database fails, the user gets a generic "couldn't process that", or nothing at all until the third inbox retry (up to ~30 minutes later).
3. **Cost and time limits with gaps.** The AI caps ignore cache tokens, the "budget reached" text doesn't say which cap or when it resets, and a voice note or photo picked up late in an invocation can run past the 90 s function limit.

## Goals

1. A full backup of **every table** as JSON (lossless, used by restore) plus CSV (one file per table, for a spreadsheet), sent as Telegram documents by `/export` and automatically every Sunday at 18:00 Rome.
2. The backup is **table-generic**: it is driven by the Drizzle schema, so tables that M7/M8 add are covered with no code change. A test fails if any table in the database is missing from the backup.
3. A restore script that loads a backup file into an **empty, migrated** database, dry-run first, with refusal rules that make it impossible to overwrite a live database by mistake, and that keeps the write_ledger and inbox idempotency guarantees.
4. Every failing step in chat (Anthropic, STT, vision, Telegram file download, database) produces a short, specific message.
5. Cost guard: cache tokens count, the user sees which cap was hit and when it resets, `/usage` shows where the day and month stand, and no input kind can be started too late to finish within `maxDuration`.

## Non-goals

- A weekly **training** summary on Sunday (SPEC §3 lists "summary + backup"). M9 sends the backup with a short caption of row counts and the week's AI/voice usage. A training summary belongs with the weekly check-in work and is left for later.
- Merging a backup into a database that already has data, or restoring a single table or a date range.
- Restoring from Telegram (an upload to the bot). Restore is a local script only.
- Backups stored anywhere but the user's Telegram chat (no S3, no Supabase Storage).
- Encrypting the backup file. It goes only to the user's private chat with their own bot.
- Changing `pnpm history:import` or the `source = import` semantics.

## Anti-goals (a failure even if it works)

- A restore that writes into a database that already holds data.
- A restore that replays an old message or an old ✅ as a new write.
- A table added by M7/M8 that silently doesn't make it into the backup.
- A failure message that leaks a secret, a URL with the bot token, SQL parameters, or the user's message text into logs.
- A failure message that guesses: if we don't know what failed, say so plainly instead of naming the wrong service.

## Current state (what we found)

- **Cost guard** (`src/ai/budget.ts`, `src/logging/usage.ts`): `usage_logs` stores input, output, cache read, cache write tokens and STT seconds per call. The daily/monthly token caps (`AI_DAILY_TOKEN_CAP` 200 000, `AI_MONTHLY_TOKEN_CAP` 3 000 000) sum **input + output only**; cache reads and cache writes are not counted. The loop checks the cap before every model call (6 turns, 40 s wall clock, 35 s per request with SDK `maxRetries: 2`). Vision checks the same token cap before the call and records usage after. STT checks `STT_DAILY_SECONDS_CAP` before the download and records seconds after a successful transcription. Hitting the AI cap replies "AI budget reached. Commands still work." Hitting the voice cap replies "Voice budget reached. Text still works."
- **Time budget:** `STOP_TAKING_AT_S = 45`, `maxDuration = 90`. A voice note claimed at 44 s can need 15 s (download) + 20 s (STT) + 40 s (loop) + DB work ≈ 80 s, so it is killed at 90 s, retried after the 150 s lease, and after three such kills it is `failed`. A photo needs 15 s + 40 s. Only text fits after 45 s.
- **Failures:** text → one generic "Sorry, I couldn't process that. Please try again." for any AI error. Voice → `VOICE_FAILED` for download and STT errors alike. Photo → `PHOTO_FAILED` for download, vision, and "too large" (a Known minor issue). Any error thrown out of a handler (most often a DB error) leaves the user with silence until the third attempt, then `FAILED_MESSAGE` ("couldn't process your last message after 3 tries"), with no reason. grammY wraps handler errors in a `BotError`, so `inbox.error` mostly says `BotError`.
- **Jobs:** `src/jobs/` has one job (Thursday class question). `JobContext.send` sends text only.
- **History import** (`src/db/import-history.ts`, `scripts/history-import.ts`): review file → dry-run that runs the whole transaction and rolls back → real run in one transaction → JSON summary. Refuses on open issues.

## Design

### 1. Backup (export)

**Where:** `src/backup/` (new). Pure helpers (CSV, zip, file naming, captions) are unit-tested; the DB parts are db-tested.

**Which tables:** every `PgTable` exported from `src/db/schema/index.ts` (`is(value, PgTable)` + `getTableConfig`). No list in code. Runtime tables (`inbox`, `chat_lease`, `job_runs`, `write_ledger`, `pending_actions`, `conversation_messages`, `usage_logs`) are included: they are what keeps restore idempotent, and "all data" means all.

**Reading rows losslessly:** read each table with SQL that lets Postgres render JSON itself, e.g. `select coalesce(jsonb_agg(to_jsonb(t) order by <primary key>), '[]') from <table> t`. Postgres turns timestamps, dates, numerics, arrays, enums and jsonb into JSON with no JS type mapping, and restore can turn them back with `jsonb_populate_recordset`. Column names stay snake_case (the DB names). Tables are read one query at a time (session pooler rule: no `Promise.all`). Builder's call: order by primary key columns from `getTableConfig`, or by all columns when a table has no primary key.

**JSON file** `gymbot-backup-YYYY-MM-DD.json` (Rome date):

```json
{
  "format": "gymbot-backup",
  "version": 1,
  "created_at": "2026-10-25T17:00:03.120Z",
  "schema": { "migration_count": 7, "last_migration_at": 1760000000000 },
  "counts": { "log_groups": 123, "...": 0 },
  "tables": { "log_groups": [ { "id": 1, "session_date": "2026-09-28", "...": "..." } ] }
}
```

- `schema` comes from Drizzle's migration table (`drizzle.__drizzle_migrations`: number of rows and the newest `created_at`). Restore compares it with the target. Builder's call on the exact field names, as long as restore can tell "same migrations applied" reliably.
- `counts` lets restore check that the file is complete.

**CSV file** `gymbot-backup-YYYY-MM-DD-csv.zip`: one `<table>.csv` per table, header row = column names, UTF-8 with a BOM (so Excel/Numbers read accents), RFC 4180 quoting, `null` → empty cell, arrays and jsonb → their JSON text. Zipped because there are ~25 tables and an iPhone opens a zip in Files natively. The zip writer is a small in-repo module (stored or deflated entries via `node:zlib`, `zlib.crc32`); **no new dependency**. Builder's call: store vs deflate.

**Size:** today's data is well under 1 MB. Telegram bots can send documents up to 50 MB. If the JSON is over 45 MB, send it gzipped (`.json.gz`) instead and say so in the caption. Builder's call whether to implement the gzip branch now or refuse with a clear message; refusing is fine for v1 as long as the message is clear.

**Caption** (formatted in code): date, row counts for the tables the user cares about (log groups, sets, class logs, bodyweight, readiness, weekly metrics), and "Keep this file: it is your only restore point." The Sunday caption adds the week's usage: AI tokens and voice minutes.

**`/export`:** replies "Preparing your backup…", then sends the JSON and the zip as two documents. Works without the AI key. Errors follow §4.

**Sunday job `weekly_backup`:** `src/jobs/weekly-backup.ts`, window **Sunday 18:00 ≤ Rome time < 22:00** (four tick chances). Added to `JOBS` as one more entry (additive: M8 adds its morning job in the same array). Runs every Sunday, including after the plan ends. If building or sending the backup fails, it tries to send "Weekly backup failed (<reason>). Send /export to try again." and rethrows, so the runner leaves the row `claimed` and retries after 5 minutes while the window is open. A duplicate backup (the known "marked done failed" case) is harmless here.

**JobContext:** gains `sendDocument(file: { name: string; data: Uint8Array }, caption?: string): Promise<void>`. `api/cron/tick.ts` passes `sendDocumentToOwner` (new, in `src/runtime/telegram-runtime.ts`, using grammY `InputFile`). Existing jobs ignore it. Builder's call: required or optional member; required is fine if the class-question tests are updated.

**Coverage test (required):** a db test lists every table in the `public` schema of the migrated test DB (`information_schema.tables`) and asserts each one is in the backup's `tables`. A second check asserts every `PgTable` exported from the schema index is in the backup. So a table added by a migration but not exported from the schema index fails the test, and so does a schema table the exporter skips.

### 2. Restore

**Entry point:** `pnpm backup:restore <file.json> [--dry-run] [--confirm <code>] [--allow-remote]` (`scripts/backup-restore.ts`), same shape as `pnpm history:import`: load env, validate the file, print a review, dry-run the full transaction and roll back, or run it for real in one transaction, then print a JSON summary.

**Target database:** `RESTORE_DATABASE_URL`, required, **no fallback** to `DATABASE_URL` (same pattern as `MIGRATION_DATABASE_URL`). Rejects port 6543 like `dbEnv`. The script prints the target host and database name (never the password) before doing anything.

**Refusal rules** (each one stops before any write, with a plain message saying what to do):

1. **Not a backup file:** wrong `format`/`version`, invalid JSON, or `counts` don't match the rows in `tables`.
2. **Target not empty:** any table in the target `public` schema has at least one row. Restore is only for a fresh, migrated database. (Don't run `pnpm plan:seed` first: the backup contains the plan.)
3. **Schema mismatch:** the target's applied migrations differ from the backup's `schema`, or the backup has a table the target doesn't have, or the target has a table the backup doesn't have, or a column set differs. Message: migrate the target to the same version (or check out the code version that made the backup).
4. **Remote target without `--allow-remote`:** any host other than `localhost`, `127.0.0.1`, `::1`.
5. **Real run without a matching `--confirm <code>`:** the dry-run prints a short code derived from the file's SHA-256 and the target host + database name (e.g. first 8 hex chars). The real run refuses unless `--confirm` matches. This makes "always dry-run first" mechanical, and a code from a dry-run against another DB or another file won't work.

**What the transaction does:**

1. Insert tables in **foreign-key order** (parents first), computed from `getTableConfig(t).foreignKeys` (or `pg_constraint`; builder's call). Rows go in with their original ids, in chunks, via `insert into <table> select * from jsonb_populate_recordset(null::<table>, $1::jsonb)`, so Postgres converts every type back. Builder's call on chunk size; keep each parameter well under a few MB.
2. **Reset every sequence** to the table's max id (`setval(pg_get_serial_sequence(...), max(id))`, or `false`/1 for empty tables), so new rows after the restore don't collide.
3. **Normalise runtime state so nothing old replays:**
   - `inbox` rows with status `pending` or `processing` → `failed`, `error = 'restored from backup'`. A message the old database never finished must not be handled days later as if it were new.
   - `pending_actions` with status `open` → `expired`. An old card's ✅ then does nothing (it already handles expired).
   - `chat_lease` → not restored (skipped; it's recreated on first use). Builder's call: restore with `until` in the past instead, if that's simpler.
   - `job_runs` → restored as-is (so a job already done today won't send again).
   - Everything else verbatim, including `write_ledger`, `source`, and `import_row_key`.
4. Re-check `counts` per table inside the transaction (inserted rows = file rows, minus the skipped table).
5. Call `refreshUserState` (the derived cache), so `user_state` matches history even if the backup's cache was stale.
6. Dry-run: throw a rollback marker after step 5 and print the summary with "dry run (rolled back)" and the confirm code.

**Why this keeps the guarantees:**

- `write_ledger` comes back verbatim, so a retried Telegram update (`u:<update_id>`) or a re-tapped card (`p:<pending_id>`) that was already written before the backup returns the stored result and writes nothing.
- `inbox.update_id` stays unique, so Telegram redelivering an old update is still a duplicate.
- Original ids are kept, so every ledger result, `pending_actions.actions` snapshot and callback that references a group id points at the same row.
- `source = import` rows and `import_row_key` are kept, so a later `pnpm history:import` re-import still replaces only import rows and never duplicates bot logs.
- Data written after the backup's `created_at` is lost. The review prints the backup's age so this is explicit.

**How it "reuses the import path":** the same script shape, the same review → dry-run → real-run flow, the same single-transaction-with-rollback-marker pattern (`DryRunRollback` in `import-history.ts`), and the same rule that prod writes need the user's OK. The history import itself is unchanged. Builder's call: share the rollback-marker helper or copy the few lines.

**Disaster procedure** (goes in `docs/SETUP.md`, a section "Restore from a backup"): create a new Supabase project → `pnpm db:migrate` against it → download the latest backup JSON from Telegram → `RESTORE_DATABASE_URL=… pnpm backup:restore file.json --allow-remote --dry-run` → re-run with `--confirm <code>` → point Vercel `DATABASE_URL` at the new project → redeploy → health check. Each step that writes to a remote DB needs the user's explicit OK.

**Local rehearsal:** the demo restores a real backup into the local Docker database (`gymbot` on 127.0.0.1:54329, after `pnpm db:migrate` against it and with nothing seeded). That proves a production backup restores without touching production.

### 3. Cost guard

1. **Count cache tokens.** A call's counted tokens = `input + output + cache_write + ceil(cache_read / 10)`. Cache reads are billed at a tenth of input, cache writes at about input price; counting them this way keeps the caps roughly proportional to cost without a price table that goes stale. The env names and defaults stay (`AI_DAILY_TOKEN_CAP`, `AI_MONTHLY_TOKEN_CAP`); the counting change is documented in CLAUDE.md. Builder's call: compute in SQL in `UsageStore.totals`.
2. **Vision** shares the AI token cap (no separate cap). STT keeps its own seconds cap. Unchanged.
3. **Say which cap and when it resets** (formatted in code):
   - daily AI: "AI budget for today is used up. It resets at midnight (Rome time). Commands still work."
   - monthly AI: "AI budget for this month is used up. It resets on 1 Nov. Commands still work." (the next month's first day, Rome)
   - voice: "Voice budget for today is used up (30 of 30 min). It resets at midnight. Typing still works."
   - `overTokenBudget` returns which cap was hit (or none) instead of a boolean; the loop's `budget_reached` result carries it.
4. **`/usage`** (new command, works without the AI key): today's counted tokens vs the daily cap (with %), this month's vs the monthly cap, today's voice minutes vs the voice cap. Numbers formatted in code. Caps are read from env lazily; if the AI env isn't configured, show usage without caps.
5. **Time budget per input kind.** Before claiming a row, `processChat` checks that the row's worst case still fits: `elapsed + budget(kind) ≤ maxDuration − 5 s`. Kinds and budgets, derived from the timeouts in code (not hand-typed numbers): voice = download + STT + AI loop + 10 s; photo = download + vision + 10 s; text = AI loop + 10 s; everything else (commands, callbacks) = 15 s. A row that doesn't fit stays `pending` for the next webhook or tick (`stoppedReason: "deadline"`). The first row of an invocation always runs (elapsed ≈ 0 and every budget < 85 s). `STOP_TAKING_AT_S` stays as the overall cap. Builder's call: where the kind is read from the payload (the inbox payload is a Telegram update: `message.voice`, `message.photo`, `message.text`).
6. **Loop limits stay** at 6 turns and 40 s. The 40 s abort gets its own error class so §4 can say "took too long".

### 4. Failure messages in chat

**Module:** `src/failures/` (new): `classify(error): Failure` (pure, unit-tested) and the message texts. Unwraps grammY `BotError` (`.error`) and `cause` chains first. Never reads or logs message text, SQL parameters, URLs or response bodies: only error class, name, `status`, and `code`.

**Kinds and texts** (short, plain English; the user is not a native speaker):

| Step | Detected by | Message |
|---|---|---|
| AI loop over 40 s | the loop's timeout error class, SDK `APIConnectionTimeoutError` | "Claude took too long to answer. Please try again. Commands still work." |
| Anthropic overloaded / down | `APIError` status 529, 500, 502, 503 | "Claude (Anthropic) is having problems right now. Try again in a few minutes. Commands still work." |
| Anthropic rate limit | status 429 | "Too many AI requests right now. Wait a minute and try again." |
| Anthropic key | status 401, 403 | "The Anthropic API key was rejected. Check ANTHROPIC_API_KEY in Vercel. Commands still work." |
| Anthropic refused | status 400 (e.g. no credit) | "Anthropic refused the request. Check the account's credit. Commands still work." |
| Anthropic network | `APIConnectionError` | "I couldn't reach Claude. Please try again." |
| STT timeout | abort/timeout during transcribe | "Transcription took too long (Groq). Please try again or type it." |
| STT 429 / 401 / 5xx | `SttError.status` | "…(Groq) rate limit / key rejected / is down…, please type it." (provider from the STT name) |
| Telegram download | the download's error | "I couldn't download that file from Telegram. Please send it again." |
| File too large | `FileTooLargeError` | photo: "That photo is too large (max 3.5 MB). Send it compressed (not as a file) or crop it." voice: "That voice note is too large to download." |
| Vision | the Anthropic kinds above | same texts, starting "I couldn't read the photo:" instead of mentioning commands |
| Database | postgres-js `PostgresError`, connection codes (`CONNECT_TIMEOUT`, `ECONNREFUSED`, `CONNECTION_CLOSED`, …) | used in the inbox notices below: "a database error" |
| Unknown | anything else | "an unexpected error" (never guess a service) |

Where they're used:

- **text / voice / photo** in `src/bot/logging-flow.ts`: the existing `catch` blocks send the classified message instead of the generic one. Download, STT and vision get **separate** try blocks so the message names the right step. The "photo too large" Known minor issue is fixed by this.
- **Inbox, first failure:** when a row fails and will be retried (`markRetryOrFailed` → `pending`) on **attempt 1**, send once: "⚠️ Something went wrong (<reason>) while handling your last message. I'll retry automatically in a few minutes." `<reason>` is the classified kind ("a database error", "Claude took too long", "an unexpected error"). Not sent on attempt 2.
- **Inbox, final failure:** `FAILED_MESSAGE` gains the reason: "Sorry, I couldn't process your last message after 3 tries (<reason>). Please send it again." For timed-out rows (killed by `maxDuration`, reset by the sweep) the reason is "it took too long".
- `inbox.error` stores the classified kind plus name/code (instead of `BotError`), so the notice and the logs agree. Builder's call on the stored format (still capped at 500 chars, still no message text).
- **Jobs:** the backup job sends its own failure line (§1). Other jobs are unchanged.
- If the failure *is* Telegram (sending fails), we can't tell the user in chat; it stays in the Vercel logs. Accepted.

### 5. Known minor issues (triage, our call)

| Issue | Decision |
|---|---|
| Photo over 3.5 MB gets the generic reply | **Fix** (§4). |
| Crash after STT/vision succeeds but before the card is stored re-bills on retry | Leave. Needs a crash at one exact point; §4 makes crashes rarer; no duplicate write is possible. |
| Job can send again if marking done fails | Leave. For the backup job a duplicate is harmless. Touching the runner's claim logic now would collide with M8's morning job. |
| Duplicate-user-message check keyed on text | Leave (needs a migration; low impact). |
| Re-import restores a bot-logged slot as `source = bot` | Leave (cutover re-import is at most once). |
| Undo after a re-import restores the status at log time | Leave (same reason). |

The left items stay in STATUS "Known minor issues".

## Constraints

- No migration. (If one turns out to be needed and M7/M8 land one on `dev` first, sync with `dev` and regenerate.)
- No new runtime dependency.
- Job registration stays additive (`JOBS` array); `runDueJobs`, claim and markDone are not changed.
- Session pooler rule: no concurrent queries on one connection (no `Promise.all` of DB reads).
- Logs never contain message text, SQL parameters, file URLs, or secrets.
- Every number the user sees (counts, tokens, minutes, %, sizes) is formatted in code.
- `/export` and `/usage` are added to `HELP_TEXT` and `scripts/telegram-setup.ts` (`setMyCommands`); the user re-runs `pnpm telegram:setup` after deploy.

## Tests

- Unit: CSV escaping (quotes, commas, newlines, null, arrays, jsonb, BOM); zip output readable (round-trip with `unzip -l` in a test is fine, or parse the central directory); file naming by Rome date; captions; `classify` for every row of the §4 table, including `BotError` and `cause` unwrapping; budget messages (daily/monthly/voice, reset date at month end and in December); counted-token formula; per-kind time budget (voice at 0 s runs, voice at 30 s waits, text at 30 s runs, commands at 44 s run).
- DB: coverage test (§1); export → restore into the emptied test DB → export again gives identical `tables` (round trip, including timestamps, arrays, jsonb, enums, numerics); every refusal rule; sequences continue after restore (a new insert gets max id + 1); inbox `pending` → `failed`, `pending_actions` `open` → `expired`; a ledger key from the backup still short-circuits `executeActions` after restore; dry-run leaves the DB empty; weekly-backup job window (Sun 17:59 no, 18:00 yes, 21:59 yes, 22:00 no) and that it sends two documents; `/export` sends two documents; `/usage` numbers.
- The db test helper must restore the test DB's baseline after the "empty target" tests (builder's call: truncate + reseed per test file, as existing db tests do).

## Left to the builder

Marked "Builder's call" above: exact field names in `schema`, FK-order source, chunk size, zip store vs deflate, gzip branch, `chat_lease` skip vs reset, `inbox.error` format, `JobContext.sendDocument` required vs optional, where the input kind is read from the payload.
