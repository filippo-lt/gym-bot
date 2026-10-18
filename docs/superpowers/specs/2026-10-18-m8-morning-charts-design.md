# M8: Morning message and charts

_Design, 18 Oct 2026. SPEC.md stays the source of truth. This document records what M8 adds and the decisions behind it. The user skipped the design questions and left the calls to Claude ("you decide"), so every decision below is **Claude's call**, and the user can overturn any of them in review. "Builder's call" marks what is left to the implementer._

## Why

The user trains Mon–Fri at 06:00-ish and logs by voice mid-workout. Today they have to remember to type `/today` to see the session and the suggested loads. M8 sends the session to them at 06:00 with the readiness buttons on it, so the session's readiness is set from one tap before the first set. M8 also answers "am I getting stronger?" with a picture instead of a table: `/chart` and trend questions in chat return a chart image.

## Goals

1. **Morning message**, Mon–Fri at 06:00 Europe/Rome: today's adjusted session (the same content as `/today`) plus the 😴 / 🙂 / 💪 readiness buttons. Nothing at weekends, before the plan starts or after it ends, except a one-off "plan finished" message on the first weekday after week 12.
2. **Friday**: if Thursday's class wasn't reported, the morning message asks about it first (the class card), then shows the session.
3. **`/chart <exercise>`**: a PNG with load over time (e1RM and top set) and reps over time. **`/chart volume`**: weekly volume per muscle group.
4. **Trend questions in chat** ("how is my squat going?", "show me my bench chart") → the `render_chart` tool (SPEC §7) → the same chart image plus a short reply.

## Non-goals

- **`/done`, `/checkin`, the Friday 20:00 weekly check-in (SPEC 5.6b) and the Sunday summary (5.6e).** None exist yet. Claude's call: keep them out of M8. They are a separate feature with their own design questions (which metrics to ask, how to ask them one tap at a time, how recovery ≤ 2 feeds next week). They become their own milestone after M9 (see "Follow-up").
- The Sunday backup job (M9).
- Charts of anything other than the three SPEC 5.8 metrics (no bodyweight chart, no readiness chart, no class chart).
- Changing what `/today` shows. The morning message reuses it.
- A web dashboard (SPEC §10, Phase 2).

## Anti-goals (would be a failure even if it works)

- The morning message showing a different session, load or readiness level than `/today` at the same moment.
- A morning message on a Saturday or Sunday, two morning messages on the same day, or the 26 Oct message arriving at 05:00 or 07:00 (DST ended on 25 Oct).
- A chart, caption or reply with a number the model made up. Every number in the image and the caption comes from code. The model only phrases the text reply, and the number guard still applies to it.
- A chart that mixes units: dumbbells per hand next to barbell totals, or an OR item's options on one line ("hack squat" is not "squat").
- A renderer that needs a native build (node-gyp, cairo) or a third-party service that receives the user's data.

## Decisions (Claude's calls)

### Morning job

- New job `morning` in `src/jobs/`, registered additively in `JOBS` (M9 adds its own job in the same array).
- **Window:** Mon–Fri, 06:00 ≤ Rome local time < 10:00. Computed with Luxon in `APP_TIMEZONE`, like `class_question`. The cron tick runs every 15 min, so the first tick at or after 06:00 sends it. After 10:00 a missed morning is not sent: the user is at work by then and `/today` exists.
- **Due date:** the Rome calendar date (not `trainingDate`; at 06:00 they are the same day).
- **When it sends (`run`):**
  - The plan week for the date is `active` → send the morning message.
  - The plan is `finished`, and the date is the first Monday–Friday after the plan's last day (2026-12-21 for the current plan) → send `formatFinished()` once. Any other finished date → `skipped`.
  - `before_start` → `skipped`.
  - A log group already exists for today (the user started before 06:00) → `skipped`.
