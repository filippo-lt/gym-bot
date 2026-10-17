# Plan review: Hybrid Strength

## How to read this file

- **RIR**: reps in reserve. RIR 2 means you stop with about 2 more reps possible.
- **×?**: the number of reps is open (not written in the plan).
- **step**: the HSPU ladder step named in the plan.
- **(raw text only)**: a list of moves. It is kept as written, with no numbers read from it.
- **on/off**: HIIT work seconds / rest seconds. `8×30s on/90s off` means 8 rounds of 30 s hard and 90 s easy.
- **easy**: light effort, stay far from failure.
- **light**: lighter weight than usual.
- **optional**: you may skip it.
- **heavy_clean**: heavy but every rep is clean.
- **slightly_heavier**: a bit more weight than last time.
- **test**: a max-effort test.
- **deload**: an easy recovery week or item.
- **max_attempts**: several all-out attempts, count the best.
- **stop_before_form_breaks**: stop one rep before your technique gets worse.

## 1. Summary

- Source hash: `54f175de445362805c26768732763d6c4b64c6bf225520f647879bada8a4da69`
- Weeks: 12, starting 2026-09-28
- Items: 323 (322 plan rows + 1 extra set split out: w11-mon-01-1)
- Exercises: 33
- Open issues: 25

| Week | Starts (Monday) | Phase |
| --- | --- | --- |
| 1 | 2026-09-28 | Base |
| 2 | 2026-10-05 | Base |
| 3 | 2026-10-12 | Base |
| 4 | 2026-10-19 | Deload |
| 5 | 2026-10-26 | Strength |
| 6 | 2026-11-02 | Strength |
| 7 | 2026-11-09 | Strength |
| 8 | 2026-11-16 | Deload |
| 9 | 2026-11-23 | Specificity |
| 10 | 2026-11-30 | Specificity |
| 11 | 2026-12-07 | Specificity |
| 12 | 2026-12-14 | Test |

## 2. Open issues

### Plan items (12)

How to fix: Edit `seed/plan-overrides.json`. Put the item key under `items`, set the fields you want, and list the flag codes you accept in `resolve`. See the ready-to-paste examples below.

| Ref | What |
| --- | --- |
| `w04-tue-02-0` | hspu_step_from_state: Step is not named in the plan; the current progression comes from your state. (HSPU progression, "Deload: current progression 2 × 3 easy") |
| `w07-tue-02-0` | hspu_step_from_state: Step is not named in the plan; the current progression comes from your state. (HSPU progression, "Lower pad / harder progression 4 × 3") |
| `w08-tue-02-0` | hspu_step_from_state: Step is not named in the plan; the current progression comes from your state. (HSPU progression, "Deload: current progression 2 × 3 easy") |
| `w09-tue-02-0` | hspu_step_from_state: Step is not named in the plan; the current progression comes from your state. (HSPU progression, "Hardest clean progression 5 × 2–4") |
| `w10-tue-02-0` | hspu_step_from_state: Step is not named in the plan; the current progression comes from your state. (HSPU progression, "Hardest clean progression 5 × 2–4") |
| `w11-mon-01-1` | missing_reps: Extra "+ 1 easy BW set" has no rep target. (Weighted pull-up, "3 × 2–3 + 1 easy BW set") |
| `w11-tue-02-0` | hspu_step_from_state: Step is not named in the plan; the current progression comes from your state. (HSPU progression, "Hardest clean progression 4 × 2–3") |
| `w12-mon-01-0` | max_reps: Reps are open-ended (max clean reps); no rep number to store. (Clean pull-up TEST, "3 max-clean attempts; optional weighted top triple if fresh") |
| `w12-mon-01-0` | optional_extra: Optional extra: weighted top triple if fresh (Clean pull-up TEST, "3 max-clean attempts; optional weighted top triple if fresh") |
| `w12-mon-02-0` | missing_reps: No rep or duration target found. (Easy pull-down / hang, "2 easy sets, then stop") |
| `w12-tue-02-0` | hspu_step_from_state: Step is not named in the plan; the current progression comes from your state. (HSPU progression, "TEST: 3–5 serious attempts; record reps + ROM / pad height") |
| `w12-tue-02-0` | max_reps: Reps are open-ended (max clean reps); no rep number to store. (HSPU progression, "TEST: 3–5 serious attempts; record reps + ROM / pad height") |

