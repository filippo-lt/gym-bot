import { DateTime } from "luxon";
import { APP_TIMEZONE } from "../config/constants.js";
import type {
  ItemTarget,
  ReadinessLevel,
  ReadinessResult,
  ReadinessSignal,
  SessionRec,
  Weekday,
} from "./types.js";

const HOUR_MS = 3_600_000;
/** Chat and button signals expire after 24 h. */
export const SHORT_EXPIRY_MS = 24 * HOUR_MS;
/** Weekly recovery <= 2 (dated to that week's Friday) expires after 3 days. */
export const RECOVERY_EXPIRY_MS = 72 * HOUR_MS;

const CHAT_KINDS = new Set<ReadinessSignal["kind"]>([
  "chat_bad_sleep",
  "chat_sore",
  "chat_exhausted",
]);

const romeDay = (iso: string): string =>
  DateTime.fromISO(iso, { zone: APP_TIMEZONE }).toISODate() ?? iso;

/**
 * Combine signals into GREEN/YELLOW/RED (SPEC 5.6c exact formula, with expiry as of `asOf`, ISO timestamp).
 *
 * - Each signal counts once: the 😴 button; chat bad sleep / soreness / exhausted (ONE chat signal in total);
 *   recovery <= 2; drift per lift.
 * - 0 -> GREEN, 1 -> YELLOW, 2+ -> RED (drift on 2+ lifts is 2+ signals, so it is RED too).
 * - 💪 cancels every chat signal of the same Rome calendar day; 🙂 adds nothing.
 * - Expiry: a signal is valid while `asOf - at <= 24 h` (button/chat) or `<= 72 h` (recovery); signals dated after
 *   `asOf` are ignored. Drift has no time expiry here: it lives "until the next session of that lift", so the CALLER
 *   drops a lift's drift signal once that lift is logged in a later session.
 *
 * Freezing (SPEC 5.6c): pure on purpose. The caller computes the level once at session start with `asOf` = that moment,
 * stores it (SessionInput.frozenLevel) and from then on uses the stored level instead of calling this again; drift
 * produced during/after the session is only fed in for the NEXT session.
 */
export function readinessLevel(signals: ReadinessSignal[], asOf: string): ReadinessResult {
  const now = DateTime.fromISO(asOf).toMillis();
  const live = signals.filter((s) => {
    const age = now - DateTime.fromISO(s.at).toMillis();
    if (Number.isNaN(age) || age < 0) return false;
    if (s.kind === "recovery_low") return age <= RECOVERY_EXPIRY_MS;
    if (s.kind === "drift") return true;
    return age <= SHORT_EXPIRY_MS;
  });

  const strongDays = new Set(
    live.filter((s) => s.kind === "button_strong").map((s) => romeDay(s.at)),
  );
  const latest = (a: ReadinessSignal | undefined, b: ReadinessSignal) =>
    !a || b.at > a.at ? b : a;

  let tired: ReadinessSignal | undefined;
  let chat: ReadinessSignal | undefined;
  let recovery: ReadinessSignal | undefined;
  const drift = new Map<number | undefined, ReadinessSignal>();
  for (const s of live) {
    if (s.kind === "button_tired") tired = latest(tired, s);
    else if (CHAT_KINDS.has(s.kind)) {
      if (!strongDays.has(romeDay(s.at))) chat = latest(chat, s);
    } else if (s.kind === "recovery_low") recovery = latest(recovery, s);
    else if (s.kind === "drift") drift.set(s.lift, latest(drift.get(s.lift), s));
  }
  const counted = [tired, chat, recovery, ...drift.values()].filter(
    (s): s is ReadinessSignal => s !== undefined,
  );
  const level: ReadinessLevel =
    counted.length === 0 ? "GREEN" : counted.length === 1 ? "YELLOW" : "RED";
  return { level, counted };
}

/**
 * Drift of a finished session vs its stored suggestion: reps_done + RIR_logged <= reps_min + rir_mid - 2 on the last
 * logged set (SPEC 5.6c). Returns true when drift applies. Compared with the stored suggestion (the target), never
 * with "last time". Pure: only completed sessions are passed in, so a session can never change its own readiness.
 * Not applicable (false): no stored suggestion, YELLOW/RED session, deload/test, imports with unknown sets, or when the
 * last set was not done at the suggested load (when both are known).
 */
export function driftFor(session: SessionRec, target: ItemTarget): boolean {
  const sug = session.suggestion;
  if (!sug) return false;
  if (session.readiness === "YELLOW" || session.readiness === "RED") return false;
  if (session.isDeload || session.isTest || target.isDeload || target.isTest) return false;
  if (session.perSetUnknown) return false;
  const last = [...session.sets].reverse().find((s) => s.reps !== null && s.rir !== null);
  if (!last || last.reps === null || last.rir === null) return false;
  if (sug.systemLoad !== null) {
    let done: number | null = last.loadKg;
    if (done === null && session.bwKg !== null && last.addedKg !== null) {
      done = session.bwKg + last.addedKg - (last.assistKg ?? 0);
    }
    if (done !== null && Math.abs(done - sug.systemLoad) > 1e-6) return false;
  }
  return last.reps + last.rir <= sug.repsMin + sug.rirMid - 2;
}