- **Content:** exactly what `/today` renders at that moment: `getSession(date)` + `loadSessionAdvice(date, now)` + `formatSession(...)`. No query on `planned_items`, so M7's plan versions flow through when they land. A one-line greeting goes on top ("☀️ Good morning."), and the readiness question with the three buttons goes at the bottom. The `/today` text is already compact (one line per exercise); M8 doesn't build a second, shorter format.
  - Because it is after 05:00, `loadSessionAdvice` freezes the day's readiness and stores today's suggestions, exactly as a 06:00 `/today` would. This is intended.
  - If the progression engine throws, the plain session is sent (same rule as `bot.ts` `advise()`).
- **Friday, Thursday not reported:** `loadSessionAdvice` already sets `askClassFirst`. The job then sends **two messages**: first the class card for that Thursday (`classCard(thursday, 0)`, with the same text as the Thursday question), then the morning message. The morning message keeps its existing "How was Thursday's class? /class" line.
- **After the class card is saved on the Friday after that Thursday,** the bot also sends today's session again, now with the Friday adjustments. This is a small change in `classTap` and applies whether the card came from the morning message or from `/class`.
- **RED Thursday:** `levelLines` already prints "Go easy in class tonight, or skip it." (`classAdvice`). Nothing new.
- **HSPU advance card:** not sent by the morning job. It still appears on `/today` and after logs.

### Readiness tap on the morning message (the M5 freeze rule, unchanged)

The M5 rule stays: a tap re-freezes today's level until the first log of the day. After the first log, today keeps its level and the tap counts for tomorrow ("You already started today, so today stays X. I'll use this tomorrow."). The morning job froze the level at 06:00 from the signals it had, and a tap before training simply recomputes it. That is the point of putting the buttons on the morning message.

What changes is only the display:

- The morning buttons carry a marker: `rd:<t|o|s>:m` (the old `rd:<t|o|s>` stays valid for `/readiness` and for messages already sent).
- On an `:m` tap the bot **edits the morning message in place**: the greeting, a "Readiness: 😴" line, then the session re-rendered with the new level, with no buttons. It doesn't send a separate "Noted" message plus a second `/today`. If the user already started, the "today stays X" line is sent as a separate reply, as today.
- Telegram doesn't allow editing a message older than 48 h. A stale tap (from a past day) answers "That button is from another day." and writes nothing. The tap's training date must equal the message's date. Builder's call: the date can go in the callback data (`rd:<l>:m:<yyyymmdd>`) to make the check exact. Keep the data ≤ 64 bytes.

### Charts: what is plotted

All series are computed by pure functions from the log tables (bot and import rows alike), one exercise id at a time. OR options are separate exercises (SPEC 5.2), so "squat" never includes hack squat. Every point is one session (`session_date`).

`/chart <exercise>` sends **one image with up to two stacked panels**, chosen by the exercise `type`:

