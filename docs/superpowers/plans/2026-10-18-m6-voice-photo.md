# M6 Voice, Photo, Thursday Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Voice notes and blackboard photos become first-class inputs, and the bot asks about Thursday's class at 21:00 through a generic scheduled-job runner.

**Architecture:** Voice → Telegram `getFile` → STT provider (behind an interface) → the existing text intent pipeline, with a `voice_input` policy reason forcing a confirm card. Photo → Claude vision with a forced `record_board` tool → a `log_class` pending action with parsed moves → a class card (unticked toggles + Save). `job_runs` + `runDueJobs` inside `/api/cron/tick` send the Thursday question.

**Tech Stack:** TypeScript, grammY, Drizzle + postgres-js, Anthropic SDK, `fetch` + `FormData` for Groq/OpenAI (no new dependency), Luxon, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-18-m6-voice-photo-design.md` (read it with SPEC.md §2, §3, §5.3, §5.4, §5.6d).

## Global Constraints

- Anything with a number is computed and formatted in code; the model never writes a number the user sees (SPEC §3).
- Session pooler: no concurrent queries on one connection — no `Promise.all` of DB calls.
- `aiEnv()` and `sttEnv()` are read lazily; commands work without either key.
- Every new table: `.enableRLS()`, exported from `src/db/schema/index.ts`, then `pnpm db:generate`. Never run `pnpm db:migrate` against production — the user does that after OK.
- Callback data ≤ 64 bytes.
- Never log a Telegram file URL (it contains the bot token) or API keys.
- Replies: short, simple English (SPEC 5.8). Telegram HTML; escape with `esc`.
- Commits: author `filippo-lt <filippo.tosetto@leadtech.com>`, concise message, **no** `Co-Authored-By` or any AI mention. Branch: `dev`.
- Each task ends green on `pnpm lint && pnpm typecheck && pnpm test` and, when it touches DB code, `pnpm test:db` (needs `pnpm db:up`).

## Review Focus

1. A voice note with background noise transcribes to `""` or `"."` → friendly "I couldn't hear that" reply, no model call, inbox row done. (Task 5 test `voice: blank transcript`.)
2. A voice note or photo redelivered after its card went out (inbox retry) → no second STT/vision call and no second card. (Task 5 `voice: retry after card`, Task 6 `photo: retry after card`.)
3. ✅/Save tapped on a class card after another request replaced it, or after 30 min → "this expired, nothing saved", no `class_logs` write. (Task 3 `class card: replaced or expired`.)
4. Clarify tap on a pending created from voice resolves to a single clear log → still a confirm card, never a direct write. (Task 2 `voice origin survives clarify`.)
5. Tick at 21:05 Thursday when the 21:00 run claimed and crashed 3 min ago → no second send; at 21:10 (claim 8 min old) → re-sent once. (Task 7 `stale claim`.)

---

### Task 1: Schema — `job_runs`, pending input origin

**Files:**
- Modify: `src/db/schema/runtime.ts` (add `jobRuns`), `src/db/schema/agent.ts` (pending columns), `src/db/schema/index.ts`
- Create: `drizzle/0006_*.sql` (generated)
- Test: `test/db/migrate.test.ts` (existing RLS check covers the new table; add column assertions)

**Interfaces:**
- Produces:
  - `jobStatus` pg enum `job_status` = `["claimed", "done"]`; `jobRuns` table `job_runs (id serial pk, job text not null, date date(string) not null, status job_status not null default 'claimed', claimed_at timestamptz not null default now(), done_at timestamptz null)`, unique index on `(job, date)`.
  - `pendingActions.inputSource`: `text("input_source").notNull().default("text")` with check `IN ('text','voice','photo')`; `pendingActions.transcript`: `text("transcript")` nullable.
  - Type `InputSource = "text" | "voice" | "photo"` exported from `src/logging/types.ts`.

- [ ] **Step 1:** Add to `test/db/migrate.test.ts`: `it("has job_runs with a unique (job, date)")` — insert `('class_question','2026-10-22')` twice, expect the second to throw a unique violation; `it("pending_actions defaults input_source to text")` — insert a minimal pending row, expect `input_source = 'text'`, `transcript is null`.
- [ ] **Step 2:** Run `pnpm test:db -- test/db/migrate.test.ts` → FAIL (relation/column missing).
- [ ] **Step 3:** Add the schema, run `pnpm db:generate`, check the SQL creates only these objects.
- [ ] **Step 4:** Run `pnpm test:db` → PASS (including the existing "every table has RLS" test).
- [ ] **Step 5:** Commit `M6: job_runs table and pending input origin`.

---

### Task 2: Voice policy, card heard line, log source

**Files:**
- Modify: `src/logging/types.ts` (`ConfirmReason`, `PolicyContext`), `src/logging/policy.ts`, `src/logging/pending.ts` (`createPending`), `src/logging/execute.ts` (`executeActions` opts, `log_groups.source`), `src/bot/log-format.ts` (`confirmCard`, `reasonPhrases`), `src/bot/logging-flow.ts` (`renderPending`, clarify path at the two `decidePolicy(pending.actions…)` call sites ~L423, ~L1046, ~L1114; ✅ path passes source)
- Test: `test/logging/policy.test.ts` (create if absent, else extend), `test/bot/log-format.test.ts`, `test/db/logging-flow.test.ts`

**Interfaces:**
- Consumes: `InputSource`, pending columns (Task 1).
- Produces:
  - `ConfirmReason` gains `"voice_input"` and `"class_moves"`.
  - `PolicyContext` gains `voiceInput?: boolean`. `decidePolicy`: clarify still wins; otherwise when `voiceInput && actions.length > 0` push `"voice_input"`.
  - `createPending(db, { …existing, inputSource?: InputSource, transcript?: string | null })` (defaults `"text"`, `null`).
  - `executeActions(db, key, actions, { …existing, source?: InputSource })`: `log_groups.source` = `"voice"` when `source === "voice"`, `"photo"` when `"photo"`, else `"text"` (today's hardcoded value at execute.ts ~L245).
  - `confirmCard({ …existing, heard?: string | null })`: when set, first line `🎤 heard: <esc(heard, truncated to 300 chars with "…")>` then a blank line, before "Replaces:"/"Save this?".
  - `reasonPhrases`: `voice_input` → `"from a voice note"`.
  - Every place that rebuilds a card or re-decides policy from a stored pending passes `voiceInput: pending.inputSource === "voice"` and `heard: pending.transcript`; the ✅ path passes `source: pending.inputSource` to `executeActions`.

- [ ] **Step 1:** Tests:
  - `policy: voice turns a clear log into confirm` — `decidePolicy([clearLog], { voiceInput: true })` → `{ mode: "confirm", reasons: ["voice_input"] }`; same for one `log_readiness`, one `log_bodyweight`, one `log_class` (no moves).
  - `policy: clarify still wins over voice` → `{ mode: "clarify", index }`.
  - `confirmCard shows the heard line first` — text starts with `🎤 heard: fifteen face pulls`; a 400-char transcript is cut to 300 + `…`; `<` is escaped.
  - db `voice log saves with source voice` — `executeActions(db, "p:1", [log], { now: MON, source: "voice" })` → `select source from log_groups` = `voice`.
  - db `voice origin survives clarify` — create pending with `inputSource: "voice"` holding one `clarify_exercise`, run the flow's clarify tap (or call the clarify resolution path the existing tests use) choosing a today exercise → pending stays open with a confirm card, `log_groups` count 0.
- [ ] **Step 2:** Run `pnpm test` and `pnpm test:db` → the new tests FAIL.
- [ ] **Step 3:** Implement the interfaces above.
- [ ] **Step 4:** Run both suites → PASS.
- [ ] **Step 5:** Commit `M6: voice input policy, heard line, log source`.

---

### Task 3: Class with moves — parse shape, breakdown, class card, merge and undo

**Files:**
- Create: `src/logging/class-moves.ts` (schema + breakdown)
- Modify: `src/logging/types.ts` (`logClassInputSchema`, `StagedAction` `log_class`, `LedgerResult` `class`), `src/logging/resolve.ts` (`stageClass`), `src/logging/policy.ts` (`class_moves`), `src/logging/execute.ts` (`log_class` write, `undoWrite` for class), `src/logging/describe.ts`, `src/bot/callbacks.ts` (`cm:`), `src/bot/log-format.ts` (`classMovesCard`, `actionLine` for class with moves, class echo), `src/bot/logging-flow.ts` (`renderPending` branch, `cm` dispatch), `src/ai/tools.ts` (description)
- Test: `test/logging/class-moves.test.ts`, `test/bot/callbacks.test.ts`, `test/bot/log-format.test.ts`, `test/db/logging-execute.test.ts`, `test/db/bot-logging.test.ts`

**Interfaces:**
- Produces:
  - `src/logging/class-moves.ts`:
    - `CLASS_GROUPS = ["pull","push","legs","core","other"] as const`; `classMoveSchema = z.strictObject({ name: z.string().trim().min(1).max(60), sets: z.number().int().min(1).max(50).optional(), reps: z.number().int().min(1).max(500).optional(), duration_s: z.number().int().min(1).max(3600).optional(), groups: z.array(z.enum(CLASS_GROUPS)).min(1).max(5) })`; `type ClassMove`.
    - `classBreakdown(moves: ClassMove[]): { group: ClassGroup; moves: number; sets: number }[]` — groups in `CLASS_GROUPS` order, only groups with ≥ 1 move; a move counts once in each of its groups; `sets` sums `sets ?? 1`.
  - `logClassInputSchema` = `z.strictObject({ heavy_groups: z.array(z.enum(HEAVY_GROUP_VALUES)).max(3).optional(), moves: z.array(classMoveSchema).min(1).max(30).optional() })` refined: at least one of the two present. Executor and cards treat missing `heavy_groups` as `[]`.
  - `StagedAction` `log_class` = `{ kind: "log_class"; input: LogClassInput; date: string; photoFileId?: string; rawText?: string }`.
  - `actionReasons`: `log_class` with `input.moves` → `"class_moves"` (always a card).
  - `LedgerResult` `class` gains `previousRow?: { heavyGroups: string[]; parsed: unknown; photoFileId: string | null; rawText: string | null } | null` (keep `previousGroups` for old ledger rows).
  - Executor `log_class`: without `moves` → upsert touching only `heavy_groups` (and `source`); with `moves` → upsert setting `heavy_groups`, `parsed = { moves }`, `photo_file_id = photoFileId ?? null`, `raw_text = rawText ?? null`. Record `previousRow` (null when no row).
  - Undo of a `class` result: `previousRow === null` → delete the row; `previousRow` set → restore all four fields; legacy result without `previousRow` → today's behaviour.
  - Callbacks: `cb.classMoves(pendingId: number, mask: number)` → `cm:<id>:<mask>`; `cb.classMovesSave(pendingId, mask)` → `cm:<id>:<mask>:ok`; `CallbackAction` gains `{ t: "cm"; id: number; mask: number; save: boolean }`; mask 0–7 only.
  - `classMovesCard(args: { id: number; action: Extract<StagedAction, { kind: "log_class" }>; mask: number; heard?: string | null; replacedSummary?: string | null }): Message` — lines: optional heard line, optional "Replaces:", `Thursday class (<ccc d LLL>):`, one line per breakdown row `Legs: 3 moves, 12 sets` (1 → "1 move", "1 set"), `Which parts were heavy?`, `Selected: …` as in `classCard`; keyboard row 1 Pull/Push/Legs toggles (`cm:<id>:<mask^bit>`, ✓ when set), row 2 `Not heavy` (`cm:<id>:0`), `Save` (`cm:<id>:<mask>:ok`), `❌` (`pa:<id>:no`).
  - `renderPending`: a pending whose actions are exactly one `log_class` with `moves` renders `classMovesCard` with `mask` from its `heavy_groups`; anything else as today. Multi-action requests show the class in `confirmCard` via `actionLine` ("Thursday class: 4 moves; heavy: legs").
  - `cm` dispatch in `logging-flow.ts`: toggle → `getPending`; open and unexpired → edit card with new mask; else answer `EXPIRED`. Save → action with `input.heavy_groups = maskToGroups(mask)` → `executeActions(db, \`p:${id}\`, [action], { pendingId: id, now, source: pending.inputSource, replaceActions: [action], replaceReasons: pending.reasons })` → on `done` edit the card to the class echo with Undo (`directWriteSaved`), else `STALE`/`EXPIRED` as the ✅ path does.
- Text from a heavy-only `log_class` keeps today's direct save.

- [ ] **Step 1:** Tests:
  - `classBreakdown counts each move in each group` — moves `[{name:"Pistol", sets:5, reps:10, groups:["legs"]}, {name:"Pull-up", sets:4, reps:8, groups:["pull"]}, {name:"Burpee", groups:["legs","push"]}]` → `[{group:"pull",moves:1,sets:4},{group:"push",moves:1,sets:1},{group:"legs",moves:2,sets:6}]`.
  - `logClassInputSchema rejects an empty object`, accepts moves only, accepts heavy only.
  - `callbacks round-trip cm` — parse(`cm:123:5`) → `{t:"cm",id:123,mask:5,save:false}`, `cm:123:5:ok` save true, `cm:123:8` → null.
  - `classMovesCard shows breakdown, nothing ticked at mask 0` — no `✓` in the keyboard; text contains `Legs: 2 moves, 6 sets`, `Pull: 1 move, 4 sets`.
  - db `class with moves replaces moves and photo; heavy-only keeps them` — write moves+photo `"F1"`, then heavy-only `["legs"]` → row has the moves, `photo_file_id = 'F1'`, `heavy_groups = {legs}`; then moves without photo → `photo_file_id is null`.
  - db `undo restores the whole previous class row` and `undo deletes a class row that did not exist`.
  - db bot `class card: Save writes heavy groups from the tapped mask` — pending with moves, tap `cm:<id>:4:ok` → `heavy_groups = {legs}`, `parsed->'moves'` length matches.
  - db bot `class card: replaced or expired` — a newer pending replaces it (or clock +31 min) → Save answers the expired text, `class_logs` count 0.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm test && pnpm test:db` → PASS.
- [ ] **Step 5:** Commit `M6: class moves, class card, full-row undo`.

---

### Task 4: STT providers, STT budget, Telegram file download

**Files:**
- Create: `src/stt/stt.ts`, `src/telegram/files.ts`
- Modify: `src/config/env.ts` (`sttSchema`), `.env.example`, `src/logging/usage.ts`, `src/logging/types.ts` (`UsageStore`)
- Test: `test/stt/stt.test.ts`, `test/telegram/files.test.ts`, `test/config/env.test.ts`, `test/db/` usage test (extend an existing usage test or add `test/db/usage.test.ts`)

**Interfaces:**
- Produces:
  - `interface SpeechToText { readonly name: string; transcribe(audio: Uint8Array, opts: { filename: string; prompt: string; signal: AbortSignal }): Promise<string> }`.
  - `createGroqStt(apiKey: string): SpeechToText` — POST `https://api.groq.com/openai/v1/audio/transcriptions`, model `whisper-large-v3-turbo`; `createOpenAiStt(apiKey: string): SpeechToText` — POST `https://api.openai.com/v1/audio/transcriptions`, model `whisper-1`. Both: multipart `file` (`audio/ogg`), `model`, `prompt`, `response_format=json`, **no `language`** (mixed Italian/English). Non-2xx → throw `SttError` with the status only (never the body or key). `name` = `"groq:whisper-large-v3-turbo"` / `"openai:whisper-1"`.
  - `createStt(env = sttEnv()): { stt: SpeechToText; dailySecondsCap: number }`.
  - `STT_TIMEOUT_MS = 20_000`, `MAX_VOICE_SECONDS = 120` exported from `src/stt/stt.ts`.
  - `sttVocabularyPrompt(names: string[]): string` — `"Gym log. Exercises: " + names.join(", ")`, cut at 600 chars on a comma boundary.
  - `sttSchema` gains `STT_DAILY_SECONDS_CAP: strictInt(1800)`.
  - `UsageStore` gains `sttSecondsToday(now: Date): Promise<number>` and `recordStt(seconds: number, provider: string, now: Date): Promise<void>` (inserts a `usage_logs` row: `model = provider`, tokens 0, `stt_seconds = seconds`).
  - `downloadTelegramFile(args: { api: { getFile(fileId: string): Promise<{ file_path?: string; file_size?: number }> }; token: string; fileId: string; maxBytes: number; fetchImpl?: typeof fetch }): Promise<Uint8Array>` — throws `FileTooLargeError` when `file_size` or the body exceeds `maxBytes`; throws on missing `file_path` or non-2xx; never puts the URL in an error message.

- [ ] **Step 1:** Tests (mock `fetch` with `vi.fn`):
  - `groq stt posts model, prompt and no language` — inspect the `FormData`: `model = whisper-large-v3-turbo`, `prompt` set, `language` absent; returns `json.text` trimmed.
  - `stt error carries the status, not the body` — 401 with body `"secret"` → `SttError` message contains `401`, not `secret`.
  - `sttVocabularyPrompt cuts at 600 chars on a comma`.
  - `env: STT_DAILY_SECONDS_CAP defaults to 1800`.
  - `downloadTelegramFile rejects files over maxBytes` (via `file_size`) and `error never contains the token`.
  - db `recordStt and sttSecondsToday sum today's Rome date only`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `M6: STT providers, voice budget, Telegram file download`.

---

### Task 5: Voice flow

**Files:**
- Modify: `src/bot/logging-flow.ts` (extract the body of `text()` into `handleInput`; add `voice()`), `src/bot/bot.ts` (`message:voice` handler before the catch-all), `src/runtime/telegram-runtime.ts` (lazy STT + downloader into the flow), `src/bot/log-format.ts` (copy)
- Test: `test/db/bot-voice.test.ts` (new, same harness as `test/db/bot-logging.test.ts`)

**Interfaces:**
- Consumes: Task 2 (`voiceInput`, `heard`, `inputSource`), Task 4 (`SpeechToText`, `downloadTelegramFile`, usage STT methods, `MAX_VOICE_SECONDS`, `sttVocabularyPrompt`).
- Produces:
  - `FlowDeps` gains `media?: MediaSource` where `interface MediaSource { stt?: () => { stt: SpeechToText; dailySecondsCap: number }; download(fileId: string, maxBytes: number): Promise<Uint8Array> }`. `stt` throws when not configured (like `AiSource`).
  - `Flow` gains `voice(ctx: Context): Promise<void>` and (Task 6) `photo(ctx: Context): Promise<void>`.
  - `handleInput(ctx, input: { body: string; source: InputSource; transcript?: string; photo?: { fileId: string; caption?: string } })` — today's `text()` logic, with `decidePolicy(…, { …, voiceInput: source === "voice" })`, `presentPending` forwarding `inputSource`/`transcript`, and read replies prefixed with the heard line when `source === "voice"` (prefix added after the number guard).
  - `voice()` order: (1) AI config, else `NO_AI_KEY`; (2) STT config, else `VOICE_NOT_CONFIGURED = "Voice isn't configured yet. Text still works."`; (3) ledger results for `u:<update_id>` or pending by source update → same early-return as `text()` (no STT); (4) `voice.duration > MAX_VOICE_SECONDS` → `VOICE_TOO_LONG = "That voice note is too long. Please keep it under 2 minutes."`; (5) `sttSecondsToday + duration > cap` → `VOICE_BUDGET = "Voice budget reached. Text still works."`; (6) download (max 20 MB) and transcribe with `AbortSignal.timeout(STT_TIMEOUT_MS)` and `sttVocabularyPrompt(catalog names)`; record `stt_seconds` after a successful call; (7) transcript with no letter or digit → `VOICE_BLANK = "I couldn't hear that. Please try again or type it."`; (8) `handleInput(ctx, { body: transcript, source: "voice", transcript })`. STT/download failure → `VOICE_FAILED = "Sorry, I couldn't transcribe that. Please try again or type it."`; the handler returns normally (inbox row done).
  - Conversation memory stores the user turn as `[voice] <transcript>`.
  - `bot.on("message:voice", (ctx) => flow.voice(ctx))`; `TEXT_ONLY` becomes `"I can read text, voice notes and class board photos."`.

- [ ] **Step 1:** Tests (fake STT returning scripted text, fake model, fake download):
  - `voice: clear log goes to a confirm card with the heard line` — transcript `"15 face pulls at 20 kg"` and a scripted `log_sets` → no `log_groups` row, a pending with `input_source = 'voice'`, card text starts `🎤 heard: 15 face pulls at 20 kg`; tapping ✅ writes one group with `source = 'voice'`.
  - `voice: readiness by voice is a card, not a direct save`.
  - `voice: a question is answered without a card, with the heard line`.
  - `voice: blank transcript` (`"."`) → `VOICE_BLANK`, model never called.
  - `voice: retry after card` — handle the same update twice → STT called once, one card sent.
  - `voice: not configured`, `voice: too long` (121 s, STT not called), `voice: budget reached`, `voice: STT throws` → the matching copy; `usage_logs.stt_seconds` recorded only on success.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** `pnpm test && pnpm test:db` → PASS (existing text-flow tests unchanged).
- [ ] **Step 5:** Commit `M6: voice notes through the intent pipeline`.

---

### Task 6: Blackboard photo

**Files:**
- Create: `src/ai/board.ts`
- Modify: `src/ai/model.ts` (`IntentRequest.tool_choice?`), `src/ai/fake-model.ts` (records requests, so tests can assert the image block), `src/bot/logging-flow.ts` (`photo()`), `src/bot/bot.ts` (`message:photo`), `src/bot/log-format.ts` (copy)
- Test: `test/ai/board.test.ts`, `test/db/bot-photo.test.ts`

**Interfaces:**
- Consumes: Task 3 (`classMoveSchema`, `classMovesCard`, `log_class` with `photoFileId`/`rawText`), Task 4 (`downloadTelegramFile` via `media.download`), Task 5 (`MediaSource`, `Flow.photo`).
- Produces:
  - `IntentRequest.tool_choice?: Anthropic.Messages.ToolChoice`, passed through in `createAnthropicModel`.
  - `readBoard(args: { model: IntentModel; image: Uint8Array; caption?: string; signal: AbortSignal }): Promise<{ result: BoardResult; usage: TokenUsage }>` with `type BoardResult = { kind: "board"; moves: ClassMove[]; heavyGroups: HeavyGroup[] } | { kind: "not_board" }`. One request: user content = image block (`image/jpeg`, base64) + text block with the caption if any; one tool `record_board` with input `{ is_board: boolean; moves?: ClassMove[]; heavy_groups_from_caption?: ("pull"|"push"|"legs")[] }`, `tool_choice: { type: "tool", name: "record_board" }`, `max_tokens` 2000. System prompt rules: copy move names as written (no translation); tag each move's groups; `heavy_groups_from_caption` only when the caption explicitly says a group was heavy, else empty; never estimate numbers not on the board. Output validated with Zod; invalid or `is_board: false` or zero moves → `not_board`.
  - `BOARD_TIMEOUT_MS = 40_000`.
  - `photo()` order: AI config → ledger/pending-by-update early return (no download, no vision) → token budget (same totals/caps as the text loop) → download the largest `photo` size (max 10 MB) → `readBoard` → record usage → `not_board` → `BOARD_UNREADABLE = "I couldn't read a class board in that photo. Please type or say the class instead."` → else `presentPending` with one `log_class` action `{ input: { moves, heavy_groups }, date: thursdayOnOrBefore(trainingDate(now)), photoFileId, rawText: caption }`, `reasons: ["class_moves"]`, `inputSource: "photo"`. Vision error/timeout → `"Sorry, I couldn't read that photo. Please try again."`.
  - Conversation memory: user `[photo] <caption or "class board">`, assistant `Asked which class parts were heavy: <breakdown in plain text>`.

- [ ] **Step 1:** Tests:
  - `readBoard sends the image and forces record_board` — fake model sees `tool_choice.name = "record_board"` and an `image` content block.
  - `readBoard: is_board false → not_board`; `invalid moves → not_board`.
  - db `photo: card with breakdown and nothing ticked` — scripted board with 3 moves, no caption → card text has the per-group lines, keyboard has no `✓`, pending `input_source = 'photo'`, `class_logs` count 0; Save with mask 0 writes `heavy_groups = {}`, `photo_file_id` = the largest size's `file_id`.
  - db `photo: caption naming legs starts with Legs ticked` and `raw_text` saved.
  - db `photo: not a board` → `BOARD_UNREADABLE`, no pending row.
  - db `photo: retry after card` → model called once.
  - db `photo on Friday logs Thursday's class` — `now` = Fri 23 Oct 2026 → pending action `date = 2026-10-22`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `M6: blackboard photo to class card`.

---

### Task 7: Scheduled jobs and the Thursday 21:00 question

**Files:**
- Create: `src/jobs/runner.ts`, `src/jobs/class-question.ts`, `src/jobs/index.ts` (the job list)
- Modify: `api/cron/tick.ts`, `src/runtime/telegram-runtime.ts` (a `sendToOwner(m: Message)` helper using `bot.api.sendMessage(telegramEnv().ALLOWED_TELEGRAM_USER_ID, …)` with the inline keyboard)
- Test: `test/db/jobs.test.ts`, `test/api/tick.test.ts`

**Interfaces:**
- Consumes: `jobRuns` (Task 1), `classCard(date, 0)` from `src/bot/inputs-flow.ts`, `planWeekFor`, `romeLocalToUtc`.
- Produces:
  - `interface Job { name: string; window(now: Date): { date: string } | null; run(ctx: JobContext, date: string): Promise<"sent" | "skipped"> }`; `interface JobContext { db: Db; now: Date; send(m: Message): Promise<void> }`.
  - `JOB_RECLAIM_MS = 5 * 60_000`.
  - `runDueJobs(ctx: JobContext, jobs: Job[]): Promise<{ job: string; date: string; outcome: "sent" | "skipped" | "busy" | "failed" }[]>` — for each job with a window: claim, run, mark done. Claim is one statement: `INSERT INTO job_runs (job, date, status, claimed_at) VALUES (…, 'claimed', now) ON CONFLICT (job, date) DO UPDATE SET claimed_at = EXCLUDED.claimed_at WHERE job_runs.status = 'claimed' AND job_runs.claimed_at < now - JOB_RECLAIM_MS RETURNING id`; no row → `busy`. A thrown `run` → `failed`, row left `claimed` (re-claimed after 5 min while the window lasts), error name logged, other jobs still run.
  - `classQuestionJob: Job` — `name = "class_question"`; window: Rome weekday Thursday, `21:00 ≤ local time < 23:00`, and `planWeekFor(date, plan.startDate, plan.weeks)` is an in-plan week (needs the plan row: load it in `run`, and return `skipped` outside the plan); `run`: `class_logs` row for `date` exists → `skipped`; else send `CLASS_QUESTION = "How did class go? Send a photo of the board, a voice note, or tap below."` followed by the `classCard(date, 0)` text and its keyboard in the same message → `sent`.
  - `tick.ts`: after `select 1`, run `runDueJobs` in its own try/catch (a jobs failure logs and continues to the sweeper); include `jobs` in the JSON response.

- [ ] **Step 1:** Tests (`now` values in UTC; Rome is UTC+1 after 25 Oct 2026, UTC+2 before):
  - `class question fires Thu 22 Oct 2026 21:00 Rome` (`19:00Z`) → one `sent`, `job_runs` row `done`, one send with the class keyboard.
  - `not due at 20:45 or 23:00 Rome, nor on Wednesday`.
  - `DST: Thu 29 Oct 2026 21:00 Rome (20:00Z) fires; 19:00Z does not`.
  - `second tick in the window does not resend` (done row).
  - `stale claim` — row `claimed` 3 min ago → `busy`, no send; 6 min ago → `sent` once.
  - `skipped when the class is logged` — row `done`, no send.
  - `a failing job does not stop the sweeper` (tick test with mocked `runDueJobs` throwing → 200 and `processChat` called).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** `pnpm test && pnpm test:db` → PASS.
- [ ] **Step 5:** Commit `M6: scheduled jobs and the Thursday class question`.

---

### Task 8: Prompt, golden cases, docs

**Files:**
- Modify: `src/ai/prompt.ts`, `src/ai/tools.ts` (`log_class` description), `test/golden/logging.golden.test.ts`, `src/bot/log-format.ts` (`HELP_TEXT`), `docs/SETUP.md`, `docs/STATUS.md`, `CLAUDE.md` (callback list: `cm:`; M6 architecture paragraph), `.env.example`
- Test: `test/ai/tools.test.ts` (schema in the tool def), golden suite (opt-in)

**Interfaces:**
- Consumes: everything above.
- Produces:
  - Prompt: user turns starting `[voice]` are speech transcripts — numbers may be misheard; they may mix Italian and English. A class described with moves → `log_class` with `moves` (tag groups per move; `heavy_groups` only if the user says which parts were heavy).
  - `log_class` tool description covers `moves`.
  - Golden: `"[voice] quindici face pull con venti chili"` → `log_sets` face pull 15 reps 20 kg; `"[voice] fifteen face pulls at twenty kilos"` → same; `"class today: 5x10 pistol squats, 4x8 pull-ups, 3 rounds of 20 push-ups"` → `log_class` with 3 moves and no `heavy_groups`; `"class was heavy on legs"` → `log_class` `heavy_groups: ["legs"]`.
  - `HELP_TEXT`: one line on voice notes and class photos.
  - SETUP: Groq key steps, `STT_PROVIDER=groq`, `STT_DAILY_SECONDS_CAP`; migration 0006 to apply after OK.
  - STATUS: M6 row "built, not deployed", open items (Groq key in Vercel, migration 0006, live test on a Thursday).
- [ ] **Step 1:** Update `test/ai/tools.test.ts`: `log_class tool schema has moves` → the tool's `input_schema.properties` includes `moves`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement prompt/tool/docs. **Step 4:** `pnpm lint && pnpm typecheck && pnpm test && pnpm test:db` → PASS. Run `pnpm test:golden` only if the user OKs the API spend.
- [ ] **Step 5:** Commit `M6: prompt, golden cases, docs`.

---

## Order and parallelism

Task 1 first. Then Task 2 → 3 → 5 → 6 (each touches `logging-flow.ts`). Task 4 (only `src/stt`, `src/telegram/files.ts`, env, usage) and Task 7 (only `src/jobs`, tick, runtime helper) can run alongside Tasks 2–3. Task 8 last.