**hspu_step_from_state**: Accept: your current HSPU step decides. Add the key with `resolve: ["hspu_step_from_state"]`.

```json
"w04-tue-02-0": { "resolve": ["hspu_step_from_state"] }
```

**missing_reps**: Enter reps, or accept open reps.

```json
"w11-mon-01-1": { "reps_min": 8, "reps_max": 8, "resolve": ["missing_reps"] }
"w11-mon-01-1": { "resolve": ["missing_reps"] }
```

**max_reps**: Accept: test = as many clean reps as possible.

```json
"w12-mon-01-0": { "resolve": ["max_reps"] }
```

**optional_extra**: Accept: the optional part stays as text.

```json
"w12-mon-01-0": { "resolve": ["optional_extra"] }
```

### Equipment (9)

How to fix: Edit `seed/equipment.json`. Fill `base_kg` (empty bar or unloaded sled), `step_kg` (smallest weight step) or `discrete_values` (list of available weights), and `bands` (colour to kg) for the pull-up bar.

| Ref | What |
| --- | --- |
| `barbell` | Barbell (total incl. bar): step_kg and discrete_values are both empty. |
| `barbell` | Barbell (total incl. bar): base_kg is empty (weight of the empty bar or unloaded sled). |
| `dumbbells` | Dumbbells (per hand): step_kg and discrete_values are both empty. |
| `cable_stack` | Cable stack: step_kg and discrete_values are both empty. |
| `row_machine` | Row machine stack: step_kg and discrete_values are both empty. |
| `hack_squat` | Hack squat (plates on sled): step_kg and discrete_values are both empty. |
| `hack_squat` | Hack squat (plates on sled): base_kg is empty (weight of the empty bar or unloaded sled). |
| `pullup` | Pull-up bar (added weight, bands): step_kg and discrete_values are both empty. |
| `pullup` | Pull-up bar (added weight, bands): bands is empty (band colour to kg of assistance). |

### HSPU ladder (2)

How to fix: Edit `seed/hspu-ladder.json`. Fill `default_sets`, `default_reps_min` and `default_reps_max` for the step.

| Ref | What |
| --- | --- |
| `lower_pad_wall_hspu` | Lower-pad wall HSPU: empty default_sets, default_reps_min, default_reps_max. |
| `full_wall_hspu` | Full wall HSPU: empty default_sets, default_reps_min, default_reps_max. |

### Exercises (2)

How to fix: Answer in `seed/plan-overrides.json` under `exercises`. Example: `"exercises": { "curl": { "acknowledge": true } }`. You can also change `type`, `load_basis`, `equipment_slug` or `muscle_group` there.

| Ref | What |
| --- | --- |
| `chest_supported_row` | Dumbbells per hand, or a machine stack? |
| `curl` | Curl (dumbbells, per hand) and triceps extension (cable stack) equipment is a guess — confirm both |

```json
"exercises": { "chest_supported_row": { "acknowledge": true } }
```

## 3. Exercise mapping

