# Project status

Where GymBot stands, what is still open, and what comes next. Update this file at the end of every milestone or fix round. SPEC.md stays the source of truth for behaviour; this file is the progress log.

_Last updated: 18 Oct 2026 (end of M6 build)._

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
| 6 | Voice + photo (Whisper, blackboard parsing, Thursday flow) | built, not deployed | #12 |
| 7 | Plan changes (swaps with scope, plan versioning) | todo | |
| 8 | Morning message + charts | todo | |
| 9 | Hardening (cost guard review, weekly backup, restore from backup, tool-failure messages) | todo | |

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
- **M6 (built, not deployed):**
  - voice notes: Telegram download, speech to text (Groq `whisper-large-v3-turbo`, or OpenAI `whisper-1`), then the normal intent pipeline. Every voice write goes through a confirm card showing "🎤 heard: …"; reads get the heard line first
  - class board photo: one forced vision call reads the moves, then a card shows the per-group breakdown with untick-able toggles (heavy groups start unticked unless the caption names them). Photos over 3.5 MB are refused
  - class rows keep moves and photo; undo restores the whole previous row
  - scheduled jobs (`src/jobs/`, run from the cron tick): the Thursday 21:00–23:00 Rome class question, skipped when the class is logged or outside the plan
  - migration 0006 (`job_runs`, `pending_actions.input_source`/`transcript`) is not applied to production

## Open items

**For the user (manual):**
- **M6 deploy:** add `GROQ_API_KEY`, `STT_PROVIDER=groq` and `STT_DAILY_SECONDS_CAP` in Vercel; say OK to apply migration 0006 (`pnpm db:migrate`) before deploying.
- **M6 live test:** send a voice note and a class board photo; check the first Thursday 21:00 class question on 22 Oct.
- Revoke the Telegram bot token in BotFather, update `.env.local` and Vercel, redeploy, then run `pnpm telegram:setup https://gym-bot-xi.vercel.app`.
- Remove the unused `SUPABASE_DB_PASSWORD` and the Supabase integration's unused service-role key from Vercel.
- Send band colours with their kg of assistance (or answer the bot the first time it asks).
- Decide what to do with the untracked `.github/workflows/automerge.yml` (it auto-merges every PR; nobody in the sessions created it; it has never been committed). The standing rule is that only the user merges.
- **Cutover:** pick a training day, run `pnpm history:import --dry-run`, then `pnpm history:import`, then stop using the old tool.

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

## How we work

- Plan each milestone first (plan mode), then build with Sonnet subagents. Independent QA by a Haiku subagent at high effort, repeated until clean (see CLAUDE.md, Workflow).
- Commit to `dev`, open a PR `dev → main`; the user merges. Vercel deploys `main`.
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
