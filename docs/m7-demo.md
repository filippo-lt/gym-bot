# M7 demo: plan changes (Telegram)

Do this on a weekday (Mon–Fri). On a weekend there is no session today, so "only today" swaps go to the next session that has the exercise (the card names the date). Undo each change at the end of its step, so the plan stays as it was. A one-off swap on a later day is kept when a new plan version is saved; if that day no longer has the exercise, the reply says so.

Plan facts used below (from `seed/hybrid-strength-plan.json`): Face pull is on Friday only. "Squat / hack squat" is on Tuesday and Friday. Bulgarian split squat is on Friday.

1. **Help.** Send `/swap`.
   Expect: a short hint ("Tell me what to swap, e.g. ...") and today's exercise names.

2. **Swap for one day.** Send `swap face pulls for band pull-aparts only today`.
   Face pull is on Friday only. On other days the card uses the next Friday and names its date; "today" in the text is that date.
   Expect: a card "Swap for <date>: Face pull → Band pull-apart (3 × 15, same tags). Nothing else changes." plus, if Band pull-apart is not in the catalog yet, "New exercise: Band pull-apart · <how it was classified>." The classification (for example "reps only (no load math)") is chosen by the model, so read that line before you tap ✅. Tap ✅.
   Expect: "Saved. ..." with an Undo button.
   Send `/today` (on a Friday) or `/session fri`. Expect the Band pull-apart with "(instead of Face pull today)".
   Tap Undo. Expect "Undone. The plan is back as it was." `/today` shows Face pull again.

3. **Swap for the rest of the plan, one weekday.** Send `from now on use band pull-aparts instead of face pulls`.
   Face pull sits on Friday only, so there is no days question. Expect a card "From <date>, Face pull → Band pull-apart on Fri (N sessions). Past sessions and logs stay as they are." The date is tomorrow or later, never today. Tap ✅, then send `/plan`.
   Expect: a "Changes" line for the swap. Tap Undo (on the "Saved." message). Expect "Undone."

4. **Exercise on two weekdays (days question).** Send `from now on use leg press instead of hack squat`.
   Squat / hack squat is on Tuesday and Friday. Expect "Hack squat is on Tue and Fri. Swap it on which days?" with "Only Tuesdays" or "Only Fridays" (the next of the two, counting today), "Every day" and Cancel. Tap one.
   Expect the card with the from-date and the session count. Tap ✅, check `/plan` (Changes line), then Undo.

5. **Scope question and Cancel.** Send `swap bench press for dumbbell press` (no scope). Bench press is on Tuesday, so the date is the next Tuesday.
   Expect "Swap Bench press → Dumbbell press. For which sessions?" with "Only <date>", "Rest of plan" and Cancel. Dumbbell press may be new: the card then adds a "New exercise" line. Tap Cancel: nothing is saved.

6. **Refusal check (optional, Friday only).** Log face pulls (`face pull 3x15 20kg`), then send step 2's text the same day and tap ✅.
   Expect the card first, then after ✅: "You already logged Face pull today; nothing changed." and no Undo button.

7. **Deload card.** It cannot be triggered on demand: it needs the frozen levels of the last two sessions to be RED (or two low weekly recovery scores). To try it, send 😴 in `/readiness` on two training days in a row and open `/today` on both days: on the second day a separate card appears: "You've been tired 2 sessions in a row. Move the deload earlier? Next week (W<n>, <dates>) becomes a deload, ..." with "✅ Move deload" and "❌ Not now". The card is not offered when next week is a deload or the test week. This flow is covered by tests; try it live only if you want to change your plan. After ✅ expect "Done. From <Mon date> the deload is W<n>." (plus "(W<m> deload dropped)" when one is dropped) and an Undo button; Undo gives "Undone. The plan is back as it was."

Cleanup: every step above ends with Undo or ❌. Undo only works until the change is used (a log, suggestion or session item on it). If it says "Too late to undo", swap back with a new swap.