| Plan name | Options | Type | Load basis | Equipment | Main | Tags | Note |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Pull warm-up | pull_warmup | warmup | - | - | no | warmup |  |
| Clean strict pull-up | pull_up | bodyweight_plus | bodyweight_plus | pullup | yes | skill_strength, vertical_pull |  |
| Chest-supported row | chest_supported_row | weighted | per_hand | dumbbells | no | row | Dumbbells per hand, or a machine stack? |
| Romanian deadlift | romanian_deadlift | weighted | barbell_total | barbell | yes | hinge |  |
| Lat pulldown | lat_pulldown | weighted | stack | cable_stack | no | vertical_pull |  |
| Hanging leg raise / knee raise | hanging_leg_raise / hanging_knee_raise | bodyweight_reps / bodyweight_reps | - / - | pullup / pullup | no / no | core |  |
| Push + handstand warm-up | push_handstand_warmup | warmup | - | - | no | warmup |  |
| Handstand practice | handstand | skill_practice | - | - | no | skill_practice |  |
| HSPU progression | hspu | skill_ladder | - | - | no | skill_strength, vertical_press |  |
| Overhead press | overhead_press | weighted | barbell_total | barbell | yes | vertical_press |  |
| Bench press | bench_press | weighted | barbell_total | barbell | yes | horizontal_press |  |
| Squat / hack squat | squat / hack_squat | weighted / weighted | barbell_total / stack | barbell / hack_squat | yes / yes | squat |  |
| Lateral raise | lateral_raise | weighted | per_hand | dumbbells | no | accessory |  |
| Bike warm-up | bike_warmup | warmup | - | - | no | warmup |  |
| Bike HIIT | bike_hiit | hiit | - | - | no | hiit |  |
| Bike cool-down | bike_cooldown | warmup | - | - | no | warmup |  |
| Wrists + shoulders | wrists_shoulders | mobility | - | - | no | mobility |  |
| Thoracic + hips + ankles | thoracic_hips_ankles | mobility | - | - | no | mobility |  |
| Hamstrings + hip flexors | hamstrings_hip_flexors | mobility | - | - | no | mobility |  |
| Calisthenics class | calisthenics_class | class | - | - | no | class |  |
| Thursday exposure | class_exposure | class | - | - | no | class |  |
| Full-body warm-up | full_body_warmup | warmup | - | - | no | warmup |  |
| Incline DB bench | incline_db_bench | weighted | per_hand | dumbbells | no | horizontal_press |  |
| Cable / machine row | cable_row / machine_row | weighted / weighted | stack / stack | cable_stack / row_machine | no / no | row |  |
| Bulgarian split squat | bulgarian_split_squat | weighted | per_hand | dumbbells | no | unilateral_leg |  |
| Face pull | face_pull | weighted | stack | cable_stack | no | prehab |  |
| Curl OR triceps extension | curl / triceps_extension | weighted / weighted | per_hand / stack | dumbbells / cable_stack | no / no | accessory | Curl (dumbbells, per hand) and triceps extension (cable stack) equipment is a guess — confirm both |
| Clean strict pull-up — deload | pull_up | bodyweight_plus | bodyweight_plus | pullup | yes | skill_strength, vertical_pull |  |
| Weighted pull-up* | pull_up | bodyweight_plus | bodyweight_plus | pullup | yes | skill_strength, vertical_pull |  |
| Weighted pull-up — deload* | pull_up | bodyweight_plus | bodyweight_plus | pullup | yes | skill_strength, vertical_pull |  |
| Weighted pull-up | pull_up | bodyweight_plus | bodyweight_plus | pullup | yes | skill_strength, vertical_pull |  |
| Clean pull-up TEST | pull_up | bodyweight_plus | bodyweight_plus | pullup | yes | skill_strength, vertical_pull |  |
| Easy pull-down / hang | lat_pulldown / dead_hang | weighted / timed | stack / - | cable_stack / pullup | no / no | vertical_pull |  |
| Easy press back-off | overhead_press / bench_press | weighted / weighted | barbell_total / barbell_total | barbell / barbell | yes / yes | vertical_press, horizontal_press |  |
| Full-body recovery | full_body_recovery | recovery | - | - | no | recovery |  |

## 4. Parsed items

### Monday