export interface ReadinessItemChange {
  hidden?: boolean;
  hiit?: { rounds: number; work_s: number; rest_s: number } | null;
  rirMid?: number;
  easy?: { sets: 2; rirMin: 3; rirMax: 4 };
}

const MAIN_TAGS = new Set([
  "squat",
  "hinge",
  "horizontal_press",
  "vertical_press",
  "row",
  "vertical_pull",
  "unilateral_leg",
]);

/** Default main-lift test: PRIMARY/High strength item with a compound-movement tag, not easy/deload/test. */
export function isMainLiftDefault(item: ItemTarget): boolean {
  if (item.isDeload || item.isTest) return false;
  if (item.modifiers.some((m) => m === "easy" || m === "light" || m === "test" || m === "deload"))
    return false;
  if (item.priority !== "PRIMARY" && item.priority !== "High") return false;
  return item.tags.some((t) => MAIN_TAGS.has(t));
}

const isSkill = (i: ItemTarget) =>
  i.tags.includes("skill_strength") || i.tags.includes("skill_practice");

/**
 * Apply the level to items (SPEC 5.6c table). Returns, per plannedItemId, what changes; GREEN returns an empty map.
 * - YELLOW: hide `Low` (skill work is cut last: never hidden here), HIIT rounds halved rounded down (8 -> 4; 0 rounds
 *   -> hidden), main lifts keep reps and get `rirMid: 2.5` (the engine recomputes the load).
 * - RED: keep skill_strength/skill_practice (as `easy`: 2 sets RIR 3-4), mobility, warm-up/recovery and class items
 *   untouched; everything else, HIIT included, is hidden. Never filtered by priority (Wednesday's PRIMARY is HIIT).
 * - `restDay`: Friday, RED, and nothing but warm-ups left. `classAdvice`: RED on Thursday ("go easy in class or skip").
 * `isMainLift` overrides the default heuristic (the engine knows `ExerciseInfo.isMainLift`).
 */
export function applyReadiness(
  items: ItemTarget[],
  level: ReadinessLevel,
  weekday: Weekday,
  isMainLift: (item: ItemTarget) => boolean = isMainLiftDefault,
): { perItem: Map<number, ReadinessItemChange>; restDay: boolean; classAdvice: boolean } {
  const perItem = new Map<number, ReadinessItemChange>();
  let restDay = false;
  if (level === "YELLOW") {
    for (const item of items) {
      const change: ReadinessItemChange = {};
      if (item.hiit) {
        const rounds = Math.floor(item.hiit.rounds / 2);
        if (rounds < 1) {
          change.hidden = true;
          change.hiit = null;
        } else change.hiit = { ...item.hiit, rounds };
      } else if (item.priority === "Low" && !isSkill(item)) change.hidden = true;
      else if (isMainLift(item)) change.rirMid = 2.5;
      if (Object.keys(change).length > 0) perItem.set(item.plannedItemId, change);
    }
  } else if (level === "RED") {
    let kept = 0;
    for (const item of items) {
      const t = item.tags;
      if (item.hiit || t.includes("hiit"))
        perItem.set(item.plannedItemId, { hidden: true, hiit: null });
      else if (isSkill(item)) {
        perItem.set(item.plannedItemId, { easy: { sets: 2, rirMin: 3, rirMax: 4 } });
        kept++;
      } else if (t.includes("mobility")) kept++;
      else if (t.includes("warmup") || t.includes("recovery") || t.includes("class")) {
        // kept as written; not counted as "something left" for the rest-day check
      } else perItem.set(item.plannedItemId, { hidden: true });
    }
    restDay = weekday === "fri" && kept === 0;
  }
  return { perItem, restDay, classAdvice: level === "RED" && weekday === "thu" };
}

/**
 * Text-only proposal to move the next deload earlier (SPEC 5.6c, default 12; applying it needs plan versioning).
 * `levelsBySession`: frozen session levels, oldest first. `recoveryByWeek`: weekly recovery scores, oldest first
 * (null = not recorded). True when the last 2 sessions were both RED, or the last 2 weekly scores are both <= 2.
 */
export function earlierDeloadHint(
  levelsBySession: ReadinessLevel[],
  recoveryByWeek: (number | null)[],
): boolean {
  const l = levelsBySession.slice(-2);
  if (l.length === 2 && l.every((x) => x === "RED")) return true;
  const r = recoveryByWeek.slice(-2);
  return r.length === 2 && r.every((x) => x !== null && x <= 2);
}
