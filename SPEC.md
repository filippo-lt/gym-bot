# Workout Bot — Build Spec for Claude Code

> Paste this file into the repo root as `SPEC.md` and tell Claude Code:
> "Read SPEC.md. Start in plan mode. Propose the plan for Milestone 0–1 only, then wait for my OK."

## 1. Goal

A personal Telegram bot that replaces my web workout tracker
(https://filippo-hybrid-strength-tracker.filippo-tosett680853.chatgpt.site).

It stores my workout plan and my history. I talk to it (text, voice, photos) to:
- log what I just did ("15 face pulls with 20 kg")
- ask what's next ("how many pull-ups today?")
- ask about progression ("what did I squat last week?" → answer + suggestion for today)
- change the plan ("swap face pulls for band pull-aparts — only today" / "from now on")
- ask for alternatives ("machine version of Bulgarian split squats?")
- see charts ("show my pull-up trend")

Single user: me. No multi-tenant logic.

## 2. Stack (decided)

- **Language:** TypeScript (strict)
- **Hosting:** Vercel, Hobby (free) plan, serverless functions
- **Telegram:** grammY, webhook mode (no long polling)
- **DB:** Supabase (free tier), used as **plain Postgres** through Drizzle ORM + migrations. No supabase-js, no Supabase Auth. Connect through the Supabase pooler in transaction mode (serverless-safe; disable prepared statements). Enable RLS with no public policies — only the server touches the DB.
  - Free projects pause after ~7 days with no activity. The daily cron must touch the DB so this never happens.
- **LLM:** Anthropic API, Claude with tool use. Default model `claude-sonnet-5-5` (configurable via env). The LLM only parses intent and writes replies. It never does the math.
- **Speech-to-text:** Whisper (OpenAI or Groq — pick the cheaper, make it swappable behind an interface). Telegram voice is OGG/Opus.
- **Images:** Claude vision (for photos of the Thursday class blackboard)
- **Charts:** PNG rendered server-side (QuickChart.io or a pure-JS renderer that works on Vercel — avoid native deps like `canvas`), sent with `sendPhoto`
- **Validation:** Zod on every tool input/output
- **Tests:** Vitest

**Scheduler:** an external scheduler (e.g. cron-job.org) calls one protected endpoint `/api/cron/tick` **every 15 minutes**. The code checks the Europe/Rome local time and runs the jobs that are due — so DST changes don't matter. Every job has a **window** (e.g. morning 06:00–09:00 — after that it's skipped, not sent late). `job_runs (job, date, status: claimed|done, claimed_at)`. Order: claim → send → mark done. A row `claimed` for > 5 min is re-claimed within the window. Enable the scheduler's failure email alerts, and check whether it auto-disables jobs after repeated errors. Sunday job: 18:00. The tick also runs the inbox sweeper and keeps Supabase awake (verify that pooler SQL counts as activity for the free-tier pause; if unclear, also hit a Supabase REST endpoint once a day). Don't use GitHub Actions schedules (they run late or get skipped).

## 3. Architecture

```
Telegram ──text/voice/photo──▶ /api/telegram (webhook)
                                  │  verify secret header + my user ID
                                  │  dedupe by update_id
                     voice ──▶ Whisper ──▶ text
                     photo ──▶ Claude vision
                                  │
                        Claude + tools (intent)
                           │              │
                  domain logic (code)   Postgres
                  progression, dates    plan, log, history
                                  │
Telegram ◀──── reply / buttons / chart PNG
Scheduler ──▶ /api/cron/tick (every 15 min) → due jobs in Europe/Rome time:
              morning 06:00 Mon–Fri · class question Thu 21:00 ·
              check-in Fri 20:00 · summary + backup Sun · inbox sweeper
```

Rule of thumb: **anything with a number is computed in code**. Claude calls tools and phrases the answer.

