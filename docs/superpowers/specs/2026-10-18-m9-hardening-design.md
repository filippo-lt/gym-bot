# M9 — Hardening: cost guard, backup, restore, failure messages

_Design, 18 Oct 2026. SPEC.md stays the source of truth; this document records what M9 adds. The user said "skip the questions, you decide", then asked for an independent agent to answer the open design questions. The decisions below are that agent's answers (questions A1–E6 and the answers are in `2026-10-18-m9-design-qa.md`), adopted as written; where we added detail or deviated, it says **our call**. "Builder's call" marks what is left to the implementer. Disagreements are listed at the end under "Open points for the user"._

## Why

M0–M6 are live and the bot is now the single source of truth for training history (SPEC "Transition"). Three things can still go wrong without the user noticing in time:

1. **Data loss.** Supabase free has no point-in-time restore. A dropped table or a lost project loses everything since the old tool's export.
2. **Silent failures.** When Anthropic, the speech-to-text provider, a Telegram download or the database fails, the user gets a generic "couldn't process that", or nothing at all until the third inbox retry (up to ~30 minutes later).
3. **Cost and time limits with gaps.** The AI caps ignore cache tokens, the "budget reached" text doesn't say which cap or when it resets, and a voice note or photo picked up late in an invocation can run past the 90 s function limit.

## Goals

1. A backup of every table (except the transient `inbox` and `chat_lease`) as JSON (lossless, used by restore) plus CSV (one file per table, zipped), sent to Telegram by `/export` and automatically every Sunday at 18:00 Rome. A local `pnpm backup` writes the same files to disk.
2. The backup is **table-generic**: driven by the database catalog, so tables M7/M8 add are covered with no code change. A test fails when the catalog and the Drizzle schema disagree, or when a table is neither backed up nor explicitly excluded.
3. A restore script that loads a backup into an **empty, migrated** database, same shape as `pnpm history:import` (review → dry-run → one transaction), with refusal rules, keeping the write_ledger and idempotency guarantees.
4. Every failing step in chat (Anthropic, STT, vision, Telegram file download, database) produces a short message naming the service and what to do.
5. Cost guard: cache tokens count (weighted), the user sees which cap was hit and when it resets, `/usage` shows the numbers, and no input runs past `maxDuration`.

## Non-goals