| Weeks | Exercise | Raw | Parsed | Tags | Priority | Note | Time | Flags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1–12 | Pull warm-up | Dead hang 2×25s · scapular pull-up 2×8 · band straight-arm pulldown 1×15 | (raw text only) | warmup | Prep | Prime shoulders and scapulae without fatigue. | 5 min |  |
| 1 | Clean strict pull-up | 4 × 3 | 4×3 · RIR 1–2 | skill_strength, vertical_pull | PRIMARY | *Only use added weight once you own ~6 clean bodyweight reps. Otherwise use bodyweight 4×4–6 or assisted 4×6. | 12–16 min |  |
| 1–3 | Chest-supported row | 3 × 8 | 3×8 · RIR 1–3 | row | High | No momentum; chest stays planted. | 6–8 min |  |
| 1–3 | Romanian deadlift | 3 × 8 | 3×8 · RIR 1–2 | hinge | High | 1–2 RIR; hinge cleanly, do not chase fatigue. | 8–10 min |  |
| 1–3, 5–7, 9–11 | Lat pulldown | 2 × 8–12 | 2×8–12 · RIR 1–3 | vertical_pull | Medium | Different stimulus from pull-ups; stop short of failure. | 5 min |  |
| 1–3, 5–7, 9–11 | Hanging leg raise / knee raise | 2–3 × 8–12 | 2–3×8–12 | core | Low | Drop first when time or recovery is poor. | 4 min |  |
| 2 | Clean strict pull-up | 4 × 4 | 4×4 · RIR 1–2 | skill_strength, vertical_pull | PRIMARY | *Only use added weight once you own ~6 clean bodyweight reps. Otherwise use bodyweight 4×4–6 or assisted 4×6. | 12–16 min |  |
| 3 | Clean strict pull-up | 4 × 5 (or stop 1 rep before form breaks) | 4×5 · RIR 1–2 · stop_before_form_breaks | skill_strength, vertical_pull | PRIMARY | *Only use added weight once you own ~6 clean bodyweight reps. Otherwise use bodyweight 4×4–6 or assisted 4×6. | 12–16 min |  |
| 4 | Clean strict pull-up — deload | 2 × 3 easy | 2×3 · RIR 3–4 · easy, deload | skill_strength, vertical_pull | PRIMARY | *Only use added weight once you own ~6 clean bodyweight reps. Otherwise use bodyweight 4×4–6 or assisted 4×6. | 12–16 min |  |
| 4, 8 | Chest-supported row | 2 × 8 easy | 2×8 · RIR 3–4 · easy | row | High | No momentum; chest stays planted. | 6–8 min |  |
| 4, 8 | Romanian deadlift | 2 × 6 easy | 2×6 · RIR 3–4 · easy | hinge | High | 1–2 RIR; hinge cleanly, do not chase fatigue. | 8–10 min |  |
| 4, 8 | Lat pulldown | 1–2 × 10 easy | 1–2×10 · RIR 3–4 · easy | vertical_pull | Medium | Different stimulus from pull-ups; stop short of failure. | 5 min |  |
| 4, 8 | Hanging leg raise / knee raise | 1–2 × 8 easy | 1–2×8 · easy | core | Low | Drop first when time or recovery is poor. | 4 min |  |
| 5 | Weighted pull-up* | 4 × 3 | 4×3 · RIR 1–2 | skill_strength, vertical_pull | PRIMARY | *Only use added weight once you own ~6 clean bodyweight reps. Otherwise use bodyweight 4×4–6 or assisted 4×6. | 12–16 min |  |
| 5–7, 9–11 | Chest-supported row | 3 × 6–8 | 3×6–8 · RIR 1–3 | row | High | No momentum; chest stays planted. | 6–8 min |  |
| 5–7 | Romanian deadlift | 3 × 6 | 3×6 · RIR 1–2 | hinge | High | 1–2 RIR; hinge cleanly, do not chase fatigue. | 8–10 min |  |
| 6 | Weighted pull-up* | 4 × 3–4 | 4×3–4 · RIR 1–2 | skill_strength, vertical_pull | PRIMARY | *Only use added weight once you own ~6 clean bodyweight reps. Otherwise use bodyweight 4×4–6 or assisted 4×6. | 12–16 min |  |
| 7 | Weighted pull-up* | 5 × 3 | 5×3 · RIR 1–2 | skill_strength, vertical_pull | PRIMARY | *Only use added weight once you own ~6 clean bodyweight reps. Otherwise use bodyweight 4×4–6 or assisted 4×6. | 12–16 min |  |
| 8 | Weighted pull-up — deload* | 2–3 × 3 easy | 2–3×3 · RIR 3–4 · easy, deload | skill_strength, vertical_pull | PRIMARY | *Only use added weight once you own ~6 clean bodyweight reps. Otherwise use bodyweight 4×4–6 or assisted 4×6. | 12–16 min |  |
| 9 | Weighted pull-up | 4 × 3 heavy-clean | 4×3 · RIR 1–2 · heavy_clean | skill_strength, vertical_pull | PRIMARY | *Only use added weight once you own ~6 clean bodyweight reps. Otherwise use bodyweight 4×4–6 or assisted 4×6. | 12–16 min |  |
| 9–11 | Romanian deadlift | 3 × 5–6 | 3×5–6 · RIR 1–2 | hinge | High | 1–2 RIR; hinge cleanly, do not chase fatigue. | 8–10 min |  |
| 10 | Weighted pull-up | 4 × 2–3 slightly heavier | 4×2–3 · RIR 1–2 · slightly_heavier | skill_strength, vertical_pull | PRIMARY | *Only use added weight once you own ~6 clean bodyweight reps. Otherwise use bodyweight 4×4–6 or assisted 4×6. | 12–16 min |  |
| 11 | Weighted pull-up | 3 × 2–3 + 1 easy BW set | 3×2–3 · RIR 1–2 | skill_strength, vertical_pull | PRIMARY | *Only use added weight once you own ~6 clean bodyweight reps. Otherwise use bodyweight 4×4–6 or assisted 4×6. | 12–16 min |  |
| 11 | Weighted pull-up | 3 × 2–3 + 1 easy BW set | extra: 1×? · RIR 3–4 · easy | skill_strength, vertical_pull | PRIMARY |  | 12–16 min | **missing_reps** |
| 12 | Clean pull-up TEST | 3 max-clean attempts; optional weighted top triple if fresh | 3×? · RIR 0–1 · test, max_attempts | skill_strength, vertical_pull | PRIMARY | *Only use added weight once you own ~6 clean bodyweight reps. Otherwise use bodyweight 4×4–6 or assisted 4×6. | 12–16 min | **max_reps**, **optional_extra** |
| 12 | Easy pull-down / hang | 2 easy sets, then stop | 2×? · RIR 3–4 · easy | vertical_pull | Recovery | Do not turn test day into a normal volume session. | 5 min | **missing_reps** |

