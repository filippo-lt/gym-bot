# M9 Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Weekly + on-demand table-generic backup (JSON + CSV zip) to Telegram, a refusal-guarded restore script, specific failure messages in chat, and cost-guard fixes.

**Architecture:** New `src/failures/` (pure error → message), new `src/backup/` (schema-driven export, CSV, zip, restore), small edits to the AI budget, the logging flow, the inbox runtime and the jobs list. Postgres renders and parses rows as JSON (`to_jsonb` / `jsonb_populate_recordset`), so no per-type mapping lives in JS.

**Tech Stack:** TypeScript strict, Drizzle (`getTableConfig`, `is`, `PgTable`), postgres-js, grammY (`InputFile`), Luxon, Vitest, `node:zlib`.

**Spec:** `docs/superpowers/specs/2026-10-18-m9-hardening-design.md` (read it before your task).

## Global Constraints

- No migration. No new runtime dependency.
- Session pooler rule: never `Promise.all` DB queries; one query at a time.
- Logs and stored errors never contain message text, SQL parameters, file URLs, response bodies, or secrets. Drizzle wraps driver errors in `DrizzleQueryError` whose `message` contains the SQL and params: never log or store `.message` of a DB error; use `name`, `code`, `status` only, and unwrap `.cause`.
- Every number shown to the user is formatted in code.
- Do not change `runDueJobs`, `claim`, `markDone` in `src/jobs/runner.ts`. Job registration stays additive (`JOBS` array).
- Plain, short English in chat texts (user is not a native speaker). Copy in the spec's §3 and §4 tables is fixed; use it verbatim.
- Every task ends with `pnpm lint && pnpm typecheck && pnpm test` green, plus `pnpm test:db` when the task touches DB code (`pnpm db:up` first). Commit as `filippo-lt <filippo.tosetto@leadtech.com>` (`git commit --author="filippo-lt <filippo.tosetto@leadtech.com>"`), concise message, **no AI attribution or Co-Authored-By lines**. Commit only your task's files.
- Match the surrounding code: comment density, naming, idiom (`.js` import suffixes, Biome formatting).

## Review Focus

