# M9 Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Weekly + on-demand table-generic backup (JSON + CSV zip) to Telegram and disk, a refusal-guarded restore script, specific failure messages in chat, and cost-guard fixes.

**Architecture:** New `src/failures/` (pure error → message), new `src/backup/` (catalog-driven export, CSV, zip, restore), an async-local invocation deadline in `src/runtime/`, small edits to the AI budget, the logging flow, the inbox runtime and the jobs list. Postgres renders and parses rows as JSON (`to_jsonb` / `jsonb_populate_recordset`), so no per-type mapping lives in JS.

**Tech Stack:** TypeScript strict, Drizzle (`getTableConfig`, `is`, `PgTable`), postgres-js, grammY (`InputFile`), Luxon, Vitest, `node:zlib`, `node:async_hooks`.

**Spec:** `docs/superpowers/specs/2026-10-18-m9-hardening-design.md` (read the sections your task names). Revised 18 Oct after the independent design answers (`docs/superpowers/specs/2026-10-18-m9-design-qa.md`); Task 1 was built before the revision and stays as built.

## Global Constraints

- No migration. No new runtime dependency.
- Session pooler rule: never `Promise.all` DB queries; one query at a time.
- Logs and stored errors never contain message text, SQL parameters, row contents, file URLs, response bodies, or secrets. Drizzle wraps driver errors in `DrizzleQueryError` whose `message` contains the SQL and params: never log or store `.message` of a DB error; use `name`, `code`, `status` only (use `classify`/`describeFailure` from `src/failures/`).
- Every number shown to the user is formatted in code.
- Do not change `runDueJobs`, `claim`, `markDone` in `src/jobs/runner.ts`. Job registration stays additive (`JOBS` array).
- Plain, short English in chat texts (user is not a native speaker). Copy quoted in the spec is fixed; use it verbatim.
- DB tests use this worktree's own database (the Postgres container is shared with two other branches): `TEST_DATABASE_URL=postgres://postgres:postgres@localhost:54329/gymbot_m9_test pnpm test:db` (the DB exists; `pnpm db:up` if the container is down). Never run `pnpm test:db` without that variable.
- Every task ends with `pnpm lint && pnpm typecheck && pnpm test` green, plus the db command above when the task touches DB code. Commit as `filippo-lt <filippo.tosetto@leadtech.com>` (`git commit --author="filippo-lt <filippo.tosetto@leadtech.com>"`), concise message, **no AI attribution or Co-Authored-By lines**. Commit only your task's files.
- Match the surrounding code: comment density, naming, idiom (`.js` import suffixes, Biome formatting).

## Review Focus

- A DB error whose message contains user text reaching `inbox.error` or `console.error` → only kind + name/code. (Task 4 test.)
- A backup with zero rows in some tables, `null` columns, jsonb `null` vs SQL `NULL`, text arrays, enums, timestamptz, numeric → round trip identical, sha256 matches. (Task 7 round-trip test.)
- A restore started against a DB that only has migrations + plan seed data → refused as not empty. (Task 7 test.)
- A voice note queued behind a slow text in the same invocation → waits for the next webhook/tick, never killed at 90 s; the first row of an invocation always runs. (Task 4 test.)
- A new `pending_actions` row after a restore gets an id above every restored id, so it can't hit an old `p:<id>` ledger key. (Task 7 test.)

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


**Status:** built and reviewed (commits 21639e4, dd2f1a2). After review, `classify` maps `APIUserAbortError` and `TimeoutError`/`AbortError` names to `ai_timeout`, and `detail` comes from the deepest unwrapped error. Task 4 narrows the name-only timeout rule (see there).

### Task 2: Cost guard — weighted tokens, which cap, `/usage`

Spec: §3.1–3.4.