Runtime rules:
- **Inbox first.** The webhook writes the raw update to `inbox` (status `pending`), returns 200, then processes with `waitUntil` (`@vercel/functions`), sending `typing` while working.
- **One message at a time, in order — lease with an owner:**
  - `chat_lease (chat_id, owner uuid, until)`. Each invocation generates its own `owner` id.
  - Acquire / renew (same statement): `UPDATE chat_lease SET owner = $me, until = now() + 120s WHERE chat_id = $c AND (until < now() OR owner = $me) RETURNING`. Release: `UPDATE chat_lease SET until = now() WHERE owner = $me`. Nobody can renew or release someone else's lease.
  - **Lease > function `maxDuration`** (e.g. maxDuration 60 s, lease 120 s — check the current Vercel Hobby limit and keep lease = maxDuration + 60 s). A function is killed at `maxDuration`, so a live holder can never lose its lease.
  - One row must fit in one invocation: cap the Claude tool loop (e.g. 6 turns) and send charts as a follow-up job if needed. A row that times out 3 times is `failed` with a clear message, never retried silently forever.
  - The holder processes **only the oldest non-done row**, one at a time, renewing the lease before each row. It stops taking new rows ~15 s before `maxDuration`; leftovers are picked up by the next webhook or tick.
  - Row claim: `UPDATE inbox SET status='processing', claimed_at=now(), claimed_by=$me, attempts=attempts+1 WHERE id=$oldest AND status='pending' RETURNING`.
  - **Stuck rows:** before taking work, the lease holder resets `processing` rows whose `claimed_at` is older than the lease (120 s) back to `pending`. Because only the lease holder processes, and only the oldest row, order is preserved.
  - After 3 attempts a row is `failed`, the bot tells me, and the queue moves on.
  - After releasing, the holder checks the inbox once more and re-acquires if a row arrived in between.
- **Idempotent writes:** every DB write from a message goes through `write_ledger (source_key, action_index)` **unique**, in the same transaction as the write. `source_key` = Telegram `update_id`, or the pending-action id for a ✅ confirmation. On retry, an existing ledger row means "already done" → treat as success, don't fail. (One message can create several groups, so the key is per action, not per message.)
- **Cost guard:** log tokens per request; daily/monthly cap in env; above cap → reply "AI budget reached", commands still work.

## 4. Security

- Accept updates only from my Telegram user ID (env `ALLOWED_TELEGRAM_USER_ID`). Ignore everyone else silently.
- Set the webhook with `secret_token`; reject requests without the matching `X-Telegram-Bot-Api-Secret-Token`.
- Cron endpoints require a bearer secret.
- All secrets in Vercel env vars. Nothing in the repo.

## 5. Domain rules

### 5.1 Calendar and "today"
- Timezone: `Europe/Rome` everywhere. Store timestamps in UTC.
- Plan: 12 weeks, **start date 2026-09-28** (Monday). Week 1 = 28 Sep–4 Oct. Week 4 (19–25 Oct) is a deload.
- Phases (from the plan file): W1–3 Base · W4 Deload · W5–7 Strength · W8 Deload · W9–11 Specificity · W12 Test.
- "Today" = the session scheduled for today's calendar day. Never auto-shift a missed session.
- A missed session is shown only when I ask for it explicitly ("show me Monday's session").
- Weekly structure (source of truth: `seed/hybrid-strength-plan.json`):
  - Mon: vertical pull + hinge
  - Tue: HSPU / vertical press + squat
  - Wed: conditioning + mobility
  - Thu: calisthenics class (external, I report it)
  - Fri: full-body strength, auto-regulated by Thursday fatigue
  - Sat, Sun: rest

### 5.2 Progression — one RIR-based rule
The plan decides **sets × reps × RIR** for every week. The bot decides only the **load**. Every suggestion is **stored** (table `suggestions`) and shown as a computed estimate, never as a fact.

**Units (one convention everywhere — import, voice, bot)**
- Barbell: total including the bar. Dumbbells: **per hand**. Machines/cables: the stack value. Unilateral: per side.
- Pull-up type (`bodyweight_plus`): `added_kg` ≥ 0 and `assist_kg` ≥ 0 are separate fields. `system_load = bw_kg + added_kg − assist_kg`. Bands map to kg through the `equipment` table (colour → kg); a band with no mapping → no load math, ask me once to set it.
- Each exercise has `load_basis` (barbell_total | per_hand | stack | bodyweight_plus) and an `equipment_id` (the only source of rounding steps).

**Strength estimate (e1RM)**
- Per set: `e1RM = system_load × (1 + (reps + RIR) / 30)` (Epley with RIR).
- One spoken RIR for a whole group belongs to the **last** set; other sets of that group are not used.
- Session estimate = the highest valid set estimate of that session.
- Current e1RM: 3+ sessions → median of the last 3; 2 sessions → the lower one; 1 session → that one, labelled "estimate".
- A set is **valid** if: RIR logged, reps ≤ 15, not in a deload or test week, not `clean = false`, and the session readiness was not RED. (YELLOW sets are fine: the formula uses the RIR I actually logged.)
- A "4+" set counts as RIR 4 and may **raise** the e1RM, never lower it (otherwise too-light suggestions never correct themselves).
- Tuesday and Friday squat share one e1RM; different reps give different loads, which is correct.
- `bw_kg` is stored on every log group at log time; history is never recomputed when bodyweight changes.
- Load math only for types `weighted` and `bodyweight_plus`. `bodyweight_reps` (leg raise, pike push-up), `timed` (hang) and `skill_ladder` (HSPU) get reps / time progression only.
- Known approximation: hack squat (sled) and Bulgarian (dumbbells) use external load only. Fine, because their rep targets barely change.