- A DB error whose message contains user text reaching `inbox.error` or `console.error` → must store/log only kind + name/code. (Task 4 test: a `DrizzleQueryError` with params "secret text" → `inbox.error` doesn't contain it.)
- A backup with zero rows in some tables, `null` columns, jsonb `null` vs SQL `NULL`, text arrays, enums, timestamptz → round trip identical. (Task 7 round-trip test seeds those.)
- A restore started against a DB that only has migrations + `pnpm plan:seed` data → refused as not empty. (Task 7 test.)
- A voice note queued behind a slow text in the same invocation → waits for the next webhook/tick, never killed at 90 s. (Task 4 test.)
- Month-end budget reset text on 31 Dec → "It resets on 1 Jan." (Task 2 test.)

---

### Task 1: Failure classifier and texts

**Files:**
- Create: `src/failures/classify.ts`, `src/failures/messages.ts`, `src/ai/errors.ts`
- Modify: `src/ai/loop.ts` (abort with `new AiTimeoutError()` instead of `new Error("AI budget exceeded")`)
- Test: `test/failures/classify.test.ts`, `test/failures/messages.test.ts`

**Interfaces:**
- Produces:
  - `src/ai/errors.ts`: `export class AiTimeoutError extends Error` (name `"AiTimeoutError"`).
  - `src/failures/classify.ts`:
    ```ts
    export type FailureStep = "ai" | "vision" | "stt" | "download" | "other";
    export type FailureKind =
      | "ai_timeout" | "ai_overloaded" | "ai_rate_limited" | "ai_auth" | "ai_refused" | "ai_network"
      | "stt_timeout" | "stt_rate_limited" | "stt_auth" | "stt_down" | "stt_failed"
      | "download_failed" | "file_too_large" | "db" | "row_timeout" | "unknown";
    export interface Failure { kind: FailureKind; detail: string } // detail: name/code/status only, ≤ 120 chars
    export function classify(error: unknown, step?: FailureStep): Failure;
    export function describeFailure(f: Failure): string; // `${kind} (${detail})`, for inbox.error and logs
    ```
  - `src/failures/messages.ts`:
    ```ts
    export function failureText(f: Failure, input: "text" | "voice" | "photo", provider?: string): string;
    export function reasonPhrase(f: Failure): string; // "Claude took too long" | "a database error" | "it took too long" | "an unexpected error" | ...
    export function retryingText(f: Failure): string;
    export function failedText(f: Failure): string;
    export function providerLabel(sttName: string): string; // "groq:whisper-large-v3-turbo" → "Groq", "openai:whisper-1" → "OpenAI"
    ```

Rules for `classify` (first unwrap: grammY `BotError` → `.error`; then follow `.cause` while the current error is a `DrizzleQueryError` or has no own `status`/`code`, max 5 hops):
- `FileTooLargeError` → `file_too_large` (any step).
- step `download` → `download_failed` for anything else.
- `AiTimeoutError`, SDK `APIConnectionTimeoutError` → `ai_timeout` (step ai/vision).
- `APIError` with `status` 529/500/502/503/504 → `ai_overloaded`; 429 → `ai_rate_limited`; 401/403 → `ai_auth`; 400 → `ai_refused`; `APIConnectionError` → `ai_network`.
- step `stt`: `SttError` 429 → `stt_rate_limited`, 401/403 → `stt_auth`, ≥ 500 → `stt_down`, other status → `stt_failed`; `name` `TimeoutError`/`AbortError` → `stt_timeout`; anything else → `stt_failed`.
- `name === "PostgresError"` or `code` in `CONNECT_TIMEOUT, CONNECTION_CLOSED, CONNECTION_ENDED, CONNECTION_DESTROYED, ECONNREFUSED, ECONNRESET, ETIMEDOUT, ENOTFOUND` → `db`.
- otherwise `unknown`.

Texts: exactly the spec §4 table. For `input: "photo"` the AI kinds start "I couldn't read the photo: " and drop "Commands still work." (builder's call on the exact join, keep it one or two short sentences). `file_too_large` with `photo` → "That photo is too large (max 3.5 MB). Send it compressed (not as a file) or crop it."; with `voice` → "That voice note is too large to download.". STT kinds name the provider: e.g. `stt_timeout` → "Transcription took too long (Groq). Please try again or type it."; `stt_rate_limited` → "Too many voice notes for Groq right now. Wait a minute or type it."; `stt_auth` → "The Groq API key was rejected. Check it in Vercel. Typing still works."; `stt_down` → "Groq is having problems right now. Please type it."; `stt_failed` → "Sorry, I couldn't transcribe that (Groq). Please try again or type it.". `db`/`unknown`/`row_timeout` in `failureText` → "Sorry, something went wrong (<reasonPhrase>). Please try again.".
`retryingText(f)` = `⚠️ Something went wrong (${reasonPhrase(f)}) while handling your last message. I'll retry automatically in a few minutes.`
`failedText(f)` = `Sorry, I couldn't process your last message after 3 tries (${reasonPhrase(f)}). Please send it again.`
`reasonPhrase`: ai_timeout "Claude took too long", ai_overloaded "Claude is having problems", ai_rate_limited "too many AI requests", ai_auth "the Anthropic key was rejected", ai_refused "Anthropic refused the request", ai_network "I couldn't reach Claude", stt_* "transcription failed", download_failed "the Telegram download failed", file_too_large "the file is too large", db "a database error", row_timeout "it took too long", unknown "an unexpected error".

- [ ] **Step 1: Write failing tests** — one `it` per classify rule above (construct real SDK errors with `new Anthropic.APIError(529, undefined, undefined, new Headers())` or the SDK's subclasses; `new SttError(429, "groq")`; a `BotError`-like `{ name: "BotError", error: inner }`; a `DrizzleQueryError`-like `Object.assign(new Error("select … params: secret text"), { name: "DrizzleQueryError", cause: Object.assign(new Error("x"), { name: "PostgresError", code: "23505" }) })` → `{ kind: "db" }` and `describeFailure` does not contain "secret text"). Messages: snapshot-free `toBe` assertions on the strings above, `providerLabel` both providers.
- [ ] **Step 2: Run** `pnpm exec vitest run --project unit test/failures` → FAIL (modules missing).
- [ ] **Step 3: Implement** the three files and the `loop.ts` abort change. `test/ai/loop.test.ts` must still pass (update an assertion only if it checked the old error message).
- [ ] **Step 4: Run** `pnpm lint && pnpm typecheck && pnpm test` → PASS.
- [ ] **Step 5: Commit** `M9: failure classifier and chat texts`.

### Task 2: Cost guard — counted tokens, which cap, `/usage`

**Files:**
- Modify: `src/ai/budget.ts`, `src/logging/usage.ts`, `src/logging/types.ts` (`UsageStore`, `IntentResult`), `src/ai/loop.ts`, `src/bot/logging-flow.ts` (budget replies + `usageCommand`), `src/bot/log-format.ts` (texts, `HELP_TEXT`), `src/bot/bot.ts` (`/usage`), `scripts/telegram-setup.ts` (`{ command: "usage", description: "AI and voice usage" }`)
- Create: `src/bot/usage-format.ts`
- Test: `test/ai/budget.test.ts` (new), `test/ai/loop.test.ts`, `test/bot/usage-format.test.ts` (new), `test/db/usage.test.ts` (new), existing bot tests as needed

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `budget.ts`: `export function countedTokens(u: Pick<TokenUsage, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">): number` = `input + output + cacheWrite + Math.ceil(cacheRead / 10)`; `export type BudgetCap = "day" | "month"`; `overTokenBudget(...)` now returns `Promise<BudgetCap | null>` (day checked first).
  - `UsageStore.totals` sums the same formula in SQL (`ceil(cache_read_tokens / 10.0)`); new `UsageStore.weekTotals(now): Promise<{ tokens: number; sttSeconds: number }>` for the Rome ISO week (Mon–Sun) containing `now` (used by Task 6).
  - `IntentResult` budget variant: `{ kind: "budget_reached"; cap: BudgetCap }`.
  - `log-format.ts`: `export function budgetReachedText(cap: BudgetCap, now: Date): string`, `export function voiceBudgetText(usedSeconds: number, capSeconds: number): string`. Replace the `BUDGET_REACHED` and `VOICE_BUDGET` constants (remove them if unused).
  - `usage-format.ts`: `export function formatUsage(u: { date: string; dayTokens: number; monthTokens: number; sttSecondsToday: number; caps: { day: number; month: number; sttSeconds: number | null } | null }): string`.
  - `Flow.usageCommand(ctx: Context): Promise<void>`.

Texts (spec §3): daily "AI budget for today is used up. It resets at midnight (Rome time). Commands still work."; monthly "AI budget for this month is used up. It resets on 1 Nov. Commands still work." (first day of next Rome month, `d LLL`, English); voice "Voice budget for today is used up (30 of 30 min). It resets at midnight. Typing still works." (minutes = `Math.min(cap, Math.round(used / 60))` of `Math.round(cap / 60)`; builder's call on rounding as long as it never shows more than the cap).
`/usage` layout (numbers with thousands separators, % rounded down):
```
Usage on 19 Oct:
AI today: 12,345 of 200,000 tokens (6%)
AI this month: 123,456 of 3,000,000 tokens (4%)
Voice today: 4 of 30 min
```
Without AI env: "AI today: 12,345 tokens" (no cap); without STT env: "Voice today: 4 min". Reading caps must not throw out of the command (catch env errors). Works without the AI key (it is a command).

- [ ] **Step 1: Failing tests**: `countedTokens({input 100, output 50, cacheWrite 20, cacheRead 1001})` = 271; `overTokenBudget` returns "day" / "month" / null with a fake store; loop test "budget_reached carries the cap"; `budgetReachedText("month", 2026-12-31T22:30Z)` (23:30 Rome on 31 Dec) → contains "resets on 1 Jan"; `budgetReachedText("month", 2026-10-18T10:00Z)` contains "1 Nov"; voice text never shows used > cap; `formatUsage` with and without caps; db test: rows with cache tokens → `totals` and `weekTotals` match `countedTokens`; bot/flow test: `/usage` replies with the layout.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** In `logging-flow.ts` pass `result.cap` to `budgetReachedText`; the photo pre-check uses the returned cap; voice uses `voiceBudgetText(usedToday, cap)`. Add `/usage` to `HELP_TEXT`.
- [ ] **Step 4: Run** `pnpm lint && pnpm typecheck && pnpm test && pnpm test:db` → PASS.
- [ ] **Step 5: Commit** `M9: cost guard counts cache tokens, names the cap, /usage`.

### Task 3: Specific failure messages in text, voice and photo

**Files:**
- Modify: `src/bot/logging-flow.ts` (`handleInput` catch, `voice`, `photo`), `src/bot/log-format.ts` (drop `VOICE_FAILED`/`PHOTO_FAILED` if unused)
- Test: `test/db/bot-voice.test.ts`, `test/db/bot-photo.test.ts`, `test/db/logging-flow.test.ts` (or wherever the flow's text path is tested with a fake model)

**Interfaces:**
- Consumes (Task 1): `classify`, `failureText`, `providerLabel`, `describeFailure`.

Behaviour:
- `handleInput` catch → `failureText(classify(error, "ai"), source)`, prefixed by the heard line for voice (as other voice replies are); log `console.error("ai: intent failed", describeFailure(f))`.
- `voice`: separate `try` for the download (`classify(e, "download")`) and for `transcribe` (`classify(e, "stt")`); provider label from `sttConfig.stt.name`.
- `photo`: separate `try` for the download (`classify(e, "download")`, so `FileTooLargeError` → the too-large text) and for `readBoard` (`classify(e, "vision")`).
- Usage recording and the existing order of checks stay as they are.

- [ ] **Step 1: Failing tests**: photo download throws `new FileTooLargeError(3.5 * 1024 * 1024)` → reply is the too-large text; photo `readBoard` model throws an `APIError` 529 → "I couldn't read the photo: …" overloaded text; voice transcribe throws `new SttError(429, "groq")` → rate-limit text naming Groq; voice download throws a plain `Error` → download text; text path model throws `AiTimeoutError` → "Claude took too long…"; and a `console.error` spy shows no message text in any of these logs.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm lint && pnpm typecheck && pnpm test && pnpm test:db` → PASS.
- [ ] **Step 5: Commit** `M9: specific failure messages for AI, STT, vision and downloads`.

### Task 4: Inbox notices and per-input time budget

**Files:**
- Modify: `src/runtime/process-chat.ts`, `src/runtime/telegram-runtime.ts` (`notifyFailed`, new `notifyRetrying`, remove `FAILED_MESSAGE` or derive it), `src/telegram/files.ts` (export `DOWNLOAD_TIMEOUT_MS = 15_000`, moved from telegram-runtime), `api/telegram.ts`, `api/cron/tick.ts` (pass `startedAt: start`)
- Create: `src/runtime/row-budget.ts`
- Test: `test/runtime/row-budget.test.ts` (new), `test/db/runtime.test.ts`

**Interfaces:**
- Consumes (Task 1): `classify`, `describeFailure`, `retryingText`, `failedText`, `Failure`.
- Produces:
  - `row-budget.ts`: `export type InputKind = "voice" | "photo" | "text" | "other"`; `export function inputKind(payload: unknown): InputKind` (Telegram update: `message.voice` → voice, `message.photo` → photo, `message.text` not starting with "/" → text, else other); `export function rowBudgetMs(kind: InputKind): number` = voice `DOWNLOAD_TIMEOUT_MS + STT_TIMEOUT_MS + AI_BUDGET_MS + 10_000`, photo `DOWNLOAD_TIMEOUT_MS + BOARD_TIMEOUT_MS + 10_000`, text `AI_BUDGET_MS + 10_000`, other `15_000` (import the constants; no literal 85_000 etc.); `export function fits(kind: InputKind, elapsedMs: number): boolean` = `elapsedMs + rowBudgetMs(kind) <= (MAX_DURATION_S - 5) * 1000`.
  - `ProcessChatDeps`: add `startedAt?: number` (default: `now()` when `processChat` is called), `notifyRetrying: (chatId: number, failure: Failure) => Promise<void>`; `notifyFailed` becomes `(chatId: number, payload: unknown, failure: Failure) => Promise<void>`.

Behaviour:
- Before claiming a row: if this invocation has already handled at least one row and `!fits(inputKind(row.payload), now() - startedAt)` → `stoppedReason = "deadline"`, return (row stays pending). The first row of an invocation always runs.
- Handler error: `f = classify(error)`; `markRetryOrFailed(..., describeFailure(f))`; if status `pending` and `claimed.attempts === 1` → `notifyRetrying(chatId, f)` (best effort, errors ignored); if `failed` → `notifyFailed(chatId, payload, f)`.
- Rows failed by `resetStuck` (timed out) → `notifyFailed(chatId, payload, { kind: "row_timeout", detail: "lease expired" })`.
- telegram-runtime: `notifyRetrying` sends `retryingText(f)`, `notifyFailed` sends `failedText(f)`.

- [ ] **Step 1: Failing tests**: `inputKind` for voice/photo/text/command/callback payloads; `fits("voice", 0)` true, `fits("voice", 30_000)` false, `fits("text", 30_000)` true, `fits("other", 44_000)` true; db runtime tests: two rows (text then voice) with a fake `now` that advances 30 s inside the first handler → voice row stays `pending`, `stoppedReason: "deadline"`; handler throws a DrizzleQueryError-like error carrying "secret text" → `inbox.error` starts with "db" and lacks "secret text", `notifyRetrying` called once on attempt 1 and not on attempt 2; third failure → `notifyFailed` with kind `db`; stuck row reset to failed → `notifyFailed` with `row_timeout`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm lint && pnpm typecheck && pnpm test && pnpm test:db` → PASS.
- [ ] **Step 5: Commit** `M9: inbox failure notices with a reason, per-input time budget`.

### Task 5: Backup core — schema tables, export, CSV, zip

**Files:**
- Create: `src/backup/tables.ts`, `src/backup/export.ts`, `src/backup/csv.ts`, `src/backup/zip.ts`
- Test: `test/backup/csv.test.ts`, `test/backup/zip.test.ts`, `test/backup/tables.test.ts`, `test/db/backup-export.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // tables.ts
  export interface BackupTable { name: string; columns: string[]; primaryKey: string[]; dependsOn: string[] }
  export function backupTables(): BackupTable[]; // every PgTable exported from src/db/schema/index.ts, sorted by name; DB (snake_case) names
  export function restoreOrder(tables: BackupTable[]): BackupTable[]; // parents first; self-references ignored; throws on a cycle
  // export.ts
  export interface SchemaVersion { migration_count: number; last_migration_at: number | null }
  export interface BackupFile {
    format: "gymbot-backup"; version: 1; created_at: string; schema: SchemaVersion;
    counts: Record<string, number>; tables: Record<string, Record<string, unknown>[]>;
  }
  export async function readSchemaVersion(db: Db): Promise<SchemaVersion>; // drizzle.__drizzle_migrations: count(*), max(created_at)
  export async function buildBackup(db: Db, now: Date): Promise<BackupFile>;
  export function backupFileNames(now: Date): { json: string; zip: string }; // gymbot-backup-YYYY-MM-DD.json / gymbot-backup-YYYY-MM-DD-csv.zip, Rome date
  export function backupCsvFiles(file: BackupFile, tables: BackupTable[]): { name: string; data: Uint8Array }[]; // <table>.csv each
  // csv.ts
  export function toCsv(columns: string[], rows: Record<string, unknown>[]): string; // BOM + header + CRLF rows
  // zip.ts
  export function zip(files: { name: string; data: Uint8Array }[]): Uint8Array;
  ```
- `Db` is the existing type from `src/db/client.ts` (or `src/db/seed-plan.ts`, whichever the jobs/import code uses).

Notes:
- Row reading per table, one query each: `select coalesce(jsonb_agg(to_jsonb(t) order by <pk cols>), '[]'::jsonb) as rows from <quoted table> t` (identifiers via `sql.identifier`/`sql.raw` of names that come from the schema, never from input). Order by all columns when there is no primary key.
- CSV cell: `null`/`undefined` → empty; string as is; number/boolean `String()`; object/array → `JSON.stringify`; quote when the cell has `"`, `,`, `\r` or `\n` (double the quotes).
- Zip: local headers + central directory + end record; CRC via `zlib.crc32`; deflate via `zlib.deflateRawSync` (method 8) or store (method 0), builder's call; UTF-8 flag (bit 11) set; DOS date from a fixed or current time.

- [ ] **Step 1: Failing tests**: `toCsv` cases (quote, comma, newline, null, array, object, BOM first char `﻿`, header order = columns); zip: write the bytes to the scratch dir, `execFileSync("unzip", ["-p", file, "a.csv"])` equals the input for two entries (CI ubuntu and macOS ship `unzip`); `backupTables()` includes `log_groups` with `dependsOn` containing `exercises`, `restoreOrder` puts `plans` before `plan_versions` before `planned_items` before `log_groups` before `log_entries`; db test **coverage**: every `table_name` in `information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'` is a key of `buildBackup(...).tables`, and every `backupTables()` name is too; `counts[name] === tables[name].length`; a timestamptz value comes back as an ISO string, a `text[]` as an array, jsonb as an object; `backupFileNames(2026-10-18T22:30Z)` → `2026-10-19` (Rome).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm lint && pnpm typecheck && pnpm test && pnpm test:db` → PASS.
- [ ] **Step 5: Commit** `M9: table-generic backup export with CSV zip`.

### Task 6: Backup delivery — `/export` and the Sunday job

**Files:**
- Create: `src/backup/send.ts`, `src/backup/caption.ts`, `src/jobs/weekly-backup.ts`, `src/bot/export-command.ts`
- Modify: `src/jobs/runner.ts` (`JobContext` only), `src/jobs/index.ts` (append), `api/cron/tick.ts`, `src/runtime/telegram-runtime.ts` (`sendDocumentToOwner`), `src/bot/bot.ts` (`/export`), `src/bot/log-format.ts` (`HELP_TEXT`), `scripts/telegram-setup.ts` (`{ command: "export", description: "Backup of all data" }`)
- Test: `test/backup/caption.test.ts`, `test/db/backup-send.test.ts` (job windows + documents), `test/bot/bot.test.ts` or a db bot test for `/export`, `test/db/jobs.test.ts` (ctx gains `sendDocument`)

**Interfaces:**
- Consumes: Task 5 (`buildBackup`, `backupFileNames`, `backupCsvFiles`, `backupTables`, `zip`), Task 2 (`UsageStore.weekTotals`, via `createUsageStore(db)`), Task 1 (`classify`, `reasonPhrase`, `describeFailure`).
- Produces:
  - `JobContext.sendDocument(file: { name: string; data: Uint8Array }, caption?: string): Promise<void>` (required member).
  - `export type SendDocument = JobContext["sendDocument"]` (in `send.ts` or runner, builder's call).
  - `export class BackupTooLargeError extends Error`; `export async function sendBackup(db: Db, now: Date, sendDocument: SendDocument, opts: { weekly: boolean }): Promise<void>` — builds the backup, refuses when the JSON is over 45 MB (`45 * 1024 * 1024` bytes), sends the JSON with the caption, then the zip with caption "CSV, one file per table."
  - `export function backupCaption(file: BackupFile, weekly: { tokens: number; sttSeconds: number } | null): string`.
  - `export const weeklyBackupJob: Job` (name `"weekly_backup"`, window Sunday 18:00 ≤ Rome < 22:00, date = that Sunday).
  - `export function createExportCommand(deps: { db: Db; now: () => Date }): (ctx: Context) => Promise<void>`.
  - `sendDocumentToOwner(file, caption?)` in telegram-runtime using `new InputFile(file.data, file.name)`.

Caption (HTML-safe plain text):
```
Backup of 25 Oct 2026, 19:00 (Rome).
Log groups 123 · sets 456 · class logs 4 · bodyweight 6 · readiness 10 · weekly metrics 12
This week: 45,678 AI tokens, 12 voice min.      ← weekly only
Keep this file: it is your only restore point.
```
Counts read from `file.counts` (`log_groups`, `log_entries`, `class_logs`, `bodyweight_logs`, `readiness_logs`, `weekly_metrics`).

Behaviour:
- `/export`: reply "Preparing your backup…", then `sendBackup(... weekly: false)` with `ctx.replyWithDocument`. On error: reply `Backup failed (${reasonPhrase(classify(e))}). Please try again.` (or "Backup too large for Telegram (over 45 MB)." for `BackupTooLargeError`); do not rethrow.
- Job: `sendBackup(... weekly: true)`; on error try `ctx.send({ text: "Weekly backup failed (<reason>). Send /export to try again.", keyboard: [] })` (ignore its error) and rethrow so the runner retries after 5 min.
- Add `/export` to `HELP_TEXT`.

- [ ] **Step 1: Failing tests**: caption with and without weekly line; job window Sun 2026-10-25 17:59 Rome → null, 18:00 → date `2026-10-25`, 21:59 → yes, 22:00 → null, Sat 18:00 → null; job run sends 2 documents named `gymbot-backup-2026-10-25.json` / `…-csv.zip` and the JSON parses with `format: "gymbot-backup"`; job with a failing `sendDocument` sends the failure text and the outcome is `failed` (row stays claimed); `/export` sends "Preparing your backup…" then 2 documents (capture `sendDocument` in the grammY transformer used by bot tests); existing class-question job tests still pass with the new ctx member.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm lint && pnpm typecheck && pnpm test && pnpm test:db` → PASS.
- [ ] **Step 5: Commit** `M9: /export and the Sunday 18:00 backup job`.

### Task 7: Restore script

**Files:**
- Create: `src/backup/restore.ts`, `scripts/backup-restore.ts`
- Modify: `src/config/env.ts` (`restoreEnv()`), `package.json` (`"backup:restore": "tsx scripts/backup-restore.ts"`), `docs/SETUP.md` (section "Restore from a backup", spec §2 disaster procedure + local rehearsal), `.env.example` if it exists (add `RESTORE_DATABASE_URL=` with a comment)
- Test: `test/db/backup-restore.test.ts`, `test/backup/restore-file.test.ts`, `test/config/env.test.ts`

**Interfaces:**
- Consumes: Task 5 (`BackupFile`, `backupTables`, `restoreOrder`, `readSchemaVersion`, `buildBackup`), `refreshUserState` from `src/progression/store.ts`.
- Produces:
  ```ts
  export type RestoreRefusal = "not_backup" | "counts_mismatch" | "target_not_empty" | "schema_mismatch" | "remote_not_allowed" | "confirm_mismatch";
  export class RestoreRefusedError extends Error { constructor(readonly reason: RestoreRefusal, message: string) }
  export function parseBackupFile(text: string): BackupFile;           // not_backup / counts_mismatch
  export function confirmCode(fileSha256: string, target: { host: string; database: string }): string; // 8 hex chars of sha256(`${fileSha256}|${host}|${database}`)
  export function isLocalHost(host: string): boolean;                   // localhost, 127.0.0.1, ::1
  export interface RestoreSummary {
    dryRun: boolean; backupCreatedAt: string; backupAgeHours: number;
    inserted: Record<string, number>; skipped: string[];
    normalised: { inboxFailed: number; pendingExpired: number }; confirmCode: string;
  }
  export async function restoreBackup(db: Db, file: BackupFile, opts: { dryRun: boolean; code: string; confirm?: string; now: Date }): Promise<RestoreSummary>;
  ```
  - `restoreEnv()`: `{ RESTORE_DATABASE_URL: string }`, required, no fallback, same 6543 refusal as `DATABASE_URL`.

Behaviour (spec §2, in this order, all refusals before any write):
1. `parseBackupFile`: valid JSON, `format === "gymbot-backup"`, `version === 1`, `counts[t] === tables[t].length` for every table.
2. In `restoreBackup`: first, if `!dryRun && confirm !== code` → `confirm_mismatch` (before opening the transaction). Then, inside one transaction: schema check (`readSchemaVersion` equal; backup table set == `backupTables()` names == target public base tables; each table's columns in the file rows ⊆ `BackupTable.columns`, and `BackupTable.columns` equal the target's `information_schema.columns`) → `schema_mismatch`; every target public table has 0 rows → else `target_not_empty`.
3. Insert in `restoreOrder`, skipping `chat_lease`, chunks of ≤ 500 rows: `insert into <t> select * from jsonb_populate_recordset(null::<t>, ${JSON.stringify(chunk)}::jsonb)`.
4. `setval` every column default sequence (`pg_get_serial_sequence`) to `max(col)` (`is_called` false with 1 when empty).
5. `update inbox set status='failed', error='restored from backup', done_at=now() where status in ('pending','processing')`; `update pending_actions set status='expired' where status='open'`; counts go in `normalised`.
6. `refreshUserState(tx, …)` (check its signature).
7. Dry run: throw a rollback marker, return the summary with `dryRun: true`.
- Script: `pnpm backup:restore <file> [--dry-run] [--confirm <code>] [--allow-remote]`; reads `restoreEnv()`, prints `target: <host>/<database>` (parse the URL; never print user/password), refuses a non-local host without `--allow-remote` (`remote_not_allowed`), computes the file SHA-256 and `confirmCode`, runs, prints the summary JSON; on a dry run prints `Dry run OK. To restore for real: pnpm backup:restore <file> --confirm <code>` (plus `--allow-remote` when used). Exit code 1 on any refusal, message only (no stack).

- [ ] **Step 1: Failing tests**: unit: `parseBackupFile` refusals (bad JSON, wrong format, count mismatch), `confirmCode` stable and differs per host/db/file, `isLocalHost`, `restoreEnv` (missing, 6543 rejected). DB (truncate **all** public tables except none — use a helper listing `information_schema.tables`; re-seed with `resetAndSeed` in `afterEach`/`afterAll` so later test files keep working): seed fixture + a bot log via `executeActions`, an inbox row `pending`, an open pending action, a usage row, a class log with jsonb moves and text[] heavy_groups → `buildBackup` → truncate all → `restoreBackup(dryRun: true)` leaves every table empty and returns the code → `restoreBackup(dryRun: false, confirm: code)` → `buildBackup` again equals the first backup's `tables` except: `chat_lease` empty, normalised inbox/pending rows, and `user_state` (compare after refresh, or exclude it); next insert into `log_groups` gets `max(id) + 1`; `executeActions` with the restored ledger's `source_key` writes nothing and returns the stored results; refusals: non-empty target (`target_not_empty`, also when only plan tables have rows), wrong confirm (`confirm_mismatch`), schema version mismatch (mutate `file.schema.migration_count`), extra table in file (`schema_mismatch`).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**, plus the SETUP.md section.
- [ ] **Step 4: Run** `pnpm lint && pnpm typecheck && pnpm test && pnpm test:db` → PASS. Then a manual rehearsal against the local `gymbot` DB (not `gymbot_test`): `pnpm db:up`, migrate it (`MIGRATION_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54329/gymbot pnpm db:migrate` only if that DB is empty/unused), export a backup from the test fixture or skip if no file; at minimum run the script with a bad path and with `--dry-run` on a file produced by a test helper and paste the output in the report.
- [ ] **Step 5: Commit** `M9: restore from a backup file (dry run, refusal rules)`.

### Task 8 (orchestrator): docs and demo

- Update `CLAUDE.md` (new section "Hardening (M9)": `src/backup/`, `src/failures/`, counted-token formula, `/export`, `/usage`, weekly job, restore rules, `RESTORE_DATABASE_URL`), `docs/STATUS.md` (milestone row, what happened, open items: re-run `pnpm telegram:setup`, first Sunday backup 25 Oct, Known minor issues left), demo script in STATUS.