- The weekly **training** summary (SPEC §3 "summary + backup", §5.6e weekly_summary). It will be its own Sunday job, so a summary or LLM failure can never block the backup. Not in M9.
- Merging a backup into a database that has data; restoring one table or a date range.
- Restore from Telegram. Restore is a local script only (the target is a new DB the deployed bot isn't connected to; it can exceed 90 s; a remote wipe-and-write command reachable with the bot token is a risk).
- Backups stored outside the user's Telegram chat and disk; encryption.
- Changing `pnpm history:import` or the `source = import` semantics.

## Anti-goals (a failure even if it works)

- A restore that writes into a database that already holds data.
- A restore that lets a new row reuse an id that a restored `write_ledger` key or callback refers to (✅ would then silently save nothing).
- A table added by M7/M8 that silently doesn't make it into the backup.
- A failure message or log line that leaks a secret, a file URL with the bot token, SQL parameters, row contents, or the user's message text.
- A failure message that guesses the service: the call site says which step failed; the classifier never infers "Claude" from a bare timeout.

## Current state (what we found)

- **Cost guard** (`src/ai/budget.ts`, `src/logging/usage.ts`): `usage_logs` stores input, output, cache read, cache write tokens and STT seconds per call. The caps (`AI_DAILY_TOKEN_CAP` 200 000, `AI_MONTHLY_TOKEN_CAP` 3 000 000) sum **input + output only**. The loop checks the cap before every model call (6 turns, 40 s; 35 s per request, SDK `maxRetries: 2`). Vision checks the same cap first and records after. STT checks `STT_DAILY_SECONDS_CAP` before the download and records after a successful transcription. Replies: "AI budget reached. Commands still work." / "Voice budget reached. Text still works."
- **Time budget:** `maxDuration` 90 s; no new row is claimed after 45 s. Worst case per row: voice ≈ 15 s download + 20 s STT + 40 s loop; photo ≈ 15 s + 40 s vision; text ≈ 40 s. A late voice note or photo is killed at 90 s, retried after the 150 s lease, re-billed (Known issue E3), and `failed` after three kills.
- **Failures:** text → one generic "Sorry, I couldn't process that." Voice → `VOICE_FAILED` for download and STT alike. Photo → `PHOTO_FAILED` for download, vision and "too large". Errors thrown out of a handler (most often DB) give silence until the third attempt, then `FAILED_MESSAGE` with no reason. grammY wraps handler errors in `BotError`; Drizzle wraps DB errors in `DrizzleQueryError` whose message holds SQL and params.
- **Jobs:** one job (Thursday class question); `JobContext.send` is text only; M8 adds a morning job (and needs to send photos).
- **Inbox:** `src/db/schema/runtime.ts` has `TODO(M9): retention - purge done rows after N days`.
- **Already built on this branch (Task 1):** `src/failures/` classifier and texts, `AiTimeoutError` for the loop's 40 s abort.

## Design

### 1. Backup (export)

**Where:** `src/backup/` (new). Pure helpers (CSV, zip, names, summary text) unit-tested; DB parts db-tested.

**Which tables (A1, A2):** every base table in schema `public` from the database catalog, minus an explicit exclusion list in code: `inbox` (transient queue, biggest table, raw payloads) and `chat_lease` (lock state). `write_ledger`, `pending_actions`, `job_runs`, `usage_logs`, `conversation_messages` are included: they keep idempotency, cap continuity and memory context after a restore. The catalog also gives primary keys (row order), serial sequences and foreign keys (restore order). A table M7 adds is backed up by default.

**Reading rows losslessly (A3):** one query per table, sequential (session pooler): `select coalesce(jsonb_agg(to_jsonb(t) order by <pk>), '[]'::jsonb)::text as rows, … from <table> t` (order by every column when there is no primary key). Keep each table's JSON **opaque** in JS on export: the file text is assembled from Postgres's per-table text, never parsed and re-stringified, so numeric/bigint precision can't be lost. Identifiers come from the catalog and are quoted (`sql.identifier` or `format('%I')`), never from input.

**JSON file** `gymbot-backup-YYYY-MM-DD.json` (Rome date):

```json
{
  "format": "gymbot-backup",
  "version": 1,
  "created_at": "2026-10-25T17:00:03.120Z",
  "migrations": ["<hash of 0000>", "...", "<hash of 0006>"],
  "excluded": ["chat_lease", "inbox"],
  "manifest": { "log_groups": { "rows": 123, "sha256": "<hex>" } },
  "tables": { "log_groups": [ { "id": 1, "session_date": "2026-09-28" } ] }
}
```

- `migrations`: the `hash` column of `drizzle.__drizzle_migrations` in id order (B3).
- `manifest[t].sha256` = Postgres `encode(sha256(convert_to(<rows jsonb>::text, 'UTF8')), 'hex')` of that table's rows. Restore recomputes it in Postgres from the parsed rows (jsonb text is canonical), so truncation, edits or precision loss all fail the check. **Our call** on computing it in Postgres.

**Gzip and size (A5):** if the JSON is over **10 MB**, send `gymbot-backup-YYYY-MM-DD.json.gz` instead (gzip via `node:zlib`). If the file to send (JSON or gz) is over **45 MB**, don't send: reply with the size and "Run pnpm backup locally (no size limit)." Restore reads `.json` and `.json.gz`.

**CSV (A4):** `gymbot-backup-YYYY-MM-DD-csv.zip`, one `<table>.csv` per backed-up table, built from the same rows: header = column names (catalog order), UTF-8 with BOM, RFC 4180 quoting, `null` → empty, arrays/jsonb → JSON text. Zip writer in-repo (`zlib.crc32`, store or deflate: builder's call). No new dependency.

**Summary message (A7):** before the two documents, one text message, formatted in code: date/time (Rome), row count for every backed-up table (one compact line or a short list; non-zero first is fine), and on Sunday the week's AI tokens and voice minutes **against the caps**. Ends with "Keep these files: they are your only restore point." **Our call:** a separate text message rather than a document caption, because Telegram captions are limited to 1024 characters.

**`/export`:** replies "Preparing your backup…", then the summary and the two documents. Works without the AI key. Failures per §4.

**`pnpm backup` (A5):** `scripts/backup.ts` writes the same JSON (never gzipped locally) and zip into `backups/` (git-ignored), reading `DATABASE_URL`. Read-only on the DB.

**Sunday job `weekly_backup` (A6):** `src/jobs/weekly-backup.ts`, window **Sunday 18:00 ≤ Rome time < 23:00**, appended to `JOBS`. On failure it rethrows, so the row stays `claimed` and the runner retries on later ticks (5-minute reclaim). It sends one failure notice, "Weekly backup failed (<reason>). Use /export or pnpm backup.", only on its **last chance** (a run at or after 22:30 Rome), so a transient error stays silent and a real miss never does.

**JobContext (other risk 3):** one additive member, shared with M8: `sendFile(file: { kind: "document" | "photo"; name: string; data: Uint8Array; caption?: string }): Promise<void>`. `api/cron/tick.ts` passes `sendFileToOwner` (new, `src/runtime/telegram-runtime.ts`, grammY `InputFile`; `sendDocument` or `sendPhoto` by kind). M8 is told this shape through the shared notes.

**Tick order (other risk 2), our call:** keep jobs before the sweep. The sweep already decides per row whether it fits in the time left (§3.5), so a slow Sunday backup only leaves rows for the next webhook or tick; it can't make a row overrun.

**Inbox retention (other risk 4), our call to include:** the tick deletes `inbox` rows with status `done` or `failed` older than **30 days** (well past Telegram's 24 h redelivery window), one statement, after the jobs. Resolves the `TODO(M9)` comment.

**Coverage tests (A8, required)**, db project, migrated test DB:
1. catalog base tables in `public` == table names from the Drizzle schema exports (`getTableConfig`), so a table missing from either side fails;
2. every catalog table is in the backup or in the exclusion list, and every excluded name exists;
3. round trip: fixture rows covering every column type in use (enum, text[], jsonb, timestamptz, date, numeric/real incl. trailing zeros, bigint, boolean, nulls) → backup → restore into a truncated DB → per-table `to_jsonb` equality, and each sequence's next value > max(id).

### 2. Restore

**Entry point (B6):** `pnpm backup:restore <file.json|file.json.gz> [--dry-run] [--allow-remote]` (`scripts/backup-restore.ts`), the same shape as `pnpm history:import`: read + validate → print a review (target, backup date and age, per-table rows) → `--dry-run` runs the full transaction and rolls back (the `DryRunRollback` pattern from `src/db/import-history.ts`) → the real run is one transaction → JSON summary. Typed refusal errors, message only, exit code 1.

**Target (B1, B2):** only a fresh, empty, migrated database (local, or a new Supabase project). `RESTORE_DATABASE_URL`, required, **no fallback** (`.env.local` holds the production `DATABASE_URL`). Rejects port 6543 like `dbEnv`. The review prints host and database name, never the password.

**Refusal rules (B3)**, all before any write:

1. Not a valid backup: invalid JSON/gzip, wrong `format`/`version`, a table's row count or sha256 doesn't match its manifest entry.
2. Target has a row in any `public` table (so a DB where `pnpm plan:seed` already ran is refused too).
3. Migration list differs: target `drizzle.__drizzle_migrations` hashes ≠ the backup's `migrations`. Message: restore into a DB at the same migration, then run `pnpm db:migrate`. Also refused: a backup table missing in the target, a target table (not excluded) missing in the backup, or a column in the file that the target table lacks.
4. Non-local host (not `localhost`, `127.0.0.1`, `::1`) without `--allow-remote`.
5. Dry-run first is **not enforced in code** (B3 v): the empty-target rule plus one transaction make a bad real run harmless, and the runbook requires the dry-run and the user's OK for a production write.

**What the transaction does (B4, B5):**

1. Insert in **foreign-key order** (parents first) from the catalog (`pg_constraint`), self-references ignored, cycle → error. Original ids kept. **Our call (review):** the file text goes to Postgres once (a temp `jsonb` table) and each table is inserted with `insert into <t> select * from jsonb_populate_recordset(null::<t>, doc->'tables'->'<t>')`, so numbers never round-trip through JS (a value like `55.50` or a bigint above 2^53 would otherwise change form and fail the sha256 check). JS parses the file only to validate it.
   - **Not preserved:** a jsonb column holding JSON `null` comes back as SQL `NULL` (`to_jsonb` renders both as `null`, so the export can't tell them apart). The app never writes JSON `null` into a jsonb column.
2. `setval` every serial/bigserial sequence (`pg_get_serial_sequence`) to max(id) (`is_called = false` at 1 for an empty table), so a new `pending_actions` id can never reuse a restored `p:<id>` ledger key.
3. Runtime state: `inbox` and `chat_lease` start empty (excluded; `acquireOrRenew` creates the lease row). `pending_actions` and `job_runs` are restored **verbatim**: open cards are past `expires_at` (30 min) by the time anyone restores, so the existing expiry logic treats them as expired, and `done` job runs stop a same-day re-send. No rewrite of runtime rows.
4. Re-check each table's row count and sha256 in Postgres after inserting.
5. `refreshUserState` (user_state is only a cache, SPEC §6).
6. Dry run: throw the rollback marker after step 5, print the summary with "dry run (rolled back)".

**Why the guarantees hold:** `write_ledger` comes back verbatim with the original ids its `result` jsonb points at, so a re-tapped old card or a redelivered update already written returns the stored result and writes nothing; sequences continue past every restored id; `source = import` and `import_row_key` are kept, so a later `pnpm history:import` still replaces only import rows. Data written after the backup's `created_at` is lost; the review prints the backup's age. Inbox dedupe of old `update_id`s is not restored (inbox excluded): Telegram only redelivers unacknowledged updates for 24 h, and the restored ledger still blocks a double write for any update that was written.

**Disaster procedure** (new section "Restore from a backup" in `docs/SETUP.md`): new Supabase project → `pnpm db:migrate` against it → download the latest backup from Telegram → `RESTORE_DATABASE_URL=… pnpm backup:restore <file> --allow-remote --dry-run` → the same without `--dry-run` → point Vercel `DATABASE_URL` at the new project → redeploy → health check. Each remote write needs the user's explicit OK. A local rehearsal (back up the Docker `gymbot` DB, restore into a new empty `gymbot_restore` DB) is in the demo and in SETUP.md.

### 3. Cost guard

1. **Weighted tokens (C1):** counted = `input + output + 1.25 × cache_write + 0.1 × cache_read`, weights as constants in `src/ai/constants.ts` (`CACHE_WRITE_WEIGHT = 1.25`, `CACHE_READ_WEIGHT = 0.1`), summed in SQL in `UsageStore.totals` (rounded to whole tokens for display). Env names and defaults stay.
2. **Vision shares the AI cap (C2).** STT keeps its seconds cap.
3. **Cap texts (C3)**, numbers formatted in code; caps are per Rome calendar date, so "midnight":
   - "AI daily budget reached (200,000 tokens). Resets at midnight (Rome). Commands still work."
   - "AI monthly budget reached (3,000,000 tokens). Resets on 1 Nov. Commands still work." (first day of the next Rome month)
   - "Voice budget reached (30 of 30 min today). Resets at midnight (Rome). Typing still works."
   - `overTokenBudget` returns which cap was hit (`"day" | "month" | null`); the loop's `budget_reached` carries it.
4. **`/usage` (C4):** code only, no AI (works when the budget is reached). Today's and this month's counted tokens against the caps (with %), today's voice minutes against the voice cap. Registered in `setMyCommands` and `HELP_TEXT`. The same numbers (week totals) go in the Sunday summary.
5. **Time budget (C5, C6):**
   - The processor knows the invocation's **hard end** = start + 85 s (`MAX_DURATION_S − 5`). It passes it to the handler through an async-local deadline (`src/runtime/deadline.ts`: `runWithDeadline(endMs, fn)`, `timeLeftMs()`), so the flows clamp their timeouts to the time left: AI loop budget = `min(40 s, timeLeft − 5 s)`, STT, vision and download timeouts the same way. **Our call** on AsyncLocalStorage as the carrier (the handler is called through grammY, which has no per-call options).
   - Before claiming a row, a per-kind minimum time left is required: text and callbacks/commands **45 s**, photo **60 s**, voice **75 s**; otherwise stop with `deadline` (attempts untouched; the row waits for the next webhook or tick). **Our call:** the first row of an invocation runs (with clamped timeouts) when fewer than 15 s have passed since the start (`FIRST_ROW_GRACE_MS`), so a cold start that ate 10 s can't strand a voice note for 15 minutes; a first row reached later must meet the minimum like any other.
   - Loop ceilings stay at 6 turns and 40 s.

### 4. Failure messages in chat

**Module (D4):** `src/failures/` (built in Task 1): pure, unit-tested. Call sites pass the step (`ai`, `vision`, `stt`, `download`, `other`); the classifier never guesses the service. It reads only class, `name`, HTTP `status`, SQLSTATE / Node `code`, after unwrapping `BotError.error` and `DrizzleQueryError.cause`, never message text. `inbox.error` stores `kind (detail)`.

**Granularity (D1):** one message per service with a small cause set mapped to what to do: temporary (timeout, overloaded, rate limit, network → try again), config (key rejected, refused/quota → check config, D3: name the env var, never a value), input (too large), unknown. The texts built in Task 1 follow this; e.g. "The Anthropic API key was rejected. Check ANTHROPIC_API_KEY in Vercel. Commands still work."

**Rule from D4, our call on the detail:** a bare `TimeoutError`/`AbortError` (no SDK class) is `ai_timeout` only when the call site said `ai` or `vision`; on `other` (the inbox path) it is `unknown`. SDK classes (`APIUserAbortError`, `APIConnectionTimeoutError`) are Anthropic wherever they appear.

**Where they're used:**

- **text / voice / photo** (`src/bot/logging-flow.ts`): separate `try` blocks for download, STT and vision so the message names the right step; the AI loop's failure is classified with step `ai`.
- **Photo size (E6):** before downloading, pick the largest `PhotoSize` whose `file_size` ≤ 3.5 MB (Telegram always sends smaller sizes too). Only if none fits (or the download still exceeds the cap), reply "That photo is too large (max 3.5 MB). Send it compressed (not as a file) or crop it."
- **Inbox, first failure (D2):** when a row fails on attempt 1 and will be retried: "⚠️ Something went wrong (<reason>) while handling your last message. I'll retry automatically, so don't send it again." (A resend gets a new update id, so the ledger could not dedupe it and a log would be saved twice.)
- **Inbox, final failure:** "Sorry, I couldn't process your last message after 3 tries (<reason>). Please send it again." Rows the sweep fails after a timeout get the reason "it took too long".
- **Jobs:** the backup job's last-chance notice (§1). Other jobs unchanged.
- A Telegram send failure can't be reported in chat; it stays in the Vercel logs.

### 5. Known minor issues (E1–E6)

| Issue | Decision |
|---|---|
| E1 duplicate-user-message check keyed on text | Leave: only skips a repeated identical line in the 10-message context; writes are deduped by write_ledger; fix needs a migration. |
| E2 re-import leaves a bot-logged slot `source = bot` | Leave, documented: re-import is a one-off cutover tool. |
| E3 crash after STT/vision re-bills on retry | Leave: bounded by 3 attempts and the caps; §3.5 removes the main cause (kills at `maxDuration`). |
| E4 undo after a re-import restores the logged-time status | Leave: one-off re-import; consistent with "history is never rewritten". |
| E5 job can send again if marking done fails | Leave: SPEC §2 chose at-least-once; the window bounds repeats; a duplicate backup is harmless. |
| E6 photo over 3.5 MB gets the generic reply | **Fix** (§4, smaller PhotoSize first). |

## Constraints

- No migration. No new runtime dependency.
- Job registration additive; `runDueJobs`, claim and markDone unchanged.
- Session pooler rule: no concurrent queries on one connection.
- Logs never contain message text, SQL parameters, row contents, file URLs or secrets.
- Every number the user sees is formatted in code.
- `/export` and `/usage` go into `HELP_TEXT` and `scripts/telegram-setup.ts`; the user re-runs `pnpm telegram:setup` after deploy.
- db tests run against `gymbot_m9_test` (`TEST_DATABASE_URL=postgres://postgres:postgres@localhost:54329/gymbot_m9_test pnpm test:db`): the three worktrees share one Postgres container.

## Open points for the user

None where we strongly disagree with the independent answers. Points the user may want to look at:

- **Dry-run is not enforced in code** (B3 v). It relies on the runbook. The empty-target rule makes a mistaken real run harmless, so we kept the agent's answer.
- **Open cards after a restore** rely on `expires_at` (30 min). A restore done within 30 minutes of the backup could leave a card tappable; tapping it writes through the normal ledger path, so nothing duplicates.
