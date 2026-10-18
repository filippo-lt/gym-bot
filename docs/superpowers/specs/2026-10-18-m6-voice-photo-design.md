# M6 — Voice, blackboard photo, Thursday flow

_Design, 18 Oct 2026. SPEC.md stays the source of truth; this document records what M6 adds and the decisions taken with the user. "Builder's call" marks what is left to the implementer._

## Why

The user logs mostly by voice mid-workout (SPEC 5.3), and reports Thursday's calisthenics class with a photo of the blackboard (SPEC 5.4). Today the bot reads text only (`TEXT_ONLY` reply) and the class report is just three heavy/not-heavy buttons. M6 makes voice and photos first-class inputs and adds the first scheduled message (Thursday 21:00), building the scheduled-job machinery that M8's morning message will reuse.

## Goals

1. Voice notes work everywhere text works: logging, questions, readiness, bodyweight, class reports.
2. A blackboard photo becomes a structured class record (moves, sets × reps, muscle groups worked) plus the heavy groups the user picks.
3. A class described in text or voice is parsed into the same structured record.
4. Thursday at 21:00 Europe/Rome the bot asks how class went, unless it is already logged.
5. Generic scheduled-job runner (`job_runs`, claim → send → done, windows) inside the existing cron tick.

## Non-goals

- Morning message, Friday "Thursday not reported" question, weekly check-in, Sunday jobs (M8).
- Charts (M8), plan changes (M7).
- Using the parsed class moves in progression math. Friday rules keep reading `heavy_groups` only. The parsed data is stored for the record and future use.
- Photos of anything other than the class blackboard.
- Audio files, video notes, documents. Only Telegram `voice` messages. (Builder's call: `audio` may reuse the same path if trivial.)

## Anti-goals (would be a failure even if it works)

- A misheard number saved without the user seeing it.
- The model deciding which groups were heavy.
- Any number shown to the user that was written by the model rather than formatted in code from parsed values.
- Retries that transcribe or bill twice and then write twice.

## Decisions taken with the user

### Voice

- Voice note → speech-to-text → the same Claude intent pipeline as typed text. Saved log groups get `source = voice`.
- **Voice writes never save directly.** Every write staged from a voice note goes through a confirm card (✅ ✏️ ❌), including a single clear log that would save directly from text, and including `log_readiness`, `log_bodyweight` and `log_class` (which save directly with Undo from text). Implement as a new policy reason (e.g. `voice_input`) in `decidePolicy`, so it stays enforced in code.
- The card shows a `🎤 heard: …` line with the raw transcript above the code-formatted summary, so the user can tell a mishearing from a misreading.
- Voice questions (reads) are answered like text, no card.
- **Voice notes are mixed language** (Italian and English, often Italian sentences with English exercise names). Don't force a language: use auto-detect, and pass the provider's vocabulary hint (Whisper `prompt`) with the catalog's exercise names and common gym words so English terms survive inside Italian speech. Replies follow SPEC 5.8 (the user's language).
- _Our call:_ a voice note that describes a class with moves gets the class toggle card directly (with the `🎤 heard:` line); its Save is the confirmation. No separate ✅ card first.

### Blackboard photo

