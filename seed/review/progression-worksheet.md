# Progression worksheet (hand simulation)

This file is for you to work out, by hand, what the bot should suggest on three days:
**Mon 26 Oct (W5)**, **Fri 30 Oct (W5, heavy legs on Thursday)** and **Mon 23 Nov (W9)**.
All numbers are made up (a fake lifter). The file shows only the inputs and the rules.
It does not show any answer. The bot is not used to make this file.

How to use it:
1. Read the rules in section A.
2. For each item in section C, read the inputs and work out the answer with a calculator.
3. Write the answer in `test/fixtures/progression/expected.json` (the key is shown for each item).
   The accepted shapes are explained at the top of that file.
4. If a rule is not clear for a case, write your doubt on the `Doubts` line. We will fix the rule.

## A. Rules (from SPEC 5.2, 5.6c)

**Load of one set (system load)**
- Barbell: total weight including the bar. Dumbbells: kg per hand. Machine or cable: stack value.
- Pull-up: `system load = bodyweight + added kg - assistance kg`.

**1. e1RM of one set** (e1RM = estimated best single)
`e1RM = system load x (1 + (reps + RIR) / 30)`

**2. Which sets can be used (valid set)**. A set is valid only if ALL of these are true:
- the RIR was logged (an empty RIR means the set is not used)
- reps are 15 or less
- the week is not a deload week and not a test week
- the set is not marked unclean (`clean = no`)
- the session level was not RED (YELLOW and GREEN are fine)
- Imported sessions (W1-W4) have a RIR only on the LAST set of each exercise. The other sets are not valid.
- `4+` counts as RIR 4. A `4+` set may make the e1RM higher, but must never make it lower.

**3. Session e1RM** = the highest valid set e1RM in that session. A session with no valid set does not count.

**4. Current e1RM** (use the newest sessions first, valid sessions only):
- 3 or more valid sessions: the **median** of the last 3
- 2 valid sessions: the **lower** of the two
- 1 valid session: that one (label `estimate`)
- 0 valid sessions: no suggestion, the bot asks for the load (`ask: load`, label `baseline_ask_load`)
- If all the valid sessions are imported (W1-W4): label `estimate_check_first_set`.
  Imported sessions keep the label "estimate" until the exercise has 2 bot-logged sessions.
- Tuesday and Friday squat share one e1RM. Hack squat is a separate exercise with its own history.
- For OR items (squat / hack squat, cable / machine row) each option has its own history and its own answer.

**5. Needed load** for the target
`RIR mid = (rir_min + rir_max) / 2`
`needed load = current e1RM / (1 + (reps_min + RIR mid) / 30)`   (use `reps_min`, the lower rep number)
- Pull-up: `needed added = needed load - bodyweight` (use the LATEST bodyweight). Positive = added kg.
  Zero or negative = no added weight: plain bodyweight (added 0), or a band for assistance.

**6. Rounding: always toward EASIER** (never round up to a heavier load)
- Barbell: `total = bar + k x step` (bar and step are in each item below). Take the largest total that is not above the needed load.
- Dumbbells (per hand) and stacks: the largest multiple of the step that is not above the needed load.
- Pull-up added weight: round DOWN to the step. Assistance (band): choose the smallest band that gives at least the needed assistance.
- A band colour with no kg value is unknown (see section B): the bot asks for it (`ask: band`).

**7. Accessories** (exercises that are not main lifts: lat pulldown, rows, incline DB bench, face pull, triceps, Bulgarian, lateral raise).
They do NOT use e1RM. Look at the last non-deload session only (its sets and the RIR of the LAST set):
- All sets reached `reps_max` and the last-set RIR is at least `rir_min`: **+1 step**
- Any set below `reps_min`, or last-set RIR 0 in 2 sessions in a row: **-1 step**
- Otherwise: keep the same load
- Deload or easy sessions are not used for this rule. Use the newest non-deload session.
- With no non-deload session at all: no suggestion (ask for the load).

