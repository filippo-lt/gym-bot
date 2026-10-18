# Project status

Where GymBot stands, what is still open, and what comes next. Update this file at the end of every milestone or fix round. SPEC.md stays the source of truth for behaviour; this file is the progress log.

_Last updated: 18 Oct 2026 (M6 deployed; live test pending. M8 merged to dev. M9 PR open; M7 in a parallel branch)._

## Milestones (SPEC §8)

| # | Milestone | State | PRs |
|---|---|---|---|
| 0 | Setup (repo, TS, Drizzle + Supabase, Vercel, env) | live | #1 |
| 1 | Plan import (12-week plan, exercise catalog) | live | #1 |
| 1b | History import (old tool export → `source = import` rows) | live | #2 |
| 2 | Telegram skeleton (webhook, inbox, lease, `/today`, `/week`) | live | #2 |
| 3 | Text logging (Claude intent, cards, RIR/clean, edit/undo, aliases, write_ledger) | live | #3–#7 |
| 4 | Queries (`/next`, `/session`, `/history`, `/plan`, history/alternatives in chat, memory, number guard) | live | #8 |
| 5 | Progression + fatigue engine (suggested loads, e1RM, pull-up gate, HSPU, Friday tags, readiness, `/readiness`, `/class`, `/bw`, `/short`, `/skip`) | live, 5 weeks ahead of the 23 Nov target | #9, #10, #11 |
| 6 | Voice + photo (Whisper, blackboard parsing, Thursday flow) | deployed 18 Oct, live test pending | #12 |
| 7 | Plan changes (swaps with scope, plan versioning) | todo | |
| 8 | Morning message + charts | merged to dev, not deployed | #13 |
| 9 | Hardening (cost guard review, weekly backup, restore from backup, tool-failure messages) | PR open, not merged | M9 PR |

## What happened, in short