### Tuesday

| Weeks | Exercise | Raw | Parsed | Tags | Priority | Note | Time | Flags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1–12 | Push + handstand warm-up | Wrist rocks · scap push-ups · wall slides · shoulder CARs | (raw text only) | warmup | Prep | Prepare wrists and overhead position. | 6 min |  |
| 1–3, 5–7, 9–12 | Handstand practice | 5–7 min line/balance practice | 5–7 min | skill_practice | High | Stay fresh; this is practice, not conditioning. | 5 min |  |
| 1 | HSPU progression | Feet-elevated pike push-up 4 × 6 | 4×6 · step feet_elevated_pike | skill_strength, vertical_press | PRIMARY | Advance only after two clean sessions at the current progression. | 8–10 min |  |
| 1–3 | Overhead press | 3 × 6–8 | 3×6–8 · RIR 1–2 | vertical_press | High | Build the vertical-press engine for HSPU; 1–2 RIR. | 7 min |  |
| 1–3 | Bench press | 2 × 6–8 | 2×6–8 · RIR 1–2 | horizontal_press | Medium | Horizontal pressing strength; use weighted dips in a later block if preferred. | 7 min |  |
| 1–3 | Squat / hack squat | 3 × 6–8 | 3×6–8 · RIR 1–2 | squat | High | Strong controlled reps; 1–2 RIR. | 8 min |  |
| 1–3, 5–7, 9–11 | Lateral raise | 2 × 12–15 | 2×12–15 · RIR 1–3 | accessory | Low | Optional if session exceeds 50 min. | 3 min |  |
| 2 | HSPU progression | Feet-elevated pike push-up 4 × 8 | 4×8 · step feet_elevated_pike | skill_strength, vertical_press | PRIMARY | Advance only after two clean sessions at the current progression. | 8–10 min |  |
| 3 | HSPU progression | HSPU negative 3 × 3, 5s down | 3×3 · tempo 5s down · step hspu_negative | skill_strength, vertical_press | PRIMARY | Advance only after two clean sessions at the current progression. | 8–10 min |  |
| 4, 8 | Handstand practice | 4–5 min easy | 4–5 min · easy | skill_practice | High | Stay fresh; this is practice, not conditioning. | 5 min |  |
| 4, 8 | HSPU progression | Deload: current progression 2 × 3 easy | 2×3 · deload, easy | skill_strength, vertical_press | PRIMARY | Advance only after two clean sessions at the current progression. | 8–10 min | **hspu_step_from_state** |
| 4, 8 | Overhead press | 2 × 6 light | 2×6 · RIR 3–4 · light | vertical_press | High | 3–4 RIR. | 6 min |  |
| 4, 8 | Bench press | 2 × 6 light | 2×6 · RIR 3–4 · light | horizontal_press | Medium | Keep it easy. | 6 min |  |
| 4, 8 | Squat / hack squat | 2 × 6 easy | 2×6 · RIR 3–4 · easy | squat | High | 3–4 RIR. | 7 min |  |
| 4, 8 | Lateral raise | Optional 1 × 12–15 | 1×12–15 · RIR 3–4 · optional | accessory | Low | Skip freely. | 2 min |  |
| 5 | HSPU progression | Partial-ROM wall HSPU 4 × 3 | 4×3 · step partial_rom_wall_hspu | skill_strength, vertical_press | PRIMARY | Advance only after two clean sessions at the current progression. | 8–10 min |  |
| 5–7 | Overhead press | 3 × 5–6 | 3×5–6 · RIR 1–2 | vertical_press | High | Build the vertical-press engine for HSPU; 1–2 RIR. | 7 min |  |
| 5–7 | Bench press | 2–3 × 5–8 | 2–3×5–8 · RIR 1–2 | horizontal_press | Medium | Horizontal pressing strength; use weighted dips in a later block if preferred. | 7 min |  |
| 5–7 | Squat / hack squat | 3 × 5–6 | 3×5–6 · RIR 1–2 | squat | High | Strong controlled reps; 1–2 RIR. | 8 min |  |
| 6 | HSPU progression | Partial-ROM wall HSPU 4 × 4 | 4×4 · step partial_rom_wall_hspu | skill_strength, vertical_press | PRIMARY | Advance only after two clean sessions at the current progression. | 8–10 min |  |
| 7 | HSPU progression | Lower pad / harder progression 4 × 3 | 4×3 | skill_strength, vertical_press | PRIMARY | Advance only after two clean sessions at the current progression. | 8–10 min | **hspu_step_from_state** |
| 9–10 | HSPU progression | Hardest clean progression 5 × 2–4 | 5×2–4 | skill_strength, vertical_press | PRIMARY | Advance only after two clean sessions at the current progression. | 8–10 min | **hspu_step_from_state** |
| 9–11 | Overhead press | 3 × 4–6 | 3×4–6 · RIR 1–2 | vertical_press | High | Build the vertical-press engine for HSPU; 1–2 RIR. | 7 min |  |
| 9–11 | Bench press | 2 × 5–6 | 2×5–6 · RIR 1–2 | horizontal_press | Medium | Horizontal pressing strength; use weighted dips in a later block if preferred. | 7 min |  |
| 9–11 | Squat / hack squat | 3 × 4–6 | 3×4–6 · RIR 1–2 | squat | High | Strong controlled reps; 1–2 RIR. | 8 min |  |
| 11 | HSPU progression | Hardest clean progression 4 × 2–3 | 4×2–3 | skill_strength, vertical_press | PRIMARY | Advance only after two clean sessions at the current progression. | 8–10 min | **hspu_step_from_state** |
| 12 | HSPU progression | TEST: 3–5 serious attempts; record reps + ROM / pad height | 3–5×? · test, max_attempts | skill_strength, vertical_press | PRIMARY | Advance only after two clean sessions at the current progression. | 8–10 min | **hspu_step_from_state**, **max_reps** |
| 12 | Easy press back-off | OHP or bench: 2 × 5 easy | 2×5 · RIR 3–4 · easy | vertical_press, horizontal_press | Low | Only if you feel good after the HSPU test. | 6 min |  |