**Files:**
- Modify: `src/ai/constants.ts` (`CACHE_WRITE_WEIGHT = 1.25`, `CACHE_READ_WEIGHT = 0.1`), `src/ai/budget.ts`, `src/logging/usage.ts`, `src/logging/types.ts` (`UsageStore`, `IntentResult`), `src/ai/loop.ts`, `src/bot/logging-flow.ts` (budget replies + `usageCommand`), `src/bot/log-format.ts` (texts, `HELP_TEXT`), `src/bot/bot.ts` (`/usage`), `scripts/telegram-setup.ts` (`{ command: "usage", description: "AI and voice usage" }`)
- Create: `src/bot/usage-format.ts`
- Test: `test/ai/budget.test.ts` (new), `test/ai/loop.test.ts`, `test/bot/usage-format.test.ts` (new), `test/db/usage.test.ts` (new), existing bot tests as needed

**Interfaces:**
- Produces:
  - `budget.ts`: `export function countedTokens(u: Pick<TokenUsage, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">): number` = `input + output + CACHE_WRITE_WEIGHT × cacheWrite + CACHE_READ_WEIGHT × cacheRead` (not rounded; display rounds); `export type BudgetCap = "day" | "month"`; `overTokenBudget(...)` returns `Promise<BudgetCap | null>` (day checked first).
  - `UsageStore.totals` sums the same formula in SQL (weights interpolated from the constants, not retyped); new `UsageStore.weekTotals(now): Promise<{ tokens: number; sttSeconds: number }>` for the Rome Mon–Sun week containing `now` (used by Task 6).
  - `IntentResult` budget variant: `{ kind: "budget_reached"; cap: BudgetCap }`.
  - `log-format.ts`: `export function budgetReachedText(cap: BudgetCap, capTokens: number, now: Date): string`, `export function voiceBudgetText(usedSeconds: number, capSeconds: number): string`. Remove `BUDGET_REACHED` and `VOICE_BUDGET` once unused.
  - `usage-format.ts`: `export function formatUsage(u: { date: string; dayTokens: number; monthTokens: number; sttSecondsToday: number; caps: { day: number | null; month: number | null; sttSeconds: number | null } }): string`.
  - `Flow.usageCommand(ctx: Context): Promise<void>`.

Texts (spec §3.3, verbatim; thousands separators `en-US`):
- day: `AI daily budget reached (200,000 tokens). Resets at midnight (Rome). Commands still work.`
- month: `AI monthly budget reached (3,000,000 tokens). Resets on 1 Nov. Commands still work.` (first day of the next Rome month, Luxon `d LLL`, English)
- voice: `Voice budget reached (30 of 30 min today). Resets at midnight (Rome). Typing still works.` (used minutes `Math.min(capMin, Math.round(used / 60))`, cap minutes `Math.round(cap / 60)`)

`/usage` layout (tokens rounded to integers, thousands separators, % rounded down):
```
Usage on 19 Oct:
AI today: 12,345 of 200,000 tokens (6%)
AI this month: 123,456 of 3,000,000 tokens (4%)
Voice today: 4 of 30 min
```
A missing cap (AI or STT env not configured) drops the "of …" part: `AI today: 12,345 tokens`, `Voice today: 4 min`. Reading caps never throws out of the command. Add `/usage` to `HELP_TEXT`.

- [ ] **Step 1: Failing tests**: `countedTokens({ inputTokens: 100, outputTokens: 50, cacheWriteTokens: 20, cacheReadTokens: 1000 })` = 275; `overTokenBudget` returns "day" / "month" / null with a fake store; loop test "budget_reached carries the cap"; `budgetReachedText("month", 3_000_000, new Date("2026-12-31T22:30:00Z"))` (23:30 Rome on 31 Dec) contains "Resets on 1 Jan."; `budgetReachedText("month", 3_000_000, new Date("2026-10-18T10:00:00Z"))` equals the month text above; day text exact; voice text never shows used > cap; `formatUsage` with and without caps; db test: usage rows with cache tokens → `totals` and `weekTotals` equal the sums of `countedTokens` (and Sunday 23:59 Rome is in the same week as Monday 00:00); flow/bot test: `/usage` replies with the layout.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** `logging-flow.ts` passes `result.cap` and the cap value to `budgetReachedText`; the photo pre-check uses the returned cap; voice uses `voiceBudgetText`.
- [ ] **Step 4: Run** the full checks + db command → PASS.
- [ ] **Step 5: Commit** `M9: cost guard counts weighted cache tokens, names the cap, /usage`.

