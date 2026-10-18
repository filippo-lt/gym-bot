# M7 demo: plan changes (Telegram)

Do this on a weekday (Mon–Fri). On a weekend there is no session today, so "only today" swaps go to the next session that has the exercise (the card names the date). Undo each change at the end of its step, so the plan stays as it was.

Plan facts used below (from `seed/hybrid-strength-plan.json`): Face pull is on Friday only. "Squat / hack squat" is on Tuesday and Friday. Bulgarian split squat is on Friday.

1. **Help.** Send `/swap`.
   Expect: a short hint ("Tell me what to swap, e.g. ...") and today's exercise names.

2. **Swap for one day.** Send `swap face pulls for band pull-aparts only today`.
   Expect: a card "Swap for <date>: Face pull → Band pull-apart ...", then "New exercise: Band pull-apart · reps only (no load math)." if it is not in the catalog yet. Tap ✅.
   Expect: "Saved. ..." with an Undo button.
   Send `/today` (on a Friday) or `/session fri`. Expect the Band pull-apart with "(instead of Face pull today)".
   Tap Undo. Expect "Undone. The plan is back as it was." `/today` shows Face pull again.

3. **Swap for the rest of the plan, one weekday.** Send `from now on use band pull-aparts instead of face pulls`.
   Face pull sits on Friday only, so there is no days question. Expect a card "From <date>, Face pull → Band pull-apart on Fri (N sessions)...". The date is tomorrow or later, never today's past. Tap ✅, then send `/plan`.
   Expect: a "Changes" line for the swap. Tap Undo (on the "Saved." message). Expect "Undone."

4. **Exercise on two weekdays (days question).** Send `from now on use leg press instead of hack squat`.
   Squat / hack squat is on Tuesday and Friday, so expect the question "Only Tuesdays / Every day" (or Fridays, from the day you are on). Tap one.
   Expect the card with the from-date and the session count. Tap ✅, check `/plan` (Changes line), then Undo.

5. **Scope question.** Send `swap bench press for dumbbell press` (no scope).
   Expect buttons "Only <date> / Rest of plan". Tap ❌ on the card at the end so nothing is saved.

6. **Refusal check (optional).** Log a set of face pulls first, then try step 2 the same day.
   Expect "You already logged face pulls today; nothing changed."

7. **Deload card.** It cannot be triggered on demand: it needs two RED sessions in a row (or two low recovery scores). To see it, send 😴 in `/readiness` on two training days in a row, then open `/today`: a separate card "You've been tired 2 sessions in a row. Move the deload earlier?" with ✅ Move deload / ❌ Not now. The card is not offered when next week is a deload or the test week. This flow is covered by tests; try it live only if you want to change your plan. After ✅, tap Undo on the "Saved." message.

Cleanup: every step above ends with Undo or ❌. Undo only works until the change is used (a log, suggestion or session item on it). If it says "Too late to undo", swap back with a new swap.