### Wednesday

| Weeks | Exercise | Raw | Parsed | Tags | Priority | Note | Time | Flags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1–12 | Bike warm-up | 5 min progressive easy spin | 5 min · easy | warmup | Prep |  | 5 min |  |
| 1–2 | Bike HIIT | 6 × 30s hard / 90s easy | 6×30s on/90s off | hiit | PRIMARY | Genuinely hard but controlled. Keep grip/lats fresh for Thursday. | 8–20 min |  |
| 1–12 | Bike cool-down | 4–5 min easy | 4–5 min · easy | warmup | Recovery |  | 5 min |  |
| 1–12 | Wrists + shoulders | Wrist rocks 2×10 · wall flexion 2×8 · wall slides 2×10 · bench lat stretch 2×40s | (raw text only) | mobility | High | HSPU-focused mobility. | 7–8 min |  |
| 1–12 | Thoracic + hips + ankles | Thoracic rotation 6/side · 90/90 2×6 · Cossack 2×6 · knee-to-wall 2×10 | (raw text only) | mobility | Medium | Keep it controlled, never painful. | 8 min |  |
| 1–12 | Hamstrings + hip flexors | Pike stretch 2×40s · couch stretch 60s/side | (raw text only) | mobility | Medium | Finish relaxed. | 4 min |  |
| 3 | Bike HIIT | 7 × 30s hard / 90s easy | 7×30s on/90s off | hiit | PRIMARY | Genuinely hard but controlled. Keep grip/lats fresh for Thursday. | 8–20 min |  |
| 4, 8, 12 | Bike HIIT | 4 × 30s hard / 90s easy | 4×30s on/90s off | hiit | PRIMARY | Genuinely hard but controlled. Keep grip/lats fresh for Thursday. | 8–20 min |  |
| 5–6, 11 | Bike HIIT | 8 × 30s hard / 90s easy | 8×30s on/90s off | hiit | PRIMARY | Genuinely hard but controlled. Keep grip/lats fresh for Thursday. | 8–20 min |  |
| 7, 9 | Bike HIIT | 9 × 30s hard / 90s easy | 9×30s on/90s off | hiit | PRIMARY | Genuinely hard but controlled. Keep grip/lats fresh for Thursday. | 8–20 min |  |
| 10 | Bike HIIT | 10 × 30s hard / 90s easy | 10×30s on/90s off | hiit | PRIMARY | Genuinely hard but controlled. Keep grip/lats fresh for Thursday. | 8–20 min |  |