**Derived state.** Pull-up gate, HSPU step/pad and e1RM are **recomputed from history** (pure functions) after every `/undo`, edit, import or re-import. `user_state` is only a cache.

**Imported history (old tool)** — explicit defaults, shown in the import review table for my OK:
- The single imported RIR belongs to the last set; readiness = GREEN; pull-up sets `clean = true` unless the note says otherwise; `bw_kg` = my setup bodyweight.
- Imported sets are valid for e1RM with the label "estimate" until 2 bot-logged sessions exist for that exercise.

**Suggested load**
- Load for `reps_min` at the **middle of the RIR target**, rounded **toward easier** to the equipment step (less added weight / more assistance / lower stack).
- For `bodyweight_plus`: compute the needed system load, subtract `bw_kg` → positive = added kg, negative = assistance.
- **Break rule:** fires when the planned item (not the option) was **scheduled and not logged 2+ times in a row**, or when I logged **no training at all for 10+ days**. Then −10%, labelled "back after a break". For `bodyweight_plus` the cut comes off added weight only, floored at 0. (Counting days per exercise fired after every deload and on items that skip deload weeks, like "Curl OR triceps".)
- No valid session yet → no suggestion; ask for the load.
- Imported-only history → suggestion labelled "estimate — check your first set".
- **Accessories (not main lifts):** simpler rule with per-set reps and the last-set RIR only. All sets hit `reps_max` and last-set RIR ≥ `rir_min` → +1 step. Any set below `reps_min`, or last-set RIR 0 in 2 sessions in a row → −1 step. Otherwise keep.

**RIR targets** (`rir_min`/`rir_max` on each planned item; **never parsed from notes**)
- **Main lifts are an explicit list** (`is_main_lift`): pull-up, OHP, bench press, squat / hack squat, Romanian deadlift — RIR 1–2, including pull-up. Everything else weighted: 1–3 (my addition, not in the plan).
- Deload items and any item marked "easy" / "light": 3–4 at `reps_min`.
- Friday heavy-Thursday reductions: 2 × `reps_min` at RIR 3–4.
- Test items: RIR 0–1 allowed, no load math. Outside tests, pull-up / HSPU never below 1.
- Buttons: `0` `1` `2` `3` `4+`. "Off target" is measured from the nearest edge of the range.

**Pull-up**
- "Clean strict pull-up", "Weighted pull-up" (with or without `*`), deload variants and "Clean pull-up TEST" are **one exercise** (`bodyweight_plus`).
- **Weighted gate is a stored state, not a time window:**
  - Opens on a clean bodyweight set of ≥ 6 reps, or a check-in / test max ≥ 6.
  - Stays open.
  - Closes only if a later bodyweight max test is < 6, or the e1RM implies **< 5** bodyweight reps (`30 × (e1RM / bw_kg − 1) − 1.5 < 5`) in **2 sessions in a row**. Open at 6, close below 5: this gap stops week-to-week flipping.
  - When it isn't open yet and there is no max on record, Monday's session **starts** with one max-clean test set (stop 1 rep before form breaks), then continues.
- **Closed gate uses the plan's fallback:** bodyweight 4 × 4–6 if my last bodyweight max is ≥ 4 clean reps, otherwise assisted 4 × 6. At import, this note becomes a structured `fallback_prescription` on every pull-up item (shown in the M1 review).
- Pull-up and HSPU sets have `clean: true|false`; if I don't say, the bot asks.

**HSPU — user state, not calendar**
- The plan names a variation in only 5 of 12 weeks; the rest say "current progression", "lower pad / harder progression", "hardest clean progression". So the **current variation + pad height is my state**, taken from my last log. Plan weeks supply only sets × reps.
- A seeded **ladder** (from the plan: feet-elevated pike push-up → HSPU negative → partial-ROM wall HSPU → lower pad … → full wall HSPU). Pad height is a field on the same exercise, not a new one. Each step has its own default sets × reps and tempo (e.g. 5 s down only on negatives).
- **Which reps:** if my current step is the step the plan names for that week, use the plan's sets × reps. If I'm on a different step (behind or ahead), use that step's own defaults. "At target reps" = `reps_max` for advancing.
- Plan rule: **advance only after 2 clean sessions** (non-deload, all sets at target reps) at the current step → bot proposes the next step (confirmation). Otherwise stay.
- Charts are per ladder step.