| Type | Top panel: load over time | Bottom panel: reps over time |
|---|---|---|
| `weighted`, `bodyweight_plus` | e1RM per session (the engine's `sessionEstimate` over `validSets`, so the chart matches the math) and the top set's load | most reps in one set, plus total reps (bars) |
| `bodyweight_reps` | no panel | most reps in a set + total reps |
| `skill_ladder` (HSPU) | no panel | reps per session, one colour per ladder step (SPEC 5.2: "charts are per ladder step") |
| `timed` | no panel | longest set in seconds |
| `distance` | no panel | the distance per session (builder's call on the exact metric) |
| `skill_practice`, `hiit`, `mobility` | — | — : text reply "Nothing to chart for X: it's logged as done / skipped." |

- **Units** follow SPEC 5.2 and are stated on the axis: barbell = total incl. bar; dumbbells = "kg per hand"; machines = stack value; pull-ups = system load (bodyweight + added − assist). The pull-up axis title says "system load". A session without a known bodyweight has no pull-up load point (it can still have a reps point).
- **e1RM points** follow the engine's rules (RED sessions, deload and test weeks don't count, and a set without RIR doesn't count). So a session can have a top-set point and no e1RM point. Deload/test sessions are drawn differently, e.g. hollow points (builder's call on style).
- **Fewer than 2 sessions** with data → no image, text "Not enough data to chart X yet (N session)."
- **Range:** all history by default (the plan is 12 weeks, plus the imported weeks). The chat tool can ask for the last N weeks.
- **Caption** (code-formatted, ≤ 1024 chars): exercise name, the first → last e1RM (or reps) with dates, and the session count, e.g. "Squat · e1RM 85 → 93 kg · 7 sessions since 29 Sep".

`/chart volume`: **weekly volume per muscle group** = the number of logged sets per plan week, per `exercises.muscle_group`, as stacked bars, W1 … the current week. It counts exercise types `weighted`, `bodyweight_plus`, `bodyweight_reps`, `skill_ladder`, `timed`. Warm-ups, mobility, HIIT and handstand practice are excluded. Weeks with no logs show as empty bars. Builder's call: if imported groups lack per-set rows, count their stated set count and document it. The caption gives the current week's total sets.

`/chart` with no argument → a usage line: `/chart squat`, `/chart pull-up`, `/chart volume`. An unknown or ambiguous name uses the same lookup and choice buttons as `/history` (`lookupExercise`), with a new callback prefix `ch:<exerciseId>`.

### Charts: in chat (`render_chart`)

- A read tool in the AI loop: `render_chart({ metric: "load" | "reps" | "volume", exercise?: string, weeks?: number })`.
- The tool resolves the exercise, builds the series, and returns the **computed facts** to the model (first/last/best values with dates, session count). It also records a pending chart on the turn. It doesn't send anything itself.
- After the loop, the flow sends the reply text, then the chart photo (code caption). At most one chart per message; a second call in the same turn returns "one chart per message" to the model.
- `metric: "load"` and `"reps"` render the same two-panel image as `/chart`, minus the panel not asked for. `"volume"` renders the volume chart.
- Unknown / ambiguous exercise → the tool result says so with the candidates. The model asks; no image.
- Voice works through the same path: a read, so no card. The reply gets the "🎤 heard" prefix as today.

### Renderer (Claude's call, verified with a spike on Node 24)

**Vega-Lite spec → SVG with Vega's headless renderer (pure JS, `renderer: "none"`, `view.toSVG()`) → PNG with `@resvg/resvg-js`.**

- Vega and Vega-Lite are plain JavaScript (ESM). In Node, Vega renders SVG with no `canvas` package.
- `@resvg/resvg-js` is a Rust SVG renderer shipped as **prebuilt napi-rs binaries per platform** (linux-x64-gnu on Vercel, darwin-arm64 locally, linux on CI). Install compiles nothing and needs no system libraries.
- Vercel's Linux image has no usable fonts, so a font file is bundled in the repo (an OFL font such as Inter or DejaVu Sans, with its license file) and passed to resvg with `loadSystemFonts: false`. The font must be in the function bundle: either Vercel's file tracing picks up a static `new URL("…", import.meta.url)` read, or it is listed in `vercel.json` `includeFiles` for `api/telegram.ts` (builder verifies which, and adds `includeFiles` if unsure).
- Spike result (local, Node 24.13, Arial, no system fonts): one line chart, 800×400 at 2× zoom → 100 KB PNG in 86 ms, cold. Time axes need explicit formatting (the default produced "12 PM" ticks), so use dates or week labels as formatted strings.
- Alternatives rejected:
  - `chartjs-node-canvas`: needs the native `canvas` package (cairo, node-gyp), the classic Vercel build failure.
  - QuickChart.io and similar services: the user's training data goes to a third party, and the chart depends on someone else's uptime.
  - `@napi-rs/canvas` + Chart.js: also prebuilt, but imperative drawing code and DOM shims in Node. Vega-Lite specs are short, declarative and easy to snapshot-test.
  - Hand-written SVG: the most control, but we'd rebuild axes, ticks, legends and date labels.
  - `@resvg/resvg-wasm`: no native binary at all, but needs explicit wasm init and bundling of the `.wasm` file. Kept as a fallback if the napi binary ever fails to load on Vercel.

### Sending images

- grammY `replyWithPhoto(new InputFile(png, "chart.png"), { caption, parse_mode: "HTML" })` for commands and chat. Builder's call: a `Photo` variant next to `Message` in `log-format.ts`, or a separate helper.
- PNG width ~1000 px (Telegram compresses photos; 2× zoom of an 800-wide chart is fine).
- Rendering runs inside the webhook invocation (≈ 0.1 s; well inside the 90 s `maxDuration`). No follow-up job needed (SPEC §3 allows one if needed).

## Constraints (from the codebase and SPEC)

- Numbers: everything shown is formatted in code. Series values are rounded for display with the same helpers as `/history` (builder's call to reuse `src/bot/query-format.ts` or `log-format.ts` helpers).
- Callback data ≤ 64 bytes. New prefixes: `rd:<l>:m[:<yyyymmdd>]`, `ch:<exerciseId>`. Document them in CLAUDE.md with the others.
- `bot.ts` `sendSession` is likely touched by M7. M8 doesn't change it. The morning text is built in a new function that calls `getSession` + `loadSessionAdvice` + `formatSession`, and `/today` keeps its own path. Builder's call: a shared `renderToday(db, date, now)` in a new file, used by the job and by the `:m` tap re-render.
- Jobs: `run` returns `"sent" | "skipped"`; `JobContext.send` sends one `Message` (text + keyboard). The Friday class card is a second `send` call in the same run. Mark-done after both, like today (the known "send twice if mark-done fails" issue stays as is).
- `/chart` must be registered in `scripts/telegram-setup.ts` `setMyCommands` and in `HELP_TEXT`. Re-running `pnpm telegram:setup` against production is a user step.
- No migration is expected (`job_runs` exists). If one turns out to be needed and M7 or M9 lands a migration on `dev` first, sync with `dev` and regenerate.
- Environment: no new env vars.

## Tests (beyond SPEC §9, which still applies)

- **Morning window** (pure): Mon 26 Oct 2026 05:00Z (06:00 CET, after DST ended on 25 Oct) → due; 04:45Z → not due; Fri 23 Oct 04:00Z (06:00 CEST) → due; 09:45 local due, 10:00 local not; Sat/Sun never.
- **Morning run** (db): active weekday → one message with the session text and three `rd:…:m` buttons, readiness frozen, suggestions stored; second tick same day → `busy`/no send; a log group exists → skipped; before start → skipped; first weekday after week 12 → "plan finished" once, the next weekday → skipped; Friday with Thursday not reported → class card then session; Friday with Thursday reported → session only; RED Thursday → the class advice line.
- **Morning text equals `/today`** at the same `now` (minus the greeting and the readiness block).
- **`:m` tap** (db): before the first log → level re-frozen, the morning message edited in place with the new level; after a log → today unchanged, "today stays" reply; stale date → nothing written.
- **Class card Save on Friday** → today's session sent afterwards; on another day → not.
- **Chart series** (pure): e1RM points only from valid sets, deload/test points flagged, OR options never mixed, pull-up system load needs bodyweight, HSPU per step, volume counts per muscle group per plan week with the excluded types left out, < 2 sessions → no chart.
- **Vega-Lite spec builders** (pure, snapshot): axis titles carry the unit basis ("kg per hand", "system load").
- **Render smoke test** (unit): PNG magic bytes, width as configured, with the bundled font and no system fonts.
- **`/chart`** (bot test with the transformer): sends `sendPhoto`; no argument → usage; ambiguous → `ch:` buttons; `ch:` tap → photo.
- **`render_chart`** (fake model): tool result has the facts, the flow sends text then one photo; a second call in a turn is refused.

## Left to the builder

- The exact Vega-Lite styling (colours, point shapes, how deload weeks look, label density), within "readable on a phone".
- Whether the two panels are a Vega-Lite `vconcat` or two separate charts composed in SVG.
- Font choice (OFL) and how it gets bundled on Vercel.
- The exact caption wording, within the content above.
- Where the chart data loaders live (suggested: `src/charts/` with `series.ts` (pure), `load.ts` (DB), `spec.ts` (Vega-Lite), `render.ts` (SVG → PNG)).

## Follow-up (not M8)

- **Weekly check-in and closing the week:** `/done`, `/checkin`, the Friday 20:00 check-in job (SPEC 5.6b), the recovery score feeding readiness, and the Sunday summary into memory (5.6e). Proposed as its own milestone.