### Thursday

| Weeks | Exercise | Raw | Parsed | Tags | Priority | Note | Time | Flags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1–3, 5–7, 9–11 | Calisthenics class | Normal class; self-regulate and avoid unnecessary failure | (raw text only) | class | PRIMARY | Priority: Pull-Up → HSPU/Handstand → general skills. Enjoy other skills without turning them into extra goals. | Class |  |
| 1–12 | Thursday exposure | Record whether class was heavy on PULL / PUSH / LEGS | (raw text only) | class | Important | These toggles automatically modify Friday guidance. | 1 min |  |
| 4, 8, 12 | Calisthenics class | Easy class; no maximal work | easy | class | PRIMARY | Priority: Pull-Up → HSPU/Handstand → general skills. Enjoy other skills without turning them into extra goals. | Class |  |

### Friday

| Weeks | Exercise | Raw | Parsed | Tags | Priority | Note | Time | Flags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1–11 | Full-body warm-up | 5 min easy bike + squat/press/row ramp-up sets | 5 min · easy | warmup | Prep | No fatigue; just prepare the patterns. | 5 min |  |
| 1–3 | Squat / hack squat | 3 × 6 | 3×6 · RIR 1–2 | squat | High | Main Friday lower-body strength. If Thursday legs were heavy: reduce to 2 easy sets. | 9–10 min |  |
| 1–3 | Incline DB bench | 3 × 8–10 | 3×8–10 · RIR 1–3 | horizontal_press | High | If Thursday push was heavy: reduce to 1–2 easy sets or skip. | 8 min |  |
| 1–3 | Cable / machine row | 3 × 8–10 | 3×8–10 · RIR 1–3 | row | High | If Thursday pull was heavy: reduce to 1–2 easy sets or skip. | 8 min |  |
| 1–3, 5–7, 9–11 | Bulgarian split squat | 2 × 8/leg | 2×8/side · RIR 1–3 | unilateral_leg | Medium | If Thursday legs were heavy: skip. | 6 min |  |
| 1–3, 5–7, 9–11 | Face pull | 2 × 12–15 | 2×12–15 · RIR 1–3 | prehab | Low | Scapular/rear-delt health. | 3 min |  |
| 1–3, 5–7, 9–11 | Curl OR triceps extension | 2 × 8–12 | 2×8–12 · RIR 1–3 | accessory | Low | Optional; choose one and rotate as desired. | 4 min |  |
| 4, 8 | Squat / hack squat | 2 × 5 easy | 2×5 · RIR 3–4 · easy | squat | High | Reduce further if Thursday had heavy legs. | 7 min |  |
| 4, 8 | Incline DB bench | 2 × 8 easy | 2×8 · RIR 3–4 · easy | horizontal_press | High | Reduce/skip if Thursday had heavy push. | 6 min |  |
| 4, 8 | Cable / machine row | 2 × 8 easy | 2×8 · RIR 3–4 · easy | row | High | Reduce/skip if Thursday had heavy pull. | 6 min |  |
| 4, 8 | Bulgarian split squat | 1 × 8/leg easy | 1×8/side · RIR 3–4 · easy | unilateral_leg | Medium | Optional if Thursday taxed legs. | 4 min |  |
| 4, 8 | Face pull | 2 × 12–15 | 2×12–15 · RIR 3–4 | prehab | Low | Easy shoulder-health work. | 3 min |  |
| 5–7 | Squat / hack squat | 3 × 4–6 | 3×4–6 · RIR 1–2 | squat | High | Main Friday lower-body strength. If Thursday legs were heavy: reduce to 2 easy sets. | 9–10 min |  |
| 5–7 | Incline DB bench | 3 × 6–8 | 3×6–8 · RIR 1–3 | horizontal_press | High | If Thursday push was heavy: reduce to 1–2 easy sets or skip. | 8 min |  |
| 5–7 | Cable / machine row | 3 × 6–8 | 3×6–8 · RIR 1–3 | row | High | If Thursday pull was heavy: reduce to 1–2 easy sets or skip. | 8 min |  |
| 9–11 | Squat / hack squat | 3 × 4–5 | 3×4–5 · RIR 1–2 | squat | High | Main Friday lower-body strength. If Thursday legs were heavy: reduce to 2 easy sets. | 9–10 min |  |
| 9–11 | Incline DB bench | 3 × 6 | 3×6 · RIR 1–3 | horizontal_press | High | If Thursday push was heavy: reduce to 1–2 easy sets or skip. | 8 min |  |
| 9–11 | Cable / machine row | 3 × 6 | 3×6 · RIR 1–3 | row | High | If Thursday pull was heavy: reduce to 1–2 easy sets or skip. | 8 min |  |
| 12 | Full-body recovery | 20–30 min easy movement + mobility | 20–30 min · easy | recovery | Recovery | No heavy lifting in test week. | 20–30 min |  |