**8. Break rule** ("back after a break"): take 10% off the system load, label `back_after_break`.
It fires when the planned item was scheduled and NOT logged 2 or more times in a row (see the item's schedule list),
or when no training at all was logged for 10 or more days (class days count as training).
For pull-ups the 10% is taken from the total system load but removed from the added weight only, never below 0.
After rounding (toward easier), if the load did NOT go down (for example it is already the bar only), there is no change and no `back_after_break` label.
The cut also applies to accessories held at a last load (easy or deload items).

**9. Friday rules** (by the item's tags and the heavy groups of Thursday's class):
- heavy PULL: items tagged `row` are reduced to 2 sets x `reps_min` at RIR 3-4, or can be skipped (label `friday_reduced`)
- heavy PUSH: items tagged `horizontal_press`: same
- heavy LEGS: items tagged `squat`: same. Items tagged `unilateral_leg` are only offered as skip (label `friday_offer_skip`, normal prescription)
- Deload Friday and heavy: the matching items drop to 1 easy set or skip. Unilateral leg: skipped.
- When the prescription changes, write the new sets / reps / RIR in your answer, and the load for those reps and that RIR.
- Main lifts (squat): recompute the load from the e1RM for 2 x `reps_min` at RIR 3-4 (RIR mid = 3.5). Friday rules do not change which e1RM is used.
- Accessories (rows, incline DB bench, Bulgarian...): NO step up and NO step down. Hold the LAST VALID load (last non-deload session) at the new reps and RIR. The same hold applies to accessories reduced on a deload Friday.

**10. Pull-up gate** (weighted pull-ups are allowed only when the gate is open)
- Opens on a clean bodyweight set of 6 or more reps, or a check-in / test max of 6 or more.
- Stays open. Closes only if a later bodyweight max test is below 6, or the e1RM implies less than 5 bodyweight reps in 2 sessions in a row.
- Gate closed: use the plan's fallback shown on the item: bodyweight 4 x 4-6 if the last bodyweight max is at least the stated number, otherwise assisted 4 x 6. Labels `fallback_bw` / `fallback_assisted`.
- **Last bodyweight max**: a clean bodyweight set counts as a max only if it was logged at RIR 0 or 1 (near max) OR has 6 or more reps. Check-in / test maxes always count. Take the LATEST day that has such a max and use the highest value of that day.
- No max on record at all: the session starts with one max-clean test set (`max_test_first`), then the fallback above.

**11. Readiness**: a session is GREEN with no active signals. Signals expire: button and chat after 24 h, recovery score after 3 days.
Heavy Thursday is NOT a readiness signal. If the level is GREEN the plan is used as written.
If a level were YELLOW: main lifts show RIR 2-3 and the load is computed at RIR 2.5. (Not expected on these dates.)

## B. Equipment and bands

| Equipment | Bar / base | Step |
|---|---|---|
| Barbell (total incl. bar) | 15 kg | 2.5 kg |
| Dumbbells (per hand) | - | 2.5 kg |
| Cable stack | - | 2.5 kg |
| Row machine stack | - | 2.5 kg |
| Hack squat (plates on sled) | - | 2.5 kg |
| Pull-up bar (added weight, bands) | - | 2.5 kg |

**Band colours are NOT known yet.** Fill in the real kg of assistance for each colour if you need a band in an answer.
(The made-up lifter never used a band, so the answers below should not need one. If you think one is needed, tell us.)

- red = ? kg
- black = ? kg
- purple = ? kg
- green = ? kg
- blue = ? kg

## C. Mon 26 Oct 2026 - plan week 5, MON

**Day context**
- Readiness signals on record (they expire, see A.11): none.
- Latest bodyweight: **77.8 kg** on Fri 16 Oct (10 days before this session; stale means more than 14).
- Last day with any training logged before this date (class days count): Fri 23 Oct (3 day(s) before).
- Sets that count as a bodyweight max (clean, RIR 0-1 or 6+ reps; plus check-in maxes): Mon 12 Oct set 1: 6 reps, RIR not logged; Mon 12 Oct set 2: 6 reps, RIR not logged; Mon 12 Oct set 3: 6 reps, RIR not logged; Mon 12 Oct set 4: 6 reps, RIR not logged; Mon 12 Oct set 5: 6 reps, RIR 1; Mon 5 Oct set 4: 5 reps, RIR 1; Fri 9 Oct check-in max: 5 reps; Fri 16 Oct check-in max: 7 reps.
- Pull-up gate events on record (oldest first, reps): clean bodyweight sets on Mon 28 Sep: 4, 4, 4, 4; clean bodyweight sets on Mon 5 Oct: 5, 5, 5, 5; check-in max on Fri 9 Oct: 5; clean bodyweight sets on Mon 12 Oct: 6, 6, 6, 6, 6; check-in max on Fri 16 Oct: 7; clean bodyweight sets on Mon 19 Oct: 3, 3.

No load math, nothing to fill: Pull warm-up; Chest-supported row; Hanging leg raise / knee raise.

### w05-mon-01-0 - Weighted pull-up*

- Plan target: **4 sets x 3 reps**, RIR 1-2, RIR mid = 1.5. Use reps_min = 3 for the load. Tags: skill_strength, vertical_pull.
- Rule to use: main lift: e1RM rule (section A.1-A.6); pull-up gate (A.10).
- Equipment: Pull-up bar (added weight, bands). Step = 2.5 kg.
- Pull-up bodyweight to use: latest = 77.8 kg. Bands: not mapped yet (section B).
- If the gate is closed: if last bodyweight max >= 4 -> 4 x 4-6 bodyweight; otherwise assisted 4 x 6.
- Schedule for the break rule (earlier non-deload weeks, oldest first): Mon 28 Sep logged; Mon 5 Oct logged; Mon 12 Oct logged.

History for Pull-up (newest first); load = bodyweight stored that day + added - assistance:

| Session | Set | Reps | System load (kg) | RIR | Clean | Valid for e1RM? |
|---|---|---|---|---|---|---|
| Mon 19 Oct (W4, import) | 1 | 3 | 77.8 + 0 - 0 = 77.8 | not logged | yes | no (deload week, no RIR) |
| Mon 19 Oct (W4, import) | 2 | 3 | 77.8 + 0 - 0 = 77.8 | 4 | yes | no (deload week) |
| Mon 12 Oct (W3, import) | 1 | 6 | 78.2 + 0 - 0 = 78.2 | not logged | yes | no (no RIR) |
| Mon 12 Oct (W3, import) | 2 | 6 | 78.2 + 0 - 0 = 78.2 | not logged | yes | no (no RIR) |
| Mon 12 Oct (W3, import) | 3 | 6 | 78.2 + 0 - 0 = 78.2 | not logged | yes | no (no RIR) |
| Mon 12 Oct (W3, import) | 4 | 6 | 78.2 + 0 - 0 = 78.2 | not logged | yes | no (no RIR) |
| Mon 12 Oct (W3, import) | 5 | 6 | 78.2 + 0 - 0 = 78.2 | 1 | yes | yes |
| Mon 5 Oct (W2, import) | 1 | 5 | 78 + 0 - 0 = 78 | not logged | yes | no (no RIR) |
| Mon 5 Oct (W2, import) | 2 | 5 | 78 + 0 - 0 = 78 | not logged | yes | no (no RIR) |
| Mon 5 Oct (W2, import) | 3 | 5 | 78 + 0 - 0 = 78 | not logged | yes | no (no RIR) |
| Mon 5 Oct (W2, import) | 4 | 5 | 78 + 0 - 0 = 78 | 1 | yes | yes |
| Mon 28 Sep (W1, import) | 1 | 4 | 78 + 0 - 0 = 78 | not logged | yes | no (no RIR) |
| Mon 28 Sep (W1, import) | 2 | 4 | 78 + 0 - 0 = 78 | not logged | yes | no (no RIR) |
| Mon 28 Sep (W1, import) | 3 | 4 | 78 + 0 - 0 = 78 | not logged | yes | no (no RIR) |
| Mon 28 Sep (W1, import) | 4 | 4 | 78 + 0 - 0 = 78 | 2 | yes | yes |

Your answer (also write it in expected.json):

`Answer: ____________________________`

`Doubts: ____________________________`

### w05-mon-03-0 - Romanian deadlift

- Plan target: **3 sets x 6 reps**, RIR 1-2, RIR mid = 1.5. Use reps_min = 6 for the load. Tags: hinge.
- Rule to use: main lift: e1RM rule (section A.1-A.6).
- Equipment: Barbell (total incl. bar). Bar = 15 kg. Step = 2.5 kg.
- Schedule for the break rule (earlier non-deload weeks, oldest first): Mon 28 Sep logged; Mon 5 Oct logged; Mon 12 Oct logged.

History for Romanian deadlift (newest first):

| Session | Set | Reps | Load (kg) | RIR | Clean | Valid for e1RM? |
|---|---|---|---|---|---|---|
| Mon 19 Oct (W4, import) | 1 | 6 | 55 | not logged | - | no (deload week, no RIR) |
| Mon 19 Oct (W4, import) | 2 | 6 | 55 | 4 | - | no (deload week) |
| Mon 12 Oct (W3, import) | 1 | 8 | 77.5 | not logged | - | no (no RIR) |
| Mon 12 Oct (W3, import) | 2 | 8 | 77.5 | not logged | - | no (no RIR) |
| Mon 12 Oct (W3, import) | 3 | 7 | 77.5 | 1 | - | yes |
| Mon 5 Oct (W2, import) | 1 | 8 | 75 | not logged | - | no (no RIR) |
| Mon 5 Oct (W2, import) | 2 | 8 | 75 | not logged | - | no (no RIR) |
| Mon 5 Oct (W2, import) | 3 | 8 | 75 | 1 | - | yes |
| Mon 28 Sep (W1, import) | 1 | 8 | 70 | not logged | - | no (no RIR) |
| Mon 28 Sep (W1, import) | 2 | 8 | 70 | not logged | - | no (no RIR) |
| Mon 28 Sep (W1, import) | 3 | 8 | 70 | 2 | - | yes |

Your answer (also write it in expected.json):

`Answer: ____________________________`

`Doubts: ____________________________`

### w05-mon-04-0 - Lat pulldown

- Plan target: **2 sets x 8-12 reps**, RIR 1-3, RIR mid = 2. Use reps_min = 8 for the load. Tags: vertical_pull.
- Rule to use: accessory rule (section A.7), no e1RM.
- Equipment: Cable stack. Step = 2.5 kg.
- Schedule for the break rule (earlier non-deload weeks, oldest first): Mon 28 Sep logged; Mon 5 Oct logged; Mon 12 Oct logged.

History for Lat pulldown (newest first):

| Session | Set | Reps | Load (kg) | RIR | Clean | Valid for e1RM? |
|---|---|---|---|---|---|---|
| Mon 19 Oct (W4, import) | 1 | 10 | 40 | 4 | - | (not used: accessory) |
| Mon 12 Oct (W3, import) | 1 | 11 | 52.5 | not logged | - | (not used: accessory) |
| Mon 12 Oct (W3, import) | 2 | 10 | 52.5 | 1 | - | (not used: accessory) |
| Mon 5 Oct (W2, import) | 1 | 12 | 50 | not logged | - | (not used: accessory) |
| Mon 5 Oct (W2, import) | 2 | 12 | 50 | 2 | - | (not used: accessory) |
| Mon 28 Sep (W1, import) | 1 | 12 | 50 | not logged | - | (not used: accessory) |
| Mon 28 Sep (W1, import) | 2 | 11 | 50 | 2 | - | (not used: accessory) |

Your answer (also write it in expected.json):

`Answer: ____________________________`

`Doubts: ____________________________`

## C. Fri 30 Oct 2026 - plan week 5, FRI

**Day context**
- Readiness signals on record (they expire, see A.11): none.
- Latest bodyweight: **77.8 kg** on Fri 16 Oct (14 days before this session; stale means more than 14).
- Last day with any training logged before this date (class days count): Thu 29 Oct (1 day(s) before).
- Thursday class (Thu 29 Oct): reported = yes; heavy groups = LEGS.
- This Friday is a normal week.

No load math, nothing to fill: Full-body warm-up.

### w05-fri-01-0:squat - Squat / hack squat -> option: Squat

- Plan target: **3 sets x 4-6 reps**, RIR 1-2, RIR mid = 1.5. Use reps_min = 4 for the load. Tags: squat.
- Rule to use: main lift: e1RM rule (section A.1-A.6).
- Equipment: Barbell (total incl. bar). Bar = 15 kg. Step = 2.5 kg.
- Schedule for the break rule (earlier non-deload weeks, oldest first): Fri 2 Oct logged; Fri 9 Oct logged; Fri 16 Oct logged.

History for Squat (newest first):

| Session | Set | Reps | Load (kg) | RIR | Clean | Valid for e1RM? |
|---|---|---|---|---|---|---|
| Tue 27 Oct (W5, bot) | 1 | 6 | 85 | 2 | - | yes |
| Tue 27 Oct (W5, bot) | 2 | 5 | 85 | 1 | - | yes |
| Tue 27 Oct (W5, bot) | 3 | 5 | 85 | 1 | - | yes |
| Fri 23 Oct (W4, import) | 1 | 5 | 60 | not logged | - | no (deload week, no RIR) |
| Fri 23 Oct (W4, import) | 2 | 5 | 60 | 4 | - | no (deload week) |
| Tue 20 Oct (W4, import) | 1 | 6 | 55 | not logged | - | no (deload week, no RIR) |
| Tue 20 Oct (W4, import) | 2 | 6 | 55 | 4 | - | no (deload week) |
| Fri 16 Oct (W3, import) | 1 | 6 | 72.5 | not logged | - | no (no RIR) |
| Fri 16 Oct (W3, import) | 2 | 6 | 72.5 | 3 | - | yes |
| Tue 13 Oct (W3, import) | 1 | 7 | 80 | not logged | - | no (no RIR) |
| Tue 13 Oct (W3, import) | 2 | 6 | 80 | not logged | - | no (no RIR) |
| Tue 13 Oct (W3, import) | 3 | 6 | 80 | 1 | - | yes |
| Tue 6 Oct (W2, import) | 1 | 8 | 75 | not logged | - | no (no RIR) |
| Tue 6 Oct (W2, import) | 2 | 7 | 75 | not logged | - | no (no RIR) |
| Tue 6 Oct (W2, import) | 3 | 7 | 75 | 1 | - | yes |
| Fri 2 Oct (W1, import) | 1 | 6 | 72.5 | not logged | - | no (no RIR) |
| Fri 2 Oct (W1, import) | 2 | 6 | 72.5 | not logged | - | no (no RIR) |
| Fri 2 Oct (W1, import) | 3 | 6 | 72.5 | 2 | - | yes |
| Tue 29 Sep (W1, import) | 1 | 8 | 70 | not logged | - | no (no RIR) |
| Tue 29 Sep (W1, import) | 2 | 8 | 70 | not logged | - | no (no RIR) |
| Tue 29 Sep (W1, import) | 3 | 7 | 70 | 1 | - | yes |

Your answer (also write it in expected.json):

`Answer: ____________________________`

`Doubts: ____________________________`

### w05-fri-01-0:hack_squat - Squat / hack squat -> option: Hack squat

- Plan target: **3 sets x 4-6 reps**, RIR 1-2, RIR mid = 1.5. Use reps_min = 4 for the load. Tags: squat.
- Rule to use: main lift: e1RM rule (section A.1-A.6).
- Equipment: Hack squat (plates on sled). Step = 2.5 kg.
- Schedule for the break rule (earlier non-deload weeks, oldest first): Fri 2 Oct logged; Fri 9 Oct logged; Fri 16 Oct logged.

History for Hack squat (newest first):

| Session | Set | Reps | Load (kg) | RIR | Clean | Valid for e1RM? |
|---|---|---|---|---|---|---|
| Fri 9 Oct (W2, import) | 1 | 6 | 100 | not logged | - | no (no RIR) |
| Fri 9 Oct (W2, import) | 2 | 6 | 100 | not logged | - | no (no RIR) |
| Fri 9 Oct (W2, import) | 3 | 6 | 100 | 1 | - | yes |

Your answer (also write it in expected.json):

`Answer: ____________________________`

`Doubts: ____________________________`

### w05-fri-02-0 - Incline DB bench

- Plan target: **3 sets x 6-8 reps**, RIR 1-3, RIR mid = 2. Use reps_min = 6 for the load. Tags: horizontal_press.
- Rule to use: accessory rule (section A.7), no e1RM.
- Equipment: Dumbbells (per hand). Step = 2.5 kg.
- Schedule for the break rule (earlier non-deload weeks, oldest first): Fri 2 Oct logged; Fri 9 Oct logged; Fri 16 Oct logged.

History for Incline DB bench (newest first):

| Session | Set | Reps | Load (kg) | RIR | Clean | Valid for e1RM? |
|---|---|---|---|---|---|---|
| Fri 23 Oct (W4, import) | 1 | 8 | 15 | not logged | - | (not used: accessory) |
| Fri 23 Oct (W4, import) | 2 | 8 | 15 | 4 | - | (not used: accessory) |
| Fri 16 Oct (W3, import) | 1 | 10 | 22.5 | not logged | - | (not used: accessory) |
| Fri 16 Oct (W3, import) | 2 | 9 | 22.5 | not logged | - | (not used: accessory) |
| Fri 16 Oct (W3, import) | 3 | 8 | 22.5 | 1 | - | (not used: accessory) |
| Fri 9 Oct (W2, import) | 1 | 10 | 20 | not logged | - | (not used: accessory) |
| Fri 9 Oct (W2, import) | 2 | 10 | 20 | not logged | - | (not used: accessory) |
| Fri 9 Oct (W2, import) | 3 | 10 | 20 | 2 | - | (not used: accessory) |
| Fri 2 Oct (W1, import) | 1 | 10 | 20 | not logged | - | (not used: accessory) |
| Fri 2 Oct (W1, import) | 2 | 9 | 20 | not logged | - | (not used: accessory) |
| Fri 2 Oct (W1, import) | 3 | 8 | 20 | 1 | - | (not used: accessory) |

Your answer (also write it in expected.json):

`Answer: ____________________________`

`Doubts: ____________________________`

### w05-fri-03-0:cable_row - Cable / machine row -> option: Cable row

- Plan target: **3 sets x 6-8 reps**, RIR 1-3, RIR mid = 2. Use reps_min = 6 for the load. Tags: row.
- Rule to use: accessory rule (section A.7), no e1RM.
- Equipment: Cable stack. Step = 2.5 kg.
- Schedule for the break rule (earlier non-deload weeks, oldest first): Fri 2 Oct logged; Fri 9 Oct logged; Fri 16 Oct logged.

History for Cable row (newest first):

| Session | Set | Reps | Load (kg) | RIR | Clean | Valid for e1RM? |
|---|---|---|---|---|---|---|
| Fri 23 Oct (W4, import) | 1 | 8 | 35 | not logged | - | (not used: accessory) |
| Fri 23 Oct (W4, import) | 2 | 8 | 35 | 4 | - | (not used: accessory) |
| Fri 9 Oct (W2, import) | 1 | 10 | 47.5 | not logged | - | (not used: accessory) |
| Fri 9 Oct (W2, import) | 2 | 10 | 47.5 | not logged | - | (not used: accessory) |
| Fri 9 Oct (W2, import) | 3 | 10 | 47.5 | 2 | - | (not used: accessory) |
| Fri 2 Oct (W1, import) | 1 | 10 | 45 | not logged | - | (not used: accessory) |
| Fri 2 Oct (W1, import) | 2 | 10 | 45 | not logged | - | (not used: accessory) |
| Fri 2 Oct (W1, import) | 3 | 9 | 45 | 2 | - | (not used: accessory) |

Your answer (also write it in expected.json):

`Answer: ____________________________`

`Doubts: ____________________________`

### w05-fri-03-0:machine_row - Cable / machine row -> option: Machine row

- Plan target: **3 sets x 6-8 reps**, RIR 1-3, RIR mid = 2. Use reps_min = 6 for the load. Tags: row.
- Rule to use: accessory rule (section A.7), no e1RM.
- Equipment: Row machine stack. Step = 2.5 kg.
- Schedule for the break rule (earlier non-deload weeks, oldest first): Fri 2 Oct logged; Fri 9 Oct logged; Fri 16 Oct logged.

History for Machine row (newest first):

| Session | Set | Reps | Load (kg) | RIR | Clean | Valid for e1RM? |
|---|---|---|---|---|---|---|
| Fri 16 Oct (W3, import) | 1 | 10 | 50 | not logged | - | (not used: accessory) |
| Fri 16 Oct (W3, import) | 2 | 9 | 50 | not logged | - | (not used: accessory) |
| Fri 16 Oct (W3, import) | 3 | 8 | 50 | 1 | - | (not used: accessory) |

Your answer (also write it in expected.json):

`Answer: ____________________________`

`Doubts: ____________________________`

### w05-fri-04-0 - Bulgarian split squat

- Plan target: **2 sets x 8 reps**, RIR 1-3, RIR mid = 2. Use reps_min = 8 for the load. Tags: unilateral_leg.
- Rule to use: accessory rule (section A.7), no e1RM.
- Equipment: Dumbbells (per hand). Step = 2.5 kg.
- Schedule for the break rule (earlier non-deload weeks, oldest first): Fri 2 Oct logged; Fri 9 Oct logged; Fri 16 Oct NOT logged.

History for Bulgarian split squat (newest first):

| Session | Set | Reps | Load (kg) | RIR | Clean | Valid for e1RM? |
|---|---|---|---|---|---|---|
| Fri 23 Oct (W4, import) | 1 | 8 | 10 | 4 | - | (not used: accessory) |
| Fri 9 Oct (W2, import) | 1 | 8 | 12.5 | not logged | - | (not used: accessory) |
| Fri 9 Oct (W2, import) | 2 | 8 | 12.5 | 2 | - | (not used: accessory) |
| Fri 2 Oct (W1, import) | 1 | 8 | 12.5 | not logged | - | (not used: accessory) |
| Fri 2 Oct (W1, import) | 2 | 8 | 12.5 | 2 | - | (not used: accessory) |

Your answer (also write it in expected.json):

`Answer: ____________________________`

`Doubts: ____________________________`

### w05-fri-05-0 - Face pull

- Plan target: **2 sets x 12-15 reps**, RIR 1-3, RIR mid = 2. Use reps_min = 12 for the load. Tags: prehab.
- Rule to use: accessory rule (section A.7), no e1RM.
- Equipment: Cable stack. Step = 2.5 kg.
- Schedule for the break rule (earlier non-deload weeks, oldest first): Fri 2 Oct logged; Fri 9 Oct logged; Fri 16 Oct logged.

History for Face pull (newest first):

| Session | Set | Reps | Load (kg) | RIR | Clean | Valid for e1RM? |
|---|---|---|---|---|---|---|
| Fri 23 Oct (W4, import) | 1 | 12 | 20 | not logged | - | (not used: accessory) |
| Fri 23 Oct (W4, import) | 2 | 12 | 20 | 4 | - | (not used: accessory) |
| Fri 16 Oct (W3, import) | 1 | 15 | 27.5 | not logged | - | (not used: accessory) |
| Fri 16 Oct (W3, import) | 2 | 13 | 27.5 | 1 | - | (not used: accessory) |
| Fri 9 Oct (W2, import) | 1 | 15 | 25 | not logged | - | (not used: accessory) |
| Fri 9 Oct (W2, import) | 2 | 15 | 25 | 2 | - | (not used: accessory) |
| Fri 2 Oct (W1, import) | 1 | 15 | 25 | not logged | - | (not used: accessory) |
| Fri 2 Oct (W1, import) | 2 | 14 | 25 | 2 | - | (not used: accessory) |

Your answer (also write it in expected.json):

`Answer: ____________________________`

`Doubts: ____________________________`

### w05-fri-06-0 - Curl OR triceps extension

- Plan target: **2 sets x 8-12 reps**, RIR 1-3, RIR mid = 2. Use reps_min = 8 for the load. Tags: accessory.
- Rule to use: accessory rule (section A.7), no e1RM.
- Equipment: Cable stack. Step = 2.5 kg.
- Schedule for the break rule (earlier non-deload weeks, oldest first): Fri 2 Oct logged; Fri 9 Oct logged; Fri 16 Oct logged.

History for Triceps extension (newest first):

| Session | Set | Reps | Load (kg) | RIR | Clean | Valid for e1RM? |
|---|---|---|---|---|---|---|
| Fri 16 Oct (W3, import) | 1 | 10 | 22.5 | not logged | - | (not used: accessory) |
| Fri 16 Oct (W3, import) | 2 | 9 | 22.5 | 1 | - | (not used: accessory) |
| Fri 9 Oct (W2, import) | 1 | 12 | 20 | not logged | - | (not used: accessory) |
| Fri 9 Oct (W2, import) | 2 | 12 | 20 | 2 | - | (not used: accessory) |
| Fri 2 Oct (W1, import) | 1 | 12 | 20 | not logged | - | (not used: accessory) |
| Fri 2 Oct (W1, import) | 2 | 11 | 20 | 2 | - | (not used: accessory) |

Your answer (also write it in expected.json):

`Answer: ____________________________`

`Doubts: ____________________________`

## C. Mon 23 Nov 2026 - plan week 9, MON

**Day context**
- Readiness signals on record (they expire, see A.11): button_tired at 2026-11-13T06:10:00+01:00; recovery_low at 2026-11-13T20:00:00+01:00.
- Latest bodyweight: **79 kg** on Fri 13 Nov (10 days before this session; stale means more than 14).
- Last day with any training logged before this date (class days count): Fri 20 Nov (3 day(s) before).
- Sets that count as a bodyweight max (clean, RIR 0-1 or 6+ reps; plus check-in maxes): Mon 12 Oct set 1: 6 reps, RIR not logged; Mon 12 Oct set 2: 6 reps, RIR not logged; Mon 12 Oct set 3: 6 reps, RIR not logged; Mon 12 Oct set 4: 6 reps, RIR not logged; Mon 12 Oct set 5: 6 reps, RIR 1; Mon 5 Oct set 4: 5 reps, RIR 1; Fri 9 Oct check-in max: 5 reps; Fri 16 Oct check-in max: 7 reps.
- Pull-up gate events on record (oldest first, reps): clean bodyweight sets on Mon 28 Sep: 4, 4, 4, 4; clean bodyweight sets on Mon 5 Oct: 5, 5, 5, 5; check-in max on Fri 9 Oct: 5; clean bodyweight sets on Mon 12 Oct: 6, 6, 6, 6, 6; check-in max on Fri 16 Oct: 7; clean bodyweight sets on Mon 19 Oct: 3, 3.

No load math, nothing to fill: Pull warm-up; Chest-supported row; Hanging leg raise / knee raise.

### w09-mon-01-0 - Weighted pull-up

- Plan target: **4 sets x 3 reps**, RIR 1-2, RIR mid = 1.5. Use reps_min = 3 for the load. Tags: skill_strength, vertical_pull. Modifiers: heavy_clean.
- Rule to use: main lift: e1RM rule (section A.1-A.6); pull-up gate (A.10).
- Equipment: Pull-up bar (added weight, bands). Step = 2.5 kg.
- Pull-up bodyweight to use: latest = 79 kg. Bands: not mapped yet (section B).
- If the gate is closed: if last bodyweight max >= 4 -> 4 x 4-6 bodyweight; otherwise assisted 4 x 6.
- Schedule for the break rule (earlier non-deload weeks, oldest first): Mon 28 Sep logged; Mon 5 Oct logged; Mon 12 Oct logged; Mon 26 Oct logged; Mon 2 Nov logged; Mon 9 Nov logged.

History for Pull-up (newest first); load = bodyweight stored that day + added - assistance:

| Session | Set | Reps | System load (kg) | RIR | Clean | Valid for e1RM? |
|---|---|---|---|---|---|---|
| Mon 16 Nov (W8, bot) | 1 | 3 | 79 + 2.5 - 0 = 81.5 | 4 | yes | no (deload week) |
| Mon 16 Nov (W8, bot) | 2 | 3 | 79 + 2.5 - 0 = 81.5 | 4 | yes | no (deload week) |
| Mon 9 Nov (W7, bot) | 1 | 3 | 78.6 + 7.5 - 0 = 86.1 | 2 | yes | yes |
| Mon 9 Nov (W7, bot) | 2 | 3 | 78.6 + 7.5 - 0 = 86.1 | 1 | yes | yes |
| Mon 9 Nov (W7, bot) | 3 | 3 | 78.6 + 7.5 - 0 = 86.1 | 1 | yes | yes |
| Mon 9 Nov (W7, bot) | 4 | 3 | 78.6 + 7.5 - 0 = 86.1 | 0 | yes | yes |
| Mon 9 Nov (W7, bot) | 5 | 2 | 78.6 + 7.5 - 0 = 86.1 | 0 | yes | yes |
| Mon 2 Nov (W6, bot) | 1 | 4 | 77.8 + 5 - 0 = 82.8 | 2 | yes | yes |
| Mon 2 Nov (W6, bot) | 2 | 3 | 77.8 + 5 - 0 = 82.8 | 1 | yes | yes |
| Mon 2 Nov (W6, bot) | 3 | 3 | 77.8 + 5 - 0 = 82.8 | 1 | no | no (unclean) |
| Mon 2 Nov (W6, bot) | 4 | 3 | 77.8 + 5 - 0 = 82.8 | 1 | yes | yes |
| Mon 26 Oct (W5, bot) | 1 | 3 | 77.8 + 2.5 - 0 = 80.3 | 2 | yes | yes |
| Mon 26 Oct (W5, bot) | 2 | 3 | 77.8 + 2.5 - 0 = 80.3 | 2 | yes | yes |
| Mon 26 Oct (W5, bot) | 3 | 3 | 77.8 + 2.5 - 0 = 80.3 | 1 | yes | yes |
| Mon 26 Oct (W5, bot) | 4 | 3 | 77.8 + 2.5 - 0 = 80.3 | 1 | yes | yes |
| Mon 19 Oct (W4, import) | 1 | 3 | 77.8 + 0 - 0 = 77.8 | not logged | yes | no (deload week, no RIR) |
| Mon 19 Oct (W4, import) | 2 | 3 | 77.8 + 0 - 0 = 77.8 | 4 | yes | no (deload week) |
| Mon 12 Oct (W3, import) | 1 | 6 | 78.2 + 0 - 0 = 78.2 | not logged | yes | no (no RIR) |
| Mon 12 Oct (W3, import) | 2 | 6 | 78.2 + 0 - 0 = 78.2 | not logged | yes | no (no RIR) |
| Mon 12 Oct (W3, import) | 3 | 6 | 78.2 + 0 - 0 = 78.2 | not logged | yes | no (no RIR) |
| Mon 12 Oct (W3, import) | 4 | 6 | 78.2 + 0 - 0 = 78.2 | not logged | yes | no (no RIR) |
| Mon 12 Oct (W3, import) | 5 | 6 | 78.2 + 0 - 0 = 78.2 | 1 | yes | yes |
| Mon 5 Oct (W2, import) | 1 | 5 | 78 + 0 - 0 = 78 | not logged | yes | no (no RIR) |
| Mon 5 Oct (W2, import) | 2 | 5 | 78 + 0 - 0 = 78 | not logged | yes | no (no RIR) |
| Mon 5 Oct (W2, import) | 3 | 5 | 78 + 0 - 0 = 78 | not logged | yes | no (no RIR) |
| Mon 5 Oct (W2, import) | 4 | 5 | 78 + 0 - 0 = 78 | 1 | yes | yes |
| Mon 28 Sep (W1, import) | 1 | 4 | 78 + 0 - 0 = 78 | not logged | yes | no (no RIR) |
| Mon 28 Sep (W1, import) | 2 | 4 | 78 + 0 - 0 = 78 | not logged | yes | no (no RIR) |
| Mon 28 Sep (W1, import) | 3 | 4 | 78 + 0 - 0 = 78 | not logged | yes | no (no RIR) |
| Mon 28 Sep (W1, import) | 4 | 4 | 78 + 0 - 0 = 78 | 2 | yes | yes |

Your answer (also write it in expected.json):

`Answer: ____________________________`

`Doubts: ____________________________`

### w09-mon-03-0 - Romanian deadlift

- Plan target: **3 sets x 5-6 reps**, RIR 1-2, RIR mid = 1.5. Use reps_min = 5 for the load. Tags: hinge.
- Rule to use: main lift: e1RM rule (section A.1-A.6).
- Equipment: Barbell (total incl. bar). Bar = 15 kg. Step = 2.5 kg.
- Schedule for the break rule (earlier non-deload weeks, oldest first): Mon 28 Sep logged; Mon 5 Oct logged; Mon 12 Oct logged; Mon 26 Oct logged; Mon 2 Nov logged; Mon 9 Nov logged.

History for Romanian deadlift (newest first):

| Session | Set | Reps | Load (kg) | RIR | Clean | Valid for e1RM? |
|---|---|---|---|---|---|---|
| Mon 16 Nov (W8, bot) | 1 | 6 | 60 | 4 | - | no (deload week) |
| Mon 16 Nov (W8, bot) | 2 | 6 | 60 | 4 | - | no (deload week) |
| Mon 9 Nov (W7, bot) | 1 | 6 | 85 | 2 | - | yes |
| Mon 9 Nov (W7, bot) | 2 | 6 | 85 | 2 | - | yes |
| Mon 9 Nov (W7, bot) | 3 | 6 | 85 | 1 | - | yes |
| Mon 2 Nov (W6, bot) | 1 | 6 | 85 | 1 | - | yes |
| Mon 2 Nov (W6, bot) | 2 | 5 | 85 | 1 | - | yes |
| Mon 2 Nov (W6, bot) | 3 | 4 | 85 | 0 | - | yes |
| Mon 26 Oct (W5, bot) | 1 | 6 | 82.5 | 2 | - | yes |
| Mon 26 Oct (W5, bot) | 2 | 6 | 82.5 | 2 | - | yes |
| Mon 26 Oct (W5, bot) | 3 | 6 | 82.5 | 1 | - | yes |
| Mon 19 Oct (W4, import) | 1 | 6 | 55 | not logged | - | no (deload week, no RIR) |
| Mon 19 Oct (W4, import) | 2 | 6 | 55 | 4 | - | no (deload week) |
| Mon 12 Oct (W3, import) | 1 | 8 | 77.5 | not logged | - | no (no RIR) |
| Mon 12 Oct (W3, import) | 2 | 8 | 77.5 | not logged | - | no (no RIR) |
| Mon 12 Oct (W3, import) | 3 | 7 | 77.5 | 1 | - | yes |
| Mon 5 Oct (W2, import) | 1 | 8 | 75 | not logged | - | no (no RIR) |
| Mon 5 Oct (W2, import) | 2 | 8 | 75 | not logged | - | no (no RIR) |
| Mon 5 Oct (W2, import) | 3 | 8 | 75 | 1 | - | yes |
| Mon 28 Sep (W1, import) | 1 | 8 | 70 | not logged | - | no (no RIR) |
| Mon 28 Sep (W1, import) | 2 | 8 | 70 | not logged | - | no (no RIR) |
| Mon 28 Sep (W1, import) | 3 | 8 | 70 | 2 | - | yes |

Your answer (also write it in expected.json):

`Answer: ____________________________`

`Doubts: ____________________________`

### w09-mon-04-0 - Lat pulldown

- Plan target: **2 sets x 8-12 reps**, RIR 1-3, RIR mid = 2. Use reps_min = 8 for the load. Tags: vertical_pull.
- Rule to use: accessory rule (section A.7), no e1RM.
- Equipment: Cable stack. Step = 2.5 kg.
- Schedule for the break rule (earlier non-deload weeks, oldest first): Mon 28 Sep logged; Mon 5 Oct logged; Mon 12 Oct logged; Mon 26 Oct logged; Mon 2 Nov logged; Mon 9 Nov logged.

History for Lat pulldown (newest first):

| Session | Set | Reps | Load (kg) | RIR | Clean | Valid for e1RM? |
|---|---|---|---|---|---|---|
| Mon 16 Nov (W8, bot) | 1 | 10 | 40 | 4 | - | (not used: accessory) |
| Mon 9 Nov (W7, bot) | 1 | 12 | 55 | 3 | - | (not used: accessory) |
| Mon 9 Nov (W7, bot) | 2 | 12 | 55 | 4+ | - | (not used: accessory) |
| Mon 2 Nov (W6, bot) | 1 | 12 | 55 | 2 | - | (not used: accessory) |
| Mon 2 Nov (W6, bot) | 2 | 10 | 55 | 1 | - | (not used: accessory) |
| Mon 26 Oct (W5, bot) | 1 | 12 | 52.5 | 3 | - | (not used: accessory) |
| Mon 26 Oct (W5, bot) | 2 | 12 | 52.5 | 2 | - | (not used: accessory) |
| Mon 19 Oct (W4, import) | 1 | 10 | 40 | 4 | - | (not used: accessory) |
| Mon 12 Oct (W3, import) | 1 | 11 | 52.5 | not logged | - | (not used: accessory) |
| Mon 12 Oct (W3, import) | 2 | 10 | 52.5 | 1 | - | (not used: accessory) |
| Mon 5 Oct (W2, import) | 1 | 12 | 50 | not logged | - | (not used: accessory) |
| Mon 5 Oct (W2, import) | 2 | 12 | 50 | 2 | - | (not used: accessory) |
| Mon 28 Sep (W1, import) | 1 | 12 | 50 | not logged | - | (not used: accessory) |
| Mon 28 Sep (W1, import) | 2 | 11 | 50 | 2 | - | (not used: accessory) |

Your answer (also write it in expected.json):

`Answer: ____________________________`

`Doubts: ____________________________`