- A photo message (with or without `/class` before it, with or without caption) is treated as a class blackboard for `thursdayOnOrBefore(trainingDate(now))`, the same date rule `/class` uses today.
- Claude vision reads the photo into a list of moves: name, sets, reps (or duration for timed work), and the muscle groups each move works: `pull`, `push`, `legs`, `core`, `other`. The model tags groups (class moves are not in the exercise catalog); code does all counting.
- The reply shows a per-group breakdown formatted in code (e.g. "Legs: 3 moves, 12 sets") and the existing Pull / Push / Legs toggles with **nothing pre-ticked**, plus "Not heavy" and "Save". Heavy stays purely the user's call.
- Nothing is saved until Save (or "Not heavy"). Save writes `class_logs`: `photo_file_id`, `parsed` (the moves), `heavy_groups`, and the caption as `raw_text` if any.
- Unreadable photo or not a blackboard → a short reply asking the user to type or say the class instead. Nothing staged.
- The board always fits in one photo (user). No album grouping: a second photo for the same Thursday is a correction and, once saved, **replaces** the moves, photo and raw text (heavy groups come from that card's toggles).
- _Our call:_ the caption goes to the same vision call as context (no second Claude loop). If the caption explicitly names heavy groups ("heavy on legs"), the vision tool returns them and those toggles start ticked, since the user said it, not the model. Move names stay as written on the board (no translation).

### Writes to an existing class row (our call)

- Each write updates only what it carries: a heavy-groups-only report ("actually legs were heavy", or the `/class` buttons) changes `heavy_groups` and keeps moves, photo and raw text. A report with moves (photo, or text/voice with moves) replaces moves, photo and raw text together, plus heavy groups from its card.
- Undo restores the whole previous row (or deletes it if there was none).

### Class in text or voice

- `log_class` gains optional `moves` (same shape as the photo parse). "Class: 5×10 pistols, 4×8 pull-ups" → moves, no heavy groups → same breakdown + unticked toggles card as a photo.
- "Class was heavy on legs" → heavy groups given by the user. From text this keeps today's direct save with Undo; from voice it goes through the confirm card (above). If the user gives both moves and heavy groups, the card shows the groups they named ticked.

### Thursday 21:00 question

- New `job_runs (job, date, status: claimed|done, claimed_at)`, unique `(job, date)`. Order: claim → send → mark done. A `claimed` row older than 5 minutes is re-claimed if still inside the window (SPEC 2, Scheduler).
- The existing `/api/cron/tick` (every 15 min, external scheduler) runs due jobs by Europe/Rome local time, then the inbox sweeper as today.
- Job `class_question`: Thursdays, window 21:00–23:00 Rome (builder may adjust the end, must be ≥ 1 h so one missed tick doesn't lose it). Skipped (and marked done) if `class_logs` already has that Thursday, or the date is outside the plan's 12 weeks.
- Message: "How did class go? Send a photo of the board, a voice note, or tap below." plus the class toggles card.
- The job runner is generic: a list of `{ job, isDue(romeNow), run() }` so M8 adds entries without touching the claim logic.

## Constraints (from the codebase and SPEC)

- Vercel function `maxDuration: 90`, chat lease 150 s, one inbox row per handler run. Download + STT + Claude loop must fit (Claude loop is capped at 40 s; budget STT at ≤ 20 s with its own timeout).
- Session pooler: no concurrent queries on one connection (no `Promise.all` of DB reads).
- STT provider is swappable behind an interface (SPEC 2). `sttEnv()` already exists (`STT_PROVIDER` groq|openai + key) and must be read lazily, like `aiEnv()`, so the bot runs without it ("Voice isn't configured yet. Text still works.").
- Default provider Groq (cheaper; builder picks the current Whisper model, e.g. `whisper-large-v3-turbo`). OpenAI as the alternative implementation.
- Telegram voice is OGG/Opus; fetch it with `getFile` and the file URL. Never log the file URL (it contains the bot token).
- Cost guard: record `stt_seconds` (Telegram's `voice.duration`) in `usage_logs`. Vision tokens go through the existing token usage store and caps. Add an STT daily seconds cap in env with a sensible default; above it reply "Voice budget reached. Text still works."
- Idempotency: the inbox can run a handler twice. Check the ledger and `source_update_id` pending **before** calling STT or vision, as the text flow already does before calling the model. Builder's call whether to persist the transcript / parse to avoid re-billing on a crash between STT and the card.
- RLS on every new table (db test enforces it). New tables in `src/db/schema/`, then `pnpm db:generate`. The migration needs the user's OK before it runs in production.
- Callback data ≤ 64 bytes. The photo/moves card needs to reach the stored parse on Save. Builder's call how: likely a `pending_actions` row holding the parsed class, with its id in the callback (e.g. `cg:<mask>:<YYYYMMDD>:<pendingId>`).
- Undo of a class write must restore the whole previous row (moves, photo, raw text), not just the heavy groups as today.
- Chat target for scheduled messages: `ALLOWED_TELEGRAM_USER_ID` (private chat id = user id).
- A pending action created from voice keeps its voice origin through clarify and ✏️ edit taps (still never a direct write).

## Tests (beyond SPEC §9, which still applies)

- Policy: any write from a voice input → confirm, never direct (each write kind).
- Voice card shows the transcript line; reads by voice reply without a card.
- STT not configured, STT failure/timeout, empty transcript → friendly reply, inbox row done, no write.
- Retry of a voice update after the card went out → no second STT call, no second card.
- Photo: fake vision → breakdown counts computed in code; nothing pre-ticked; Save writes `parsed`, `photo_file_id`, heavy groups; not-a-board → no pending action.
- `log_class` with moves from text → card with unticked toggles; heavy groups given → ticked.
- Job runner (db tests): due only in window; claim is exclusive; stale claim re-claimed inside the window, not outside; done row never re-sent; skipped when the class is logged; DST week (Thu 29 Oct 2026, after the 25 Oct change) still fires at 21:00 Rome.
- Golden suite (opt-in): add a few voice-style transcripts ("fifteen face pulls at twenty kilos") and class descriptions.

## Left to the builder

- Module layout (suggested: `src/stt/` for providers, `src/vision/` or inside `src/ai/` for the board parse, `src/jobs/` for the runner).
- Exact wording of replies, keeping SPEC 5.8 (short, simple English).
- Voice length limit (suggested: reject > 120 s with a short message).
- The photo parse prompt and tool schema, as long as it returns structured moves via a tool, not prose.