## 5. Fallback, HSPU ladder and equipment

### Pull-up fallback (while the weighted gate is closed)

- If last bodyweight max is at least 4 clean reps: 4 × 4–6 (bodyweight).
- Otherwise: 4 × 6 (assisted).

### HSPU ladder

| Order | Step | Sets | Reps min | Reps max | Tempo |
| --- | --- | --- | --- | --- | --- |
| 1 | Feet-elevated pike push-up | 4 | 6 | 8 | - |
| 2 | HSPU negative | 3 | 3 | 3 | 5s down |
| 3 | Partial-ROM wall HSPU | 4 | 3 | 4 | - |
| 4 | Lower-pad wall HSPU | **empty** | **empty** | **empty** | - |
| 5 | Full wall HSPU | **empty** | **empty** | **empty** | - |

### Equipment

| Slug | Name | Base kg | Step kg | Discrete values | Bands |
| --- | --- | --- | --- | --- | --- |
| barbell | Barbell (total incl. bar) | **empty** | **empty** | **empty** | **empty** |
| dumbbells | Dumbbells (per hand) | **empty** | **empty** | **empty** | **empty** |
| cable_stack | Cable stack | **empty** | **empty** | **empty** | **empty** |
| row_machine | Row machine stack | **empty** | **empty** | **empty** | **empty** |
| hack_squat | Hack squat (plates on sled) | **empty** | **empty** | **empty** | **empty** |
| pullup | Pull-up bar (added weight, bands) | **empty** | **empty** | **empty** | **empty** |