**No load math** for `skill_practice` (handstand), HIIT, mobility, warm-ups: done / modified / skipped + note. Load math is decided by exercise **type**, never by tag.

**Test week (W12):** results are stored as metrics; pull-up / HSPU maxes update the gate and the HSPU state. No other e1RM updates.

**Friday auto-regulation** (by tags):
- heavy PULL → `row` items: 2 × `reps_min` at RIR 3–4, or skip
- heavy PUSH → `horizontal_press` items: same
- heavy LEGS → `squat` items: same; `unilateral_leg` items **offered** as skip (plan says "can be skipped")
- Deload Friday + heavy anything: the matching items drop to 1 easy set or skip (plan note: "reduce further"); Bulgarian skipped on heavy legs.
- Main-lift load on a reduced Friday = normal load − 15% (the normal needed load, unrounded, × 0.85), rounded toward easier — user decision 2026-10-18. Accessories hold their last valid load.
- If Thursday wasn't reported yet, the Friday morning message asks first, then shows the session.

**Short on time:** hide `Low` items, flag `Medium` as optional.

### 5.3 Logging
- I log after each exercise, usually by voice.
- An entry can include: exercise, sets, reps per set, load (kg), assistance (band colour / kg), duration (s), distance, HSPU pad height, RIR, free note.
- If RIR is missing, the entry is **saved** and the bot asks with buttons `0` `1` `2` `3` `4+`. Until answered, those sets don't count for e1RM. (A follow-up question, not a confirmation.)
- If the exercise is ambiguous, the bot asks with buttons (top matches from today's session first).
- Corrections: "no, it was 22.5 kg" edits the last group — all sets if they had the same load, otherwise the bot asks which sets. `/undo` removes the last group. Always confirm what changed.
- **Makeup sessions:** if I log items from another day's session, the bot asks "Monday's session?". `session_date` = the planned date, `performed_at` = when I actually did it.
- **Day boundary:** messages before 03:00 belong to the previous day.
- **OR items** — whitelist only: "Squat / hack squat", "Cable / machine row", "Curl OR triceps extension", "Hanging leg raise / knee raise", "Easy pull-down / hang", "Easy press back-off: OHP or bench" (bench = barbell bench press). A slash is **not** always an OR ("Lower pad / harder progression", "30s hard / 90s easy", "ROM / pad height"). If I don't say which option, ask with buttons.

### 5.4 Thursday class
- Thursday at 21:00 Europe/Rome the bot asks how the class went (skip if already logged).
- I reply with text, voice, or a **photo of the blackboard**. Parse it into exercises, sets and reps, then ask which parts were heavy (buttons: Pull / Push / Legs — the three groups Friday's rules use).
- This feeds Friday's auto-regulation.

### 5.5 Plan changes
- Swapping an exercise: if I don't say the scope, ask with buttons — **"Only today"** or **"Rest of plan"**. If the exercise appears on more than one day (e.g. squat Tue + Fri), "rest of plan" also asks "this day only / every day". The replacement **inherits the tags** of the item it replaces (so Friday rules keep working).
- Plan changes create a new **plan version**. Old log entries keep pointing to the exercise and version they were done with. Never rewrite history.
- Always show the change and ask for confirmation before saving.
- Alternatives ("what can I do instead of X?") come from Claude's general knowledge, filtered to fit the session's goal (same movement pattern).

### 5.6 Morning message
- 06:00 Europe/Rome on training days (Mon–Fri). Quiet on Sat/Sun.
- Content: week + phase, day focus, exercises with sets × reps and suggested load (or "baseline — tell me your weight"), estimated duration, and any Friday adjustment from Thursday. Short.
- Built in M8 (design: `docs/superpowers/specs/2026-10-18-m8-morning-charts-design.md`):
  - Sent by the 15-min tick when Rome time is 06:00–10:00 Mon–Fri; a missed morning is not sent after 10:00. Skipped when something is already logged for the day, before the plan starts and after it ends, except one "plan finished" message on the first weekday after the plan.
  - The text is exactly `/today` at that moment (greeting on top, the 😴 / 🙂 / 💪 buttons at the bottom), so rendering it freezes the day's readiness like a 06:00 `/today`.
  - A button tap re-freezes the level until the first log of the day (the 5.6c rule) and edits the morning message in place ("Noted: 😴" + the re-rendered session). After the first log the tap counts for tomorrow ("Noted: 😴 · counts for tomorrow"). A tap from another day writes nothing.
  - Friday with Thursday not reported: the class card comes first, then the session; saving the card on that Friday sends the session again with the Friday adjustments.

### 5.6b Weekly check-in
- Triggered by `/done` on Friday, or Friday 20:00 Europe/Rome if not done (weekends stay quiet): ask for the weekly metrics in `weekly_progress_metrics` that weren't already logged (the plan's `weekly_progress_metrics`: max clean pull-ups, weighted top set, HSPU level/ROM + reps, OHP / bench / squat top sets, recovery 1–5) **plus bodyweight**, which is my addition — not in the plan file.
- Bodyweight is also asked at **setup**, and again before a pull-up suggestion if the latest value is > 14 days old.
- Recovery ≤ 2 → next week, suggest cutting optional accessories and HIIT volume first (plan rule; the ≤ 2 threshold is mine).

### 5.6c Fatigue-based plan changes
The bot **proposes** changes when I'm tired; it never applies them silently.

Signals (combine them in code into a readiness level: GREEN / YELLOW / RED):
- One-tap readiness on the morning message: 😴 / 🙂 / 💪 (optional — no answer = no signal).
- What I say in chat ("slept badly", "legs are dead") — Claude extracts it and calls `log_readiness`.
- Weekly recovery score (1–5).
- Performance drift (rep-capacity formula): at the stored suggested load, `reps_done + RIR_logged ≤ reps_min + rir_mid − 2`. This catches both "RIR 0 at target reps" and "missed reps". (Compared with the target, never with "last time" — that gives false alarms right after a deload.)
- Heavy Thursday class (already handled for Friday).

Level formula (exact):
- Each signal counts once: 😴 button · chat says bad sleep / soreness / exhausted · weekly recovery ≤ 2 · drift on one lift.
- 0 signals → GREEN. 1 signal → YELLOW. 2+ signals, or drift on 2+ lifts in the same session → RED.
- 💪 button cancels chat signals of the same day. 🙂 adds nothing.
- Chat and button signals expire after 24 h; recovery score after 3 days; drift after the next session of that lift.
- **The level is computed once, at the start of the session** (first log of the day, or `/today` after 05:00) and frozen for that session. Drift during a session affects the **next** session only.
- Heavy Thursday is **not** a readiness signal (Friday rules already handle it — no double counting).
- YELLOW and RED sessions are excluded from drift; only RED is excluded from e1RM.
- "Easy volume" under RED = 2 sets at RIR 3–4. RED on Thursday: the morning message says "go easy in class or skip it".

Actions are rule-based, following the plan's priority order:

| Level | Action |
|---|---|
| GREEN | Plan as written |
| YELLOW | Drop `Low` priority items, HIIT rounds halved (rounded down, e.g. 8 → 4), main lifts: same reps, load recomputed at RIR 2.5 |
| RED | Only `skill_strength` (pull-up, HSPU) + `skill_practice` (handstand) at easy volume + mobility; HIIT removed (Wednesday's PRIMARY is HIIT, so never filter by priority). **Friday has none of these → suggest a rest day.** |
| RED 2+ sessions in a row, or recovery ≤ 2 for 2 weeks | Suggest moving the next deload earlier (plan change → needs confirmation) |

Claude explains the proposal in one or two sentences; I accept, adjust or ignore with buttons. Pull-up / HSPU skill work is the last thing cut (plan rule).

### 5.6d Confirmation policy
Reads never need confirmation. Writes follow these rules, **enforced in code, not left to the model**:

Execute directly, then echo with an `Undo` button:
- one clear log entry for an exercise that matches today's session

Ask for confirmation (show exactly what will be saved, buttons ✅ / ✏️ / ❌) when ANY is true:
- more than one write in the same message
- the exercise doesn't match today's session or matches more than one exercise
- a required field is missing or the model marks it as a guess
- a number is far off — **system load** > 20% from the stored suggestion (or the last logged session if none; no check if neither exists), with a minimum gap of 2 equipment steps; or reps ×2 — often a voice transcription error ("15" vs "50")
- any plan change, swap, skip of a PRIMARY item, or delete
- any proposal from 5.6c
- the model's own `needs_confirmation` flag is set

Pending actions expire after 30 minutes. Never execute half of a multi-step intent. Buttons carry the pending action ID: a newer pending action replaces the older one **and the bot says so** ("previous request cancelled: …"); tapping ✅ on a replaced or expired one replies "this expired, nothing saved".

### 5.6e Memory (agent context)
History stays in the log tables and is reached through tools — **never copied into memory**. Memory is a small set of facts that make the agent better:

- **Aliases** learned from my answers: when the bot asks "which exercise?" and I answer, save the mapping ("FP" → Face pull). Fewer questions over time.
- **Preferences:** e.g. preferred substitutes, cable face pulls over band, how I like replies.
- **Equipment:** the bot can *propose* changes ("cable step is 2.5 kg?"), but the values live in the `equipment` table that the math reads — not in deletable memory.
- **Limitations:** e.g. "left shoulder sensitive on dips" — used to filter alternatives and suggestions.
- **Weekly summary** (auto, Sunday): 3–5 lines on what happened (adherence, PRs, fatigue). Feeds trend questions and the Phase 2 plan generator.

Rules:
- Every new memory item is shown to me ("Saved: …") with an `Undo` button. Limitations and preferences need confirmation; aliases from an explicit answer don't.
- Memory is injected into the system prompt, capped (~1,500 tokens); oldest weekly summaries roll off first.
- `/memory` lists everything; I can delete any item.
- Memory never overrides plan rules or progression math.

### 5.7 Commands
Chat is the main interface; commands are fast shortcuts and a fallback when parsing fails. Register them with `setMyCommands`.

| Command | What it does |
|---|---|
| `/today` | Today's session with suggested loads; Friday shows Thursday adjustments |
| `/next` | Next exercise not yet logged today |
| `/session <day\|date>` | A specific session, e.g. `/session mon` (for missed ones) |
| `/week` | This week: phase, days, done / skipped status |
| `/short` | Today's session in short-on-time mode |
| `/skip` | Skip an exercise or the whole session (buttons) |
| `/done` | Close today's session and get a summary |
| `/undo` | Remove the last logged entry |
| `/swap` | Swap an exercise (asks: only today / rest of plan) |
| `/class` | Log the Thursday class (text, voice or blackboard photo) |
| `/checkin` | Weekly metrics + recovery 1–5 |
| `/readiness` | How I feel today (😴 / 🙂 / 💪) → adjusted session |
| `/memory` | What the bot knows about me; delete items |
| `/history <exercise>` | Last sessions for an exercise |
| `/chart <exercise>` | Progress chart as an image; `/chart volume` = weekly sets per muscle group; `/chart` alone shows buttons |
| `/plan` | Plan overview: week, phase, what's coming next |
| `/export` | Send me a JSON + CSV backup of all data (also sent automatically every Sunday — Supabase free has no point-in-time restore) |
| `/help` | List of commands and example phrases |

### 5.8 Replies
- Short, simple English (I'm not a native speaker). Reply in the language I write in.
- Charts when I ask about trends: load over time, reps over time, weekly volume per muscle group.
  - Load over time = e1RM per session (the engine's valid-set rules; deload/test weeks shaded, imported sessions drawn as estimates; pull-ups on system load). Reps over time = most reps in one set (HSPU: one series per ladder step; timed: longest hold). Pull-ups show both panels. Weekly volume = hard sets per plan week per muscle group (weighted, bodyweight_plus, bodyweight_reps, skill_ladder).
  - Rendered in the webhook: Vega-Lite spec → SVG (Vega, headless, pure JS) → PNG with `@resvg/resvg-js` (prebuilt binaries, no native build) and a bundled OFL font (Inter). No hosted chart service: the data never leaves the app.

## 6. Data model (starting point — refine in plan mode)

- `plans` (id, name, start_date, weeks)
- `plan_weeks` (plan_version_id, week, phase, is_deload, is_test). "Move the next deload earlier" = **insert** a deload week next week and shift every later week by one (the plan ends a week later; the next scheduled deload is removed if it's now < 3 weeks away). Never reorder weeks — progression order stays intact. New plan version.
- `plan_versions` (id, plan_id, created_at, **effective_from** date, reason) — past sessions always render with the version effective on their date
- `exercises` (id, name, aliases[], muscle_group, equipment_id, load_basis, is_main_lift, type: weighted | bodyweight_plus | bodyweight_reps | skill_ladder | timed | distance | skill_practice | hiit | mobility) — **canonical**: plan variants like "Weighted pull-up*", "Weighted pull-up — deload*" map to one exercise; the variant lives on the planned item.
  - **"OR" items are the opposite case** — "Squat / hack squat", "Cable / machine row", "Curl OR triceps extension", "Hanging leg raise / knee raise" are *different* exercises with loads that can't be compared. The planned item lists the allowed options; the log records which one I did (ask with buttons if unclear). History and progression are per option.
- `planned_items` (plan_version_id, week, weekday, order, block, exercise_options[] (1 or more for OR items), variant_label, prescription_raw, sets_min, sets_max, reps_min, reps_max, per_side, duration_s, rir_min, rir_max, extras_raw (e.g. "+ 1 easy BW set" → its own sub-item), tags[] (skill_strength, skill_practice, row, horizontal_press, squat, unilateral_leg, hiit, mobility…), rest_raw, priority, note, time_estimate, fallback_prescription) — keep `prescription_raw` exactly as in the plan file; anything that fails to parse is flagged for my review, never guessed.
- `session_overrides` (date, planned_item_id, replacement_exercise_id) — one-off swaps
- `session_items` (session_date, planned_item_id, status: planned|done|modified|skipped, chosen_exercise_id, note) — powers `/week`, `/next`, `/done`, adherence
- `log_groups` (id, session_date, performed_at, planned_item_id, sub_item, exercise_id, suggestion_id, bw_kg, readiness_level, source: text|voice|photo|import, import_row_key, created_at) — one "I just did X" exercise = one group. `/undo` and "edit last" act on the **last group**, not a single set.
- `write_ledger` (source_key, action_index, created_at) — unique (source_key, action_index)
- `suggestions` (id, session_date, planned_item_id, sub_item, exercise_id, sets, reps, rir_min, rir_max, added_kg, assist_kg, system_load, e1rm_used, labels[], created_at)
- `user_state` (pullup_gate_open, pullup_gate_since, hspu_step, hspu_pad_height, updated_at) — a **cache derived from history** (see 5.2), never edited directly.
- `hspu_ladder` (step, name, order, default_sets, default_reps_min, default_reps_max, tempo)
- `log_entries` (id, group_id, set_index, reps, load_kg (non-BW lifts), added_kg, assist_kg, duration_s, distance_m, pad_height, rir, clean, note)
- `bodyweight_logs` (date, kg)
- `weekly_metrics` (plan_week, metric, value_num, value_text, unit, source, import_row_key) — weekly check-in values (5.6b) and imported progress
- `equipment` (id, name, step_kg, discrete_values[] for stacks/dumbbells, bands jsonb colour → kg) — the only source of rounding steps
- `inbox` (update_id unique, payload, status: pending|processing|done|failed, claimed_at, claimed_by, attempts, error) · `chat_lease` (chat_id, owner, until) · `job_runs` (job, date, status, claimed_at)
- `usage_logs` (date, input_tokens, output_tokens, stt_seconds) — cost guard
- `class_logs` (date, raw_text, photo_file_id, parsed jsonb, heavy_groups[])
- `readiness_logs` (date, level, source: button|chat|derived, note)
- `memory_items` (id, kind: alias|preference|limitation|weekly_summary, content, structured jsonb, created_at, confirmed, active)
- `pending_actions` (id, actions jsonb, reason, created_at, expires_at, status)
- `conversation_state` (short rolling context: last ~10 messages)

## 7. Claude tools (starting point)

`get_session(date)`, `log_readiness(...)`, `propose_adjustment(date)`, `save_memory(...)`, `list_memory()`, `get_exercise_history(exercise, range)`, `suggest_load(exercise, date)`, `log_sets(...)`, `edit_last_entry(...)`, `undo_last_entry()`, `swap_exercise(exercise, replacement, scope)`, `get_alternatives(exercise)`, `log_class(...)`, `render_chart(metric: load | reps | volume, exercise?, weeks?)` (read tool: returns the computed numbers, the image is sent after the reply; one chart per message).

Tool results return computed facts. Claude never invents a number that isn't in a tool result.

## 8. Milestones

Each milestone ends with tests passing and a short demo script I can run from Telegram.

0. **Setup:** repo, TS, lint, Vitest, Drizzle + Supabase, Vercel project, env schema. Show me the manual steps I must do (BotFather, Supabase, API keys, webhook registration).
1. **Plan import:** load `seed/hybrid-strength-plan.json` (provided — 12 weeks, 35 exercise names incl. variants). Prescriptions are free text ("4 × 3", "Dead hang 2×25s · scapular pull-up 2×8 · …"), so parse them into structured fields; multi-move warm-ups stay as one item with raw text. Build the canonical exercise list. **Show me the parsed table and the exercise mapping for review before seeding.** Anything that fails to parse is flagged, not guessed.
1b. **History import (moved up):** inspect the old tool's **Export** format first and show me a mapping. Import logs **and** weekly metrics (the pull-up gate needs them). Convert loads to the unit convention (5.2) and show the converted values in a review table before saving. Weeks 1–3 are my only non-deload baseline.
2. **Telegram skeleton:** webhook (fast ack + `waitUntil`), auth, idempotency, per-chat lock, `/today`, `/week`.
3. **Text logging:** Claude intent + `log_sets`, RIR buttons, edit/undo, **confirmation policy (5.6d)**, aliases memory.
4. **Queries:** today's session, history, alternatives.
5. **Progression + fatigue engine:** e1RM, suggested load, pull-up gate, HSPU proposal, Friday tags, readiness levels (pure functions, heavy unit tests). **Target: live before W9 (23 Nov).** W5 (26 Oct) weights are set manually — rushing M5 into 9 days is how wrong numbers ship. Until M5 is live, the bot logs and answers questions but shows no suggested loads.
6. **Voice + photo:** Whisper, blackboard parsing, Thursday flow.
7. **Plan changes:** swaps with scope, versioning.
8. **Morning message + charts.**
9. **Hardening:** cost guard, weekly backup, **restore from a backup file** (reuses the import path), error messages in chat when a tool fails.

**Transition — one source of truth:** import the old tool's history **once**, then stop using the old tool the day M3 (logging) goes live. Target M3 live during W5–W6, so W5–W8 are logged by the bot with full data (per-set reps, RIR, clean, bodyweight) — that's what W9's first suggestions run on. If a re-import is ever needed, it deletes and replaces only `source = import` rows (matched by `import_row_key` = old tool's date + exercise name + row index, mapped to plan version 1), so it can never duplicate bot logs.

## 9. Tests that must exist

- Progression: e1RM from valid sets only; Tue and Fri squat get different loads from the same e1RM; deload and test weeks don't change e1RM; misses lower the suggestion; break ≥ 10 days → −10%; rounding toward easier to the equipment step (incl. bands, per-hand dumbbells); a "4+" set can raise e1RM but never lower it.
- Pull-up: system load = BW + added − assist; gate opens on 6 clean, stays open through weighted weeks and deloads, closes on e1RM rule; closed gate shows the fallback 4 × 4–6; max test runs first.
- **Break rule: W5 Monday and W9 Monday with full W1–W4 / W5–W8 history show NO break label and NO −10%.** Break cut on pull-ups touches added weight only.
- HSPU: state from last log; advance proposal only after 2 clean sessions; deload doesn't advance.
- Units: per-hand dumbbells never mixed with pairs; rounding toward easier for negative loads.
- Hand-simulation fixtures: 26 Oct, 30 Oct (heavy legs), 23 Nov — expected suggestions written by me and checked in the M5 review.
- RED never keeps HIIT; Friday rules hit tagged items.
- Dates: the Monday 26 Oct 06:00 tick (first weekday after the DST change); week number from start date 2026-09-28; Sunday → no session; after week 12 → "plan finished" message.
- Deload: logs in W4/W8 don't count as baseline and don't trigger increases.
- OR items: logging "hack squat" never updates squat history.
- Concurrency: two messages together → processed in order; a crash mid-row → row reset after lease expiry and retried in order; a retry after a successful write → ledger says done, no duplicate, no "failed"; one message logging 2 exercises → 2 groups, no key clash; another owner can't renew or release my lease; stale ✅ does nothing.
- Derived state: `/undo` of the set that opened the pull-up gate closes it again; re-import rebuilds the HSPU step.
- Break rule: "Curl OR triceps" alternating weekly never triggers a break; deload weeks never trigger a break.
- Readiness: level frozen at session start; drift in one session never changes the same session.
- Import: re-running the import creates no duplicates.
- Friday adjustments for each Thursday heavy combination.
- Golden conversations: ~20 example messages (incl. my examples in section 1) → expected tool calls. Run against the real model in a separate, opt-in test suite.
- Webhook: duplicate `update_id` is processed once; wrong user ID is ignored.
- Confirmation policy: each trigger in 5.6d produces a pending action, not a write; single clear log writes directly; expired pending actions do nothing.
- Fatigue: each readiness level produces the expected session changes; skill work is cut last.
- Memory: cap respected; deleted items never reach the prompt.

## 10. Phase 2 (do NOT build now)

- Upload a new plan when the 12 weeks end.
- Bot generates the next 12-week block from my history and goals.
- Web dashboard.