- **M3 rollout (18 Oct).** Free text hung in production. Cause: postgres-js pipelining on the Supabase transaction pooler (6543). `max_pipeline: 0` broke transactions (#4). Fixed for good by moving the runtime to the session pooler (5432); `dbEnv` now rejects 6543 (#5).
- **M3 live test (18 Oct), fixed in #6:**
  - a model retry staged the same log twice
  - make-ups landed on items already marked done by the import, and undo then deleted the import's session_items row (one Tue W3 row was lost and restored with `pnpm history:import`)
  - `day: "today"` couldn't override a make-up
  - button outcomes were missing from the conversation context, so corrections became new logs
  - raw Markdown in replies
  - garbled slash commands went to Claude
- **M3 follow-ups (#7):** stale taps, card retirement, the original echo is refreshed after an edit, one failure notice per failed inbox row.
- **M4 (#8):** commands work without the AI key. A number guard sends the code-formatted answer when a reply contains a number that is not in the tool results, the context or the user's message.
- **M5 (#10, #11):**
  - pure progression modules with heavy unit tests
  - hand-simulation fixtures (26 Oct, 30 Oct heavy legs, 23 Nov) whose expected values were worked out by the user on a synthetic lifter (`seed/review/progression-worksheet.md`, `test/fixtures/progression/`)
  - migration 0005 applied to production
  - decisions: break cut = 10 % of total load taken from added weight; pull-up assistance = resistance bands; heavy-Thursday Friday reduction = 2 × 4 at RIR 3–4 with load −15 %, rounded down; Thursday input = `/class` buttons plus chat
  - #11: deload weeks keep the deload pull-up prescription when the gate is closed
- **M6 (#12, deployed 18 Oct):**
  - voice notes: Telegram download, speech to text (Groq `whisper-large-v3-turbo`, or OpenAI `whisper-1`), then the normal intent pipeline. Every voice write goes through a confirm card showing "🎤 heard: …"; reads get the heard line first
  - class board photo: one forced vision call reads the moves, then a card shows the per-group breakdown with untick-able toggles (heavy groups start unticked unless the caption names them). Photos over 3.5 MB are refused
  - class rows keep moves and photo; undo restores the whole previous row
  - scheduled jobs (`src/jobs/`, run from the cron tick): the Thursday 21:00–23:00 Rome class question, skipped when the class is logged or outside the plan
  - migration 0006 (`job_runs`, `pending_actions.input_source`/`transcript`) applied to production; STT env vars set in Vercel; health and tick OK after deploy
  - decisions: voice notes are mixed Italian/English, so no language is forced; every voice write needs a tap, even a single clear log; a ✏️ correction keeps the voice origin; on the photo card "Not heavy" saves in one tap; a photo without a caption never starts with groups ticked; set counts show only what is written ("6 sets", "6+ sets", or none); a heavy-only report keeps the stored moves and photo, a report with moves replaces them
  - design and plan: `docs/superpowers/specs/2026-10-18-m6-voice-photo-design.md`, `docs/superpowers/plans/2026-10-18-m6-voice-photo.md`
- **M8 (#13, merged to dev 18 Oct, not deployed):**
  - morning job: Mon–Fri 06:00–10:00 Rome, the exact `/today` text with 😴 / 🙂 / 💪 buttons; a tap re-freezes today until the first log and edits the message in place; Friday asks about Thursday first and re-sends the session after Save; "plan finished" once on Mon 21 Dec; quiet at weekends, before/after the plan and once something is logged
  - charts: `/chart <exercise>` (e1RM per session; most reps per set; pull-ups both; HSPU per step; holds in seconds), `/chart volume` (hard sets per week per muscle group), `/chart` buttons, and the `render_chart` chat tool (image after the reply, one per message)
  - renderer: Vega-Lite → SVG → PNG with `@resvg/resvg-js` and a bundled Inter font; no native build, no hosted chart service
  - no migration, no new env vars
  - decisions: the user left the design calls to Claude; an independent agent then answered the open questions and its answers were adopted (e1RM only for load, most reps only, timed holds out of volume). `/done`, `/checkin`, the Friday 20:00 check-in and the Sunday summary are NOT in M8 (proposed as their own milestone)
  - design and plan: `docs/superpowers/specs/2026-10-18-m8-morning-charts-design.md`, `docs/superpowers/plans/2026-10-18-m8-morning-charts.md`
- **M9 (PR open, 18 Oct):**
  - backup: `/export` and a Sunday 18:00 job send a summary, the JSON backup (restore source; gzipped over 10 MB, refused over 45 MB) and a CSV zip (one file per table). `pnpm backup` writes the same files locally. The table list comes from the Postgres catalog, so M7's new tables are covered with no code change; only `inbox` and `chat_lease` are left out
  - restore: `pnpm backup:restore <file> [--dry-run] [--allow-remote]` into an empty, migrated database named by `RESTORE_DATABASE_URL` (no fallback). Refuses a non-empty target, a migration or table mismatch, a damaged file. Original ids, `write_ledger` and sequences are kept, so old taps and retries still write nothing twice. Runbook in `docs/SETUP.md`
  - failure messages: each step says what failed (Claude timeout / overloaded / rate limit / key rejected, Groq or OpenAI transcription, Telegram download, photo too large, database). Inbox retries tell the user on the first failure ("I'll retry automatically, so don't send it again") and give the reason after the third
  - cost guard: cache tokens count (write × 1.25, read × 0.1); the budget reply names the daily or monthly cap and when it resets; `/usage` shows today and the month
  - time budget: each inbox row runs under the invocation's deadline (start + 85 s); timeouts shrink to the time left, and a voice note or photo that can't finish waits for the next webhook or tick instead of being killed at 90 s
  - inbox rows older than 30 days (done or failed) are purged by the tick
  - no migration, one new optional env var (`RESTORE_DATABASE_URL`, local use only)
  - decisions: the user left the design to Claude; an independent agent answered the open design questions and its answers were adopted (`docs/superpowers/specs/2026-10-18-m9-design-qa.md`). Known minor issue "photo over 3.5 MB" is fixed (a smaller Telegram size is used when one fits); the others stay
  - design and plan: `docs/superpowers/specs/2026-10-18-m9-hardening-design.md`, `docs/superpowers/plans/2026-10-18-m9-hardening.md`

## Open items

**For the user (manual):**
- **M6 live test (from the phone):**
  - a voice note such as "15 face pulls at 20 kg" → card starting "🎤 heard:" with ✅ ✏️ ❌; ✅ saves with `source = voice`
  - a class board photo → per-group breakdown, Pull / Push / Legs unticked, Save / Not heavy
  - Thu 22 Oct 21:00 → the class question arrives (skipped if the class is already logged)
- Revoke the Telegram bot token in BotFather, update `.env.local` and Vercel, redeploy, then run `pnpm telegram:setup https://gym-bot-xi.vercel.app`.
- Remove the unused `SUPABASE_DB_PASSWORD` and the Supabase integration's unused service-role key from Vercel.
- Send band colours with their kg of assistance (or answer the bot the first time it asks).
- Decide what to do with the untracked `.github/workflows/automerge.yml` (it auto-merges every PR; nobody in the sessions created it; it has never been committed). The standing rule is that only the user merges.
- **Cutover:** pick a training day, run `pnpm history:import --dry-run`, then `pnpm history:import`, then stop using the old tool.

- **M8 after merge:** run `pnpm telegram:setup https://gym-bot-xi.vercel.app` once to register `/chart` in the command menu. Then the M8 live test (below).
- **M8 live test (from the phone, after deploy):**
  - `/chart squat` → a PNG with readable labels (if the labels are missing, the font didn't reach the Vercel bundle); `/chart pull-up` → two panels; `/chart volume` → stacked bars; `/chart` → buttons
  - "how is my bench going?" → a short reply, then the chart
  - the next weekday at 06:00 → the morning message; tap 😴 → the same message updates in place with "Noted: 😴"
  - Friday 06:00 with Thursday not reported → the class card first, then the session; Save → the session again with the Friday changes
- **M9 after merge:** run `pnpm telegram:setup https://gym-bot-xi.vercel.app` once to register `/usage` and `/export`. Optionally rehearse a restore locally (`docs/SETUP.md`, "Restore from a backup"); never against production without an explicit OK.
- **M9 demo (from the phone, after deploy):**
  - `/usage` → today's and this month's AI tokens against the caps, and today's voice minutes
  - `/export` → "Preparing your backup…", a summary with row counts, then `gymbot-backup-<date>.json` and `gymbot-backup-<date>-csv.zip`; open the zip in Files and a CSV in Numbers
  - Sun 25 Oct between 18:00 and 18:15 → the same summary with "This week: … Limits per day: …" and the two files, without asking
  - send a class board photo as a big "file" photo or a high-resolution shot → it is read (a smaller size is used), or "That photo is too large (max 3.5 MB)…" if no size fits
  - failure texts can't be triggered safely in production; they are covered by tests
- **Next milestone to plan:** weekly check-in (`/done`, `/checkin`, Friday 20:00 check-in, Sunday summary). Recovery score and the check-in max stay missing until then; schedule it before W12 (14 Dec).

**To verify on the first weekdays (could not be tested on a Sunday):**
- Suggested loads in a weekday `/today`.
- The "far from the suggestion" confirm card.
- The Friday view after a heavy Thursday class.
- The read-only engine run on real data showed RDL and lat pulldown as "baseline, tell me your weight". The imported week 1 has no per-set reps or RIR, so the first logged sessions set the baseline.

**Known minor issues (not blocking):**
- The duplicate-user-message check in `conversation.ts` is keyed on text, not on update id (no migration for it).
- If a re-import restores a bot-logged slot that the export no longer has, the row stays `source = bot`.
- A crash after STT or vision succeeds but before the card is stored re-bills STT/vision on the inbox retry (no duplicate write).
- After a re-import, undo of an earlier bot log restores the status recorded at log time, even if the fresh export changed it.
- If marking a scheduled job done fails after its message was sent, the job can send again 5 minutes later while its window is open.
- M8: if marking the morning job done fails after the send, it can repeat every 5 minutes inside its 06:00–10:00 window (same runner issue as above; M9 left it: SPEC §2 chose at-least-once, and the window bounds the repeats). On a Friday with Thursday unreported, a failure between the class card and the morning message re-sends the class card too.
- M8: a Telegram redelivery of a class-card Save on Friday re-sends the Friday session (no duplicate write; `executeActions` has no replay flag).
- M8: with no plan at all the morning job is recorded as failed instead of skipped.
- M9: if a backup document fails after the summary went out, each retry tick re-sends the summary (at most until 23:00).
- M9: the "last chance" failure notice goes out on the first failing run at or after 22:30, so a 22:45 run can still succeed after it.
- M9: the weekly backup job has no deadline of its own; a backup slower than 90 s would be killed and re-sent 5 minutes later (data is far too small for this today).
- M9: `/export` has no time check; a killed export is retried with the inbox row and may send twice.
- M9: a voice note queued behind a slow text waits for the next webhook or tick (up to 15 min) with no "queued" reply.
- M9: JSON `null` inside a jsonb column is restored as SQL `NULL` (the app never stores JSON `null`).

## How we work

- Plan each milestone first: agree the design with the user, write it to `docs/superpowers/specs/`, then a task plan in `docs/superpowers/plans/`. Build task by task with Sonnet subagents; after each task an independent Haiku reviewer (high effort), fixes until clean, then one whole-branch review (see CLAUDE.md, Workflow).
- Commit to `dev`, open a PR `dev → main`; the user merges, or tells Claude to. Vercel deploys `main`. Apply any new migration before merging.
- Production writes (`pnpm db:migrate`, `pnpm history:import`, manual SQL) need the user's OK every time. Always dry-run the import first.
- After each deploy, check health with the cron secret: `curl -H "Authorization: Bearer $CRON_SECRET" https://gym-bot-xi.vercel.app/api/health`.

## Live testing in Telegram

Use Claude in Chrome on `https://web.telegram.org/k/#@GyyyyyyyyyymBot`.

- **Opening the chat:** if navigating doesn't open it, click "Gymbot" in the sidebar. Check which chat is open before every send.
- **Scrolling:** the chat does not auto-scroll; scroll down before each screenshot.
- **Typing:** clear the input with cmd+a Backspace first. For slash commands, type `/cmd ` with a trailing space and click send; Enter or Escape while autocomplete is open garbles the command or closes the chat.
- **Buttons:** `find` refs on inline buttons are unreliable. Zoom into the card and click by coordinates.
- **Timing:** replies take 5–15 s.
- **Checking the DB:** check each flow read-only (inbox, pending_actions, log_groups, session_items, conversation_messages).
- **Cleanup:** afterwards, undo every test log, then check 0 bot log groups, 0 open pending actions and 77 import session_items.
- **Weekends:** on a weekend every log goes through make-up or unplanned paths. Test weekday paths on a weekday.
- **Voice and photos:** Telegram Web can't record voice notes; test voice from the phone. Photos can be sent from the phone or uploaded in Telegram Web.