### Task 3: Specific failure messages in text, voice and photo; smaller photo size

Spec: §4 "Where they're used" (text/voice/photo, photo size).

**Files:**
- Modify: `src/bot/logging-flow.ts` (`handleInput` catch, `voice`, `photo`), `src/bot/log-format.ts` (drop `VOICE_FAILED`/`PHOTO_FAILED` if unused)
- Test: `test/db/bot-voice.test.ts`, `test/db/bot-photo.test.ts`, and the db flow test that drives the text path with a fake model

**Interfaces:**
- Consumes (Task 1): `classify(error, step)`, `failureText(f, input, provider?)`, `providerLabel(sttName)`, `describeFailure(f)` from `src/failures/`.
- Produces: `export function pickPhoto(sizes: { file_id: string; file_size?: number }[], maxBytes: number): { file_id: string } | null` (in `logging-flow.ts` or a small helper module, builder's call) — the largest size whose `file_size` ≤ `maxBytes`; a size with unknown `file_size` counts only when it is the smallest (Telegram lists sizes small → large); null when none fits.

Behaviour:
- `handleInput` catch → `failureText(classify(error, "ai"), source)`, prefixed by the heard line for voice; log `console.error("ai: intent failed", describeFailure(f))`.
- `voice`: separate `try` for the download (`classify(e, "download")`) and for `transcribe` (`classify(e, "stt")`); provider via `providerLabel(sttConfig.stt.name)`.
- `photo`: `pickPhoto(sizes, PHOTO_MAX_BYTES)`; null → the too-large text (`failureText({ kind: "file_too_large", detail: "photo" }, "photo")`) and return; else download in its own `try` (`"download"`, so a `FileTooLargeError` still gives the too-large text) and `readBoard` in its own `try` (`"vision"`). Store the picked size's `file_id` as `photoFileId`.
- Usage recording and the order of the existing checks stay as they are.

- [ ] **Step 1: Failing tests**: `pickPhoto` unit cases (all fit → largest; largest too big → next; none fit → null; missing sizes); photo whose sizes are all > 3.5 MB → too-large text, no download; photo whose largest size is too big → the smaller one is downloaded and saved; photo download throws `new FileTooLargeError(...)` → too-large text; `readBoard` throws an Anthropic `APIError` 529 → "I couldn't read the photo: …" text; voice transcribe throws `new SttError(429, "groq")` → the rate-limit text naming Groq; voice download throws a plain `Error` → download text; text path model throws `AiTimeoutError` → "Claude took too long. Please try again. Commands still work."; a `console.error` spy sees no message text.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** full checks + db command → PASS.
- [ ] **Step 5: Commit** `M9: specific failure messages for AI, STT, vision and downloads`.

### Task 4: Invocation deadline, inbox notices, inbox retention

Spec: §3.5, §4 (inbox first/final failure, the timeout rule), §1 "Inbox retention".

**Files:**
- Create: `src/runtime/deadline.ts`, `src/runtime/row-budget.ts`
- Modify: `src/failures/classify.ts` (name-only timeout rule), `src/failures/messages.ts` (`retryingText`), `src/runtime/process-chat.ts`, `src/runtime/inbox.ts` (`purgeOldRows`), `src/runtime/telegram-runtime.ts` (`notifyFailed`, `notifyRetrying`; `DOWNLOAD_TIMEOUT_MS` moves to `src/telegram/files.ts`, exported), `src/bot/logging-flow.ts` (clamp the AI loop budget, STT, vision and download timeouts to `timeLeftMs()`), `src/ai/loop.ts` only if `budgetMs` plumbing needs it (it already accepts `budgetMs`), `api/telegram.ts`, `api/cron/tick.ts` (pass `startedAt`; purge after jobs)
- Test: `test/runtime/deadline.test.ts`, `test/runtime/row-budget.test.ts`, `test/failures/classify.test.ts`, `test/failures/messages.test.ts`, `test/db/runtime.test.ts`

**Interfaces:**
- Consumes (Task 1): `classify`, `describeFailure`, `retryingText`, `failedText`, `Failure`.
- Produces:
  - `deadline.ts`: `export function runWithDeadline<T>(endMs: number, fn: () => Promise<T>): Promise<T>` (AsyncLocalStorage); `export function timeLeftMs(now?: number): number` (`Infinity` outside a deadline); `export function clampTimeout(ms: number, marginMs = 5_000): number` = `Math.max(1_000, Math.min(ms, timeLeftMs() - marginMs))`.
  - `row-budget.ts`: `export type InputKind = "voice" | "photo" | "text" | "other"`; `export function inputKind(payload: unknown): InputKind` (`message.voice` → voice, `message.photo` → photo, `message.text` not starting with "/" → text, else other); `export const MIN_TIME_LEFT_MS: Record<InputKind, number> = { voice: 75_000, photo: 60_000, text: 45_000, other: 45_000 }`; `export function hardEndMs(startedAt: number): number` = `startedAt + (MAX_DURATION_S - 5) * 1000`.
  - `ProcessChatDeps`: add `startedAt?: number` (default `now()` at `processChat` start), `notifyRetrying: (chatId: number, failure: Failure) => Promise<void>`; `notifyFailed` becomes `(chatId: number, payload: unknown, failure: Failure) => Promise<void>`.
  - `inbox.ts`: `export async function purgeOldRows(db: Db, now: Date, days = 30): Promise<number>` — deletes `done`/`failed` rows with `received_at` older than `days`.

Behaviour:
- `classify`: a bare `TimeoutError`/`AbortError` name is `ai_timeout` only for steps `ai` and `vision`; for `other` and no step it falls through (to `db` if it matches the DB rules, else `unknown`). SDK classes keep their mapping everywhere. Update the Task 1 test that asserted the old behaviour for "other".
- `retryingText(f)` = `⚠️ Something went wrong (${reasonPhrase(f)}) while handling your last message. I'll retry automatically, so don't send it again.`
- `processChat`: before claiming a row, if at least one row was already handled in this invocation and `hardEndMs(startedAt) - now() < MIN_TIME_LEFT_MS[inputKind(row.payload)]` → `stoppedReason = "deadline"`, return (row stays pending, attempts untouched). The first row always runs. `deps.handle(payload)` runs inside `runWithDeadline(hardEndMs(startedAt), …)`.
- Handler error: `f = classify(error, "other")`; `markRetryOrFailed(..., describeFailure(f))`; status `pending` and `claimed.attempts === 1` → `notifyRetrying` (best effort); `failed` → `notifyFailed(chatId, payload, f)`. Rows failed by `resetStuck` → `notifyFailed(..., { kind: "row_timeout", detail: "lease expired" })`.
- Flows: the AI loop gets `budgetMs: clampTimeout(AI_BUDGET_MS)`; STT `AbortSignal.timeout(clampTimeout(STT_TIMEOUT_MS))`; vision `clampTimeout(BOARD_TIMEOUT_MS)`; download (`telegram-runtime.ts`) `clampTimeout(DOWNLOAD_TIMEOUT_MS)`.
- Tick: after the jobs, `purgeOldRows(db, new Date())` in its own try/catch (a failure is logged by name only and never blocks the sweep).

- [ ] **Step 1: Failing tests**: `runWithDeadline`/`timeLeftMs`/`clampTimeout` (outside → unchanged; inside with 20 s left → 15 s; floor 1 s; nested async code sees the deadline); `inputKind` for voice/photo/text/command/callback payloads; db: two rows (text, then voice) where the first handler advances a fake clock to 15 s → the voice row stays `pending`, `stoppedReason: "deadline"`, attempts 0; a voice row first in the invocation at elapsed 12 s still runs; handler throws a DrizzleQueryError-like error carrying "secret text" → `inbox.error` starts with "db" and lacks "secret text"; `notifyRetrying` once on attempt 1, not on attempt 2; third failure → `notifyFailed` with kind `db`; stuck row → `notifyFailed` with `row_timeout`; `purgeOldRows` deletes a 31-day-old done row and keeps a 29-day-old one and any pending row; `classify(new DOMException("x", "TimeoutError"), "other")` → `unknown`, with step "ai" → `ai_timeout`; `retryingText` exact.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** full checks + db command → PASS.
- [ ] **Step 5: Commit** `M9: invocation deadline, inbox failure notices, inbox retention`.

### Task 5: Backup core — catalog tables, export, CSV, zip

Spec: §1 (which tables, reading rows, JSON file, gzip and size, CSV, coverage tests 1–2).

**Files:**
- Create: `src/backup/catalog.ts`, `src/backup/export.ts`, `src/backup/csv.ts`, `src/backup/zip.ts`
- Test: `test/backup/csv.test.ts`, `test/backup/zip.test.ts`, `test/backup/order.test.ts`, `test/db/backup-export.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // catalog.ts
  export const EXCLUDED_TABLES = ["chat_lease", "inbox"] as const;
  export interface CatalogTable { name: string; columns: string[]; primaryKey: string[]; dependsOn: string[]; sequences: { column: string; sequence: string }[] }
  export async function readCatalog(db: Db): Promise<CatalogTable[]>; // public base tables, sorted by name; columns in ordinal order; dependsOn from pg_constraint FKs (self-refs dropped)
  export function restoreOrder(tables: CatalogTable[]): CatalogTable[]; // parents first; throws on a cycle
  export async function readMigrations(db: Db): Promise<string[]>; // drizzle.__drizzle_migrations hash by id
  // export.ts
  export interface ManifestEntry { rows: number; sha256: string }
  export interface BackupMeta { format: "gymbot-backup"; version: 1; created_at: string; migrations: string[]; excluded: string[]; manifest: Record<string, ManifestEntry> }
  export interface BuiltBackup { meta: BackupMeta; tables: CatalogTable[]; tableJson: Record<string, string> /* Postgres text, opaque */; json: string /* the whole file */ }
  export async function buildBackup(db: Db, now: Date): Promise<BuiltBackup>;
  export interface BackupFiles { json: { name: string; data: Uint8Array }; zip: { name: string; data: Uint8Array } }
  export const GZIP_OVER_BYTES = 10 * 1024 * 1024;
  export const TELEGRAM_MAX_BYTES = 45 * 1024 * 1024;
  export function backupFiles(b: BuiltBackup, now: Date, opts: { allowGzip: boolean }): BackupFiles; // names gymbot-backup-YYYY-MM-DD.json(.gz) / -csv.zip, Rome date; gzip only when allowGzip and json > GZIP_OVER_BYTES
  // csv.ts
  export function toCsv(columns: string[], rows: Record<string, unknown>[]): string; // BOM + header + CRLF rows
  // zip.ts
  export function zip(files: { name: string; data: Uint8Array }[]): Uint8Array;
  ```
- `Db` is the type the jobs/import code already uses.

Notes:
- Per table, one query: rows text = `coalesce(jsonb_agg(to_jsonb(t) order by <pk or all columns>), '[]'::jsonb)`, plus `count(*)` and `encode(sha256(convert_to(<that jsonb>::text, 'UTF8')), 'hex')` in the same statement. Identifiers quoted. Tables in `EXCLUDED_TABLES` are skipped.
- `json` is assembled as text: `{"format":…, …, "tables":{"<name>":<tableJson>,…}}` with `JSON.stringify` for the meta part only. The CSV is built from `JSON.parse(tableJson[name])` (parsing for CSV is fine; the JSON file stays opaque).
- CSV cell: `null`/`undefined` → empty; string as is; number/boolean `String()`; object/array → `JSON.stringify`; quote when the cell has `"`, `,`, `\r` or `\n` (double the quotes).
- Zip: local headers + central directory + end record, `zlib.crc32`, UTF-8 flag (bit 11); store or deflate.

- [ ] **Step 1: Failing tests**: `toCsv` (quote, comma, newline, null, array, object, BOM first char, header order); zip: write to a temp dir, `execFileSync("unzip", ["-p", file, "a.csv"])` returns the input for each of two entries; `restoreOrder` on hand-made tables (parents first, self-ref ignored, cycle throws); db **coverage**: `readCatalog` names == Drizzle `getTableConfig` names of every `PgTable` exported from `src/db/schema/index.ts`; every catalog name is in `buildBackup(...).meta.manifest` or `EXCLUDED_TABLES`, and every excluded name exists in the catalog; `manifest[t].rows` equals the parsed array length; `JSON.parse(json)` has `format: "gymbot-backup"` and a timestamptz as an ISO string, a `text[]` as an array, jsonb as an object; `readCatalog` gives `log_entries.dependsOn` containing `log_groups` and a sequence for `log_groups.id`; `backupFiles` names for `2026-10-18T22:30:00Z` use `2026-10-19`; with a fake 11 MB json and `allowGzip` → `.json.gz` that gunzips to the input; without → `.json`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** full checks + db command → PASS.
- [ ] **Step 5: Commit** `M9: catalog-driven backup export with CSV zip`.

### Task 6: Backup delivery — summary, `/export`, Sunday job, `pnpm backup`

Spec: §1 (summary message, `/export`, `pnpm backup`, Sunday job, JobContext, size).

**Files:**
- Create: `src/backup/send.ts`, `src/backup/summary.ts`, `src/jobs/weekly-backup.ts`, `src/bot/export-command.ts`, `scripts/backup.ts`
- Modify: `src/jobs/runner.ts` (`JobContext` only), `src/jobs/index.ts` (append), `api/cron/tick.ts`, `src/runtime/telegram-runtime.ts` (`sendFileToOwner`), `src/bot/bot.ts` (`/export`), `src/bot/log-format.ts` (`HELP_TEXT`), `scripts/telegram-setup.ts` (`{ command: "export", description: "Backup of all data" }`), `package.json` (`"backup": "tsx scripts/backup.ts"`), `.gitignore` (`backups/`)
- Test: `test/backup/summary.test.ts`, `test/db/backup-send.test.ts`, a bot test for `/export`, `test/db/jobs.test.ts` (ctx gains `sendFile`)

**Interfaces:**
- Consumes: Task 5 (`buildBackup`, `backupFiles`, `TELEGRAM_MAX_BYTES`), Task 2 (`createUsageStore(db).weekTotals`, caps via the AI/STT env readers, both optional), Task 1 (`classify`, `reasonPhrase`, `describeFailure`).
- Produces:
  - `JobContext.sendFile(file: { kind: "document" | "photo"; name: string; data: Uint8Array; caption?: string }): Promise<void>` (required member). `export type SendFile = JobContext["sendFile"]`.
  - `send.ts`: `export class BackupTooLargeError extends Error { constructor(readonly bytes: number) }`; `export async function sendBackup(args: { db: Db; now: Date; send: (m: Message) => Promise<void>; sendFile: SendFile; weekly: { tokens: number; sttSeconds: number; caps: { tokens: number | null; sttSeconds: number | null } } | null }): Promise<void>` — build, files with `allowGzip: true`, refuse when a file is over `TELEGRAM_MAX_BYTES` (throw `BackupTooLargeError` before sending anything), else send the summary text, then the JSON document, then the zip document.
  - `summary.ts`: `export function backupSummary(meta: BackupMeta, now: Date, weekly: … | null): string`.
  - `weekly-backup.ts`: `export const weeklyBackupJob: Job` (name `"weekly_backup"`, window Sunday 18:00 ≤ Rome < 23:00, date = that Sunday); `export function isLastChance(now: Date): boolean` (Rome time ≥ 22:30).
  - `export-command.ts`: `export function createExportCommand(deps: { db: Db; now: () => Date }): (ctx: Context) => Promise<void>`.
  - `telegram-runtime.ts`: `export async function sendFileToOwner(file): Promise<void>` (grammY `InputFile`, `sendDocument` or `sendPhoto` by kind, caption if given).

Summary text (HTML-safe; numbers formatted in code):
```
Backup of 25 Oct 2026, 19:00 (Rome).
Rows: log_groups 123, log_entries 456, class_logs 4, … (every backed-up table, non-zero first, then the zero ones)
This week: 45,678 of 200,000 tokens/day cap · 12 of 30 min/day voice cap.   ← weekly only; drop the "of …" parts when a cap is unknown
Keep these files: they are your only restore point.
```
Builder's call on the exact "This week" wording, as long as it shows the week's tokens and voice minutes and the caps they are measured against.

Behaviour:
- `/export`: reply "Preparing your backup…", then `sendBackup` (weekly null) with `ctx.reply` / `ctx.replyWithDocument`. Errors: `BackupTooLargeError` → `Backup too large for Telegram (<n> MB). Run pnpm backup locally (no size limit).`; others → `Backup failed (${reasonPhrase(classify(e, "other"))}). Please try again.`; never rethrow; log with `describeFailure`.
- Job: `sendBackup` with the week's usage; on error, if `isLastChance(ctx.now)` send `Weekly backup failed (<reason>). Use /export or pnpm backup.` (ignore its own error), then rethrow so the runner leaves the row claimed.
- `scripts/backup.ts`: `buildBackup` against `DATABASE_URL`, `backupFiles(..., { allowGzip: false })`, write both into `backups/`, print paths and sizes; read-only.
- Add `/export` to `HELP_TEXT`.

- [ ] **Step 1: Failing tests**: summary with and without the weekly line, zero tables last; job window Sun 2026-10-25 17:59 Rome → null, 18:00 → `2026-10-25`, 22:59 → yes, 23:00 → null, Sat 18:00 → null; `isLastChance` 22:29 false / 22:30 true; job run sends one text then documents `gymbot-backup-2026-10-25.json` and `gymbot-backup-2026-10-25-csv.zip` (JSON parses with `format: "gymbot-backup"`); failing `sendFile` at 19:00 → no failure text, outcome `failed`; at 22:45 → the failure text, outcome `failed`; `BackupTooLargeError` path sends nothing but the error (fake a builder or a tiny `TELEGRAM_MAX_BYTES` seam, builder's call); `/export` → "Preparing your backup…", summary, 2 documents (capture `sendDocument` in the grammY transformer used by bot tests); class-question job tests pass with the new ctx member.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** full checks + db command; also run `DATABASE_URL=postgres://postgres:postgres@localhost:54329/gymbot_m9_test pnpm backup` and paste the output in the report (files under `backups/` stay untracked).
- [ ] **Step 5: Commit** `M9: /export, Sunday backup job and pnpm backup`.

### Task 7: Restore script

Spec: §2 (all of it), coverage test 3 in §1.

**Files:**
- Create: `src/backup/restore.ts`, `scripts/backup-restore.ts`
- Modify: `src/config/env.ts` (`restoreEnv()`), `package.json` (`"backup:restore": "tsx scripts/backup-restore.ts"`), `docs/SETUP.md` (section "Restore from a backup"), `.env.example` if present (`RESTORE_DATABASE_URL=` with a comment)
- Test: `test/db/backup-restore.test.ts`, `test/backup/restore-file.test.ts`, `test/config/env.test.ts`

**Interfaces:**
- Consumes: Task 5 (`readCatalog`, `restoreOrder`, `readMigrations`, `buildBackup`, `EXCLUDED_TABLES`, `BackupMeta`), `refreshUserState` from `src/progression/store.ts` (check its signature).
- Produces:
  ```ts
  export type RestoreRefusal = "not_backup" | "manifest_mismatch" | "target_not_empty" | "schema_mismatch" | "remote_not_allowed";
  export class RestoreRefusedError extends Error { constructor(readonly reason: RestoreRefusal, message: string) }
  export interface BackupInput { meta: BackupMeta; tables: Record<string, unknown[]> }
  export function parseBackupFile(bytes: Uint8Array, fileName: string): BackupInput; // gunzips *.gz; not_backup on bad JSON/gzip/format/version; manifest_mismatch on a row-count difference
  export function isLocalHost(host: string): boolean;   // localhost, 127.0.0.1, ::1
  export interface RestoreSummary { dryRun: boolean; backupCreatedAt: string; backupAgeHours: number; inserted: Record<string, number> }
  export async function restoreBackup(db: Db, input: BackupInput, opts: { dryRun: boolean; now: Date }): Promise<RestoreSummary>;
  ```
  - `restoreEnv()`: `{ RESTORE_DATABASE_URL: string }`, required, no fallback, same 6543 refusal as `DATABASE_URL` (reuse the validator).

Behaviour (spec §2, refusals before any write):
1. `parseBackupFile` as above.
2. `restoreBackup`, one transaction: `readMigrations` ≠ `meta.migrations` → `schema_mismatch`; table sets differ (backup tables vs catalog minus excluded) or a file row has a key that isn't a column of the target table → `schema_mismatch`; any catalog table has a row → `target_not_empty`; per table, `sha256` of `jsonb` built from the parsed rows (`encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex')`) ≠ manifest → `manifest_mismatch`.
3. Insert in `restoreOrder`, chunks of ≤ 500 rows: `insert into <t> select * from jsonb_populate_recordset(null::<t>, $1::jsonb)`.
4. `setval` each catalog sequence to `max(column)` (`setval(seq, 1, false)` when empty).
5. Re-check row counts per table against the manifest.
6. `refreshUserState` inside the transaction.
7. Dry run: throw a rollback marker, return the summary with `dryRun: true`.
- Script: `pnpm backup:restore <file> [--dry-run] [--allow-remote]`; reads `restoreEnv()`; prints `target: <host>/<database>` (no credentials), backup date, age and per-table rows; refuses a non-local host without `--allow-remote` (`remote_not_allowed`); runs; prints the summary JSON; on a dry run prints `Dry run OK (rolled back). Run again without --dry-run to restore.`; exit code 1 on any refusal with the message only.

- [ ] **Step 1: Failing tests**: unit: `parseBackupFile` refusals (bad JSON, bad gzip, wrong format, wrong version, row-count mismatch) and a `.gz` round trip; `isLocalHost`; `restoreEnv` (missing, 6543 rejected). DB (helper truncates **every** catalog table; `afterAll` re-seeds with the existing fixture so later files keep working): seed the fixture plus a bot log via `executeActions` (so `write_ledger` has a `u:` row), a pending action with a `p:` ledger row, a usage row, a class log with jsonb moves and text[] heavy groups, a jsonb `null` value and SQL `NULL`s → `buildBackup` → truncate all → `restoreBackup(dryRun: true)` leaves every table empty → `restoreBackup(dryRun: false)` → `buildBackup` again: every table's sha256 equals the first backup's except `user_state` (compare after refresh, or check it separately) → a new `pending_actions` insert gets an id > every restored id, same for `log_groups`; `executeActions` with a restored ledger `source_key` writes nothing and returns the stored result; refusals: target with only plan tables seeded → `target_not_empty`; `meta.migrations` changed → `schema_mismatch`; an extra table in the file → `schema_mismatch`; one row edited in the file (count unchanged) → `manifest_mismatch`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**, plus the SETUP.md section (spec §2 disaster procedure, plus the local rehearsal: migrate the local `gymbot` DB if it is empty, `pnpm backup`, then `RESTORE_DATABASE_URL=…/gymbot pnpm backup:restore <file> --dry-run`).
- [ ] **Step 4: Run** full checks + db command; then a script smoke run against `gymbot_m9_test` with a file from `pnpm backup` (dry run expected to refuse `target_not_empty` because the source DB is that same DB) and paste the output.
- [ ] **Step 5: Commit** `M9: restore from a backup file (dry run, refusal rules)`.

### Task 8 (orchestrator): docs and demo

- Update `CLAUDE.md` (section "Hardening (M9)": `src/backup/`, `src/failures/`, `src/runtime/deadline.ts`, weighted tokens, `/export`, `/usage`, weekly job, restore rules, `RESTORE_DATABASE_URL`, `pnpm backup`, the `sendFile` job member, inbox retention), `docs/STATUS.md` (milestone row, what happened, open items: re-run `pnpm telegram:setup`, first Sunday backup 25 Oct, the Known minor issues left), and a Telegram demo script in STATUS.
