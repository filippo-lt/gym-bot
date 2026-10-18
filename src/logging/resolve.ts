/**
 * Resolution: turns what the model staged (words, slugs, loose numbers) into DB-ready values.
 * Exercise, planned item, units, HSPU step, required fields and the last-session reference
 * are all decided here, in code.
 */
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { getSession } from "../bot/session.js";
import { logGroups } from "../db/schema/log.js";
import { plannedItems } from "../db/schema/plan.js";
import { trainingDate } from "../domain/calendar.js";
import { type CatalogExercise, type LadderStep, loadCatalog, loadLadder } from "./catalog.js";
import type { Db, Q } from "./db.js";
import { dateLabel, describeEntries } from "./describe.js";
import { lastBotGroup, lastSessionRef, latestBwKg } from "./groups.js";
import { activeAliases, normalizeAlias } from "./memory.js";
import {
  addDays,
  type DayPlan,
  loadDayPlan,
  loadPlanContext,
  type PlanContext,
  pickItem,
  WEEKDAY_ORDER,
  weekRefFor,
} from "./plan-context.js";
import type {
  Candidate,
  Day,
  EditLastInput,
  GetSessionInput,
  GroupSnapshot,
  LoggingBackend,
  LogSetsInput,
  MatchKind,
  PlannedItemInfo,
  ResolvedEntry,
  ResolvedExercise,
  ResolvedLog,
  StagedAction,
  StageResult,
  UndoLastInput,
} from "./types.js";
import { buildEntries, convertLoad, expandSets, missingFields } from "./units.js";
import { checkConflicts, checkKeys, usedKeys } from "./validate.js";

export const MAX_CANDIDATES = 6;
/** Slots kept for fuzzy matches when today's session already fills the list. */
const RESERVED_FUZZY = 3;
/** A different exercise must score at least this much (and twice the slug's) to contradict a slug. */
const RIVAL_MIN_SCORE = 5;
/** A given slug needs at least this fuzzy score against the user's words ("pullups" = 1.5). */
export const SLUG_FIT_FLOOR = 1.5;

// ---------------------------------------------------------------------------
// Fuzzy candidates (pure)

interface Labelled {
  slug: string;
  name: string;
  aliases?: string[];
}

/** 0 = no match. Whole-label, prefix/substring, token overlap and initials ("fp" = Face pull). */
export function fuzzyScore(said: string, target: Labelled): number {
  const q = normalizeAlias(said);
  if (!q) return 0;
  const qTokens = q.split(" ");
  let best = 0;
  for (const raw of [target.name, target.slug, ...(target.aliases ?? [])]) {
    const label = normalizeAlias(raw);
    if (!label) continue;
    if (label === q) {
      best = Math.max(best, 10);
      continue;
    }
    let s = 0;
    if (q.length >= 2 && (label.startsWith(q) || q.startsWith(label))) s = Math.max(s, 6);
    if (q.length >= 3 && label.includes(q)) s = Math.max(s, 5);
    const lTokens = label.split(" ");
    let overlap = 0;
    for (const t of qTokens) {
      if (lTokens.includes(t)) overlap += 2;
      else if (t.length >= 3 && lTokens.some((l) => l.startsWith(t) || t.startsWith(l))) {
        overlap += 1.5;
      }
    }
    s = Math.max(s, overlap);
    const initials = lTokens.map((t) => t[0]).join("");
    if (!q.includes(" ") && q.length >= 2 && q.length <= 4 && initials === q) s = Math.max(s, 4);
    best = Math.max(best, s);
  }
  return best;
}

/** Today's session exercises first (session order), then the best fuzzy matches, max 6. */
export function rankCandidates(
  said: string,
  catalog: Labelled[],
  todayExercises: Candidate[],
  max = MAX_CANDIDATES,
): Candidate[] {
  const todaySlugs = new Set<string>();
  const today: Candidate[] = [];
  for (const c of todayExercises) {
    if (todaySlugs.has(c.slug)) continue;
    todaySlugs.add(c.slug);
    today.push({ slug: c.slug, name: c.name });
  }
  const fuzzy = catalog
    .filter((c) => !todaySlugs.has(c.slug))
    .map((c) => ({ c, score: fuzzyScore(said, c) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.c.name.localeCompare(b.c.name))
    .map((x) => ({ slug: x.c.slug, name: x.c.name }));
  const todayRoom = max - Math.min(RESERVED_FUZZY, fuzzy.length);
  const out = today.slice(0, todayRoom);
  for (const f of fuzzy) {
    if (out.length >= max) break;
    out.push(f);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Exercise resolution

/**
 * The model gave a slug AND the user's words. Exact words win over the slug; with no exact
 * match the slug stands only when the words plausibly name it, otherwise ask (slug first).
 * Pure, so the phrasing cases are unit-tested against the real catalog.
 */
export function judgeGivenSlug(
  saidRaw: string,
  given: Labelled,
  catalog: Labelled[],
  /** Slug of the exercise an active memory alias maps these words to. */
  aliasSlug?: string,
): { kind: "ok"; slug: string } | { kind: "clarify"; candidates: Candidate[] } {
  const said = normalizeAlias(saidRaw);
  const slugged = said.replaceAll(" ", "_");
  const exact = catalog.filter(
    (c) =>
      c.slug === slugged ||
      c.slug === aliasSlug ||
      normalizeAlias(c.name) === said ||
      (c.aliases ?? []).some((a) => normalizeAlias(a) === said),
  );
  if (exact.some((c) => c.slug === given.slug)) return { kind: "ok", slug: given.slug };
  if (exact.length === 1) return { kind: "ok", slug: (exact[0] as Labelled).slug };
  const cand = (c: Labelled): Candidate => ({ slug: c.slug, name: c.name });
  if (exact.length > 1) return { kind: "clarify", candidates: exact.map(cand) };
  const own = fuzzyScore(saidRaw, given);
  const rivals = catalog
    .filter((c) => c.slug !== given.slug)
    .map((c) => ({ c, score: fuzzyScore(saidRaw, c) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  const top = rivals[0];
  const outranked = top !== undefined && top.score >= RIVAL_MIN_SCORE && own * 2 < top.score;
  if (own >= SLUG_FIT_FLOOR && !outranked) return { kind: "ok", slug: given.slug };
  return { kind: "clarify", candidates: [given, ...rivals.slice(0, 3).map((r) => r.c)].map(cand) };
}

type ExerciseOutcome =
  | { kind: "ok"; exercise: CatalogExercise }
  | { kind: "clarify"; candidates: Candidate[] };

async function pickExercise(
  db: Q,
  ex: LogSetsInput["exercise"],
  catalog: CatalogExercise[],
  target: DayPlan,
  trustSlug = false,
): Promise<ExerciseOutcome> {
  const said = normalizeAlias(ex.said);
  const ok = (exercise: CatalogExercise): ExerciseOutcome => ({ kind: "ok", exercise });

  // "squat / hack squat" said without an option: the item's options are the candidates.
  if (!ex.slug) {
    const orItem = target.items.find(
      (i) => i.options.length > 1 && normalizeAlias(i.info.planName) === said,
    );
    if (orItem) {
      return {
        kind: "clarify",
        candidates: orItem.options.map((o) => ({ slug: o.slug, name: o.name })),
      };
    }
  }

  const aliases = await activeAliases(db);
  const aliasRow = aliases.find((a) => a.alias === said);
  const nameMatches = (c: CatalogExercise) =>
    normalizeAlias(c.name) === said || c.aliases.some((a) => normalizeAlias(a) === said);
  const saidSlugged = said.replaceAll(" ", "_");

  // 1. exact catalog slug. The user's own words win when they name another exercise exactly
  // ("hack squat" with slug squat); when they only look like one, ask.
  const bySlug = ex.slug ? catalog.find((c) => c.slug === ex.slug) : undefined;
  // A button tap is the user's own choice: no fit-judgement against the original words.
  if (bySlug && trustSlug) return ok(bySlug);
  if (bySlug) {
    const verdict = judgeGivenSlug(
      ex.said,
      bySlug,
      catalog,
      aliasRow ? catalog.find((c) => c.id === aliasRow.exerciseId)?.slug : undefined,
    );
    if (verdict.kind === "ok")
      return ok(catalog.find((c) => c.slug === verdict.slug) as CatalogExercise);
    return verdict;
  }
  const saidSlug = catalog.find((c) => c.slug === saidSlugged);
  if (saidSlug) return ok(saidSlug);

  // 2. active alias
  const byAlias = aliasRow ? catalog.find((c) => c.id === aliasRow.exerciseId) : undefined;
  if (byAlias) return ok(byAlias);

  // 3. catalog name / aliases
  const byName = catalog.filter(nameMatches);
  if (byName.length === 1) return ok(byName[0] as CatalogExercise);
  if (byName.length > 1) {
    return { kind: "clarify", candidates: byName.map((c) => ({ slug: c.slug, name: c.name })) };
  }

  // 4. ask
  const todayExercises = target.items.flatMap((i) =>
    i.options.map((o) => ({ slug: o.slug, name: o.name })),
  );
  return { kind: "clarify", candidates: rankCandidates(ex.said, catalog, todayExercises) };
}

// ---------------------------------------------------------------------------
// Planned item

function dateForDay(ctx: PlanContext | null, today: string, day: Day | undefined): string {
  if (!day || day === "today" || !ctx) return today;
  const ref = weekRefFor(ctx, today);
  if (!ref) return today;
  return addDays(ref.mondayDate, WEEKDAY_ORDER.indexOf(day));
}

interface PlannedMatch {
  match: MatchKind;
  info: PlannedItemInfo | null;
  hspuStepId: number | null;
  sessionDate: string;
}

async function findPlanned(
  db: Q,
  ctx: PlanContext | null,
  exerciseId: number,
  today: string,
  target: DayPlan,
): Promise<PlannedMatch> {
  const item = pickItem(target.items, exerciseId);
  if (item) {
    return {
      match: target.date === today ? "today" : "makeup",
      info: item.info,
      hspuStepId: item.hspuStepId,
      sessionDate: target.date,
    };
  }
  const unplanned: PlannedMatch = {
    match: "unplanned",
    info: null,
    hspuStepId: null,
    sessionDate: today,
  };
  if (target.date !== today || !ctx) return unplanned;
  const ref = weekRefFor(ctx, today);
  if (!ref) return unplanned;
  for (let i = Math.min(ref.dayIndex, 5) - 1; i >= 0; i -= 1) {
    const plan = await loadDayPlan(db, ctx, addDays(ref.mondayDate, i));
    const open = plan.items.find(
      (it) => !it.hasGroup && it.options.some((o) => o.id === exerciseId),
    );
    if (open) {
      return {
        match: "makeup",
        info: open.info,
        hspuStepId: open.hspuStepId,
        sessionDate: plan.date,
      };
    }
  }
  return unplanned;
}

// ---------------------------------------------------------------------------
// HSPU step

async function resolveHspuStep(
  db: Q,
  exerciseId: number,
  requested: string | undefined,
  plannedStepId: number | null,
  ladder: LadderStep[],
): Promise<LadderStep | null> {
  const bySlug = requested ? ladder.find((s) => s.slug === requested) : undefined;
  if (bySlug) return bySlug;
  const [last] = await db
    .select({ stepId: logGroups.hspuStepId })
    .from(logGroups)
    .where(and(eq(logGroups.exerciseId, exerciseId), isNotNull(logGroups.hspuStepId)))
    .orderBy(desc(logGroups.performedAt), desc(logGroups.id))
    .limit(1);
  const fromLast = last?.stepId != null ? ladder.find((s) => s.id === last.stepId) : undefined;
  if (fromLast) return fromLast;
  return plannedStepId != null ? (ladder.find((s) => s.id === plannedStepId) ?? null) : null;
}

// ---------------------------------------------------------------------------
// resolveLog

export type ResolveOutcome =
  | { kind: "ok"; log: ResolvedLog }
  | { kind: "clarify"; said: string; candidates: Candidate[] }
  | { kind: "error"; error: string };

const asResolvedExercise = (c: CatalogExercise): ResolvedExercise => ({
  id: c.id,
  slug: c.slug,
  name: c.name,
  type: c.type,
  loadBasis: c.loadBasis,
  isMainLift: c.isMainLift,
  needsClean: c.needsClean,
  equipment: c.equipment,
});

export async function resolveLog(
  db: Q,
  input: LogSetsInput,
  now: Date,
  opts: { trustSlug?: boolean } = {},
): Promise<ResolveOutcome> {
  const today = trainingDate(now);
  const ctx = await loadPlanContext(db, today);
  const catalog = await loadCatalog(db);
  const ladder = await loadLadder(db);
  const targetDate = dateForDay(ctx, today, input.day);
  const target = await loadDayPlan(db, ctx, targetDate);

  if (input.hspu_step && !ladder.some((s) => s.slug === input.hspu_step)) {
    return { kind: "error", error: `Unknown HSPU step "${input.hspu_step}".` };
  }

  const picked = await pickExercise(db, input.exercise, catalog, target, opts.trustSlug);
  if (picked.kind === "clarify") {
    return { kind: "clarify", said: input.exercise.said, candidates: picked.candidates };
  }
  const exercise = asResolvedExercise(picked.exercise);
  const sets = expandSets(input.sets);
  const invalid =
    checkKeys(exercise, usedKeys({ hspu_step: input.hspu_step, clean: input.clean }, ...sets), {
      checkClean: true,
    }) ?? sets.map((st) => checkConflicts(exercise, st)).find((e) => e !== null && e !== undefined);
  if (invalid) return { kind: "error", error: invalid };

  const planned = await findPlanned(db, ctx, exercise.id, today, target);
  const entries = buildEntries(exercise, input.sets, { rir: input.rir, clean: input.clean });
  const bwKg = await latestBwKg(db);
  const missing = missingFields(exercise, entries);

  let hspuStep: Candidate | null = null;
  if (exercise.type === "skill_ladder") {
    const step = await resolveHspuStep(
      db,
      exercise.id,
      input.hspu_step,
      planned.hspuStepId,
      ladder,
    );
    if (step) hspuStep = { slug: step.slug, name: step.name };
    else missing.push("hspu_step");
  }

  return {
    kind: "ok",
    log: {
      said: input.exercise.said,
      exercise,
      sessionDate: planned.sessionDate,
      match: planned.match,
      plannedItem: planned.info,
      hspuStep,
      entries,
      bwKg,
      note: input.note ?? null,
      missingFields: missing,
      guessedFields: input.guessed_fields,
      needsConfirmation: input.needs_confirmation,
      lastSession: await lastSessionRef(db, exercise, today),
    },
  };
}

// ---------------------------------------------------------------------------
// Staging

const fail = (error: string): StageResult => ({ ok: false, error });
const TAIL = "The bot will save or confirm it. Do not repeat numbers.";

function previewLog(log: ResolvedLog): string {
  const where =
    log.match === "today"
      ? "today's session"
      : log.match === "makeup"
        ? "make-up of an earlier planned session"
        : "not in today's plan";
  const missing = log.missingFields.length > 0 ? ` Missing: ${log.missingFields.join(", ")}.` : "";
  return `Staged: ${log.exercise.name} ${describeEntries(log.entries)} for ${dateLabel(log.sessionDate)} (${where}).${missing} ${TAIL}`;
}

export async function stageLogSets(db: Q, input: LogSetsInput, now: Date): Promise<StageResult> {
  const r = await resolveLog(db, input, now);
  if (r.kind === "error") return fail(r.error);
  if (r.kind === "clarify") {
    return {
      ok: true,
      action: { kind: "clarify_exercise", input, said: r.said, candidates: r.candidates },
      preview: "Exercise unclear; the bot will ask the user with buttons. Stop.",
    };
  }
  return {
    ok: true,
    action: { kind: "log_sets", input, resolved: r.log },
    preview: previewLog(r.log),
  };
}

/** Candidate chosen from the clarify buttons: re-resolve with that slug. */
/** The tapped candidate can't take what the user said (e.g. plates on a stack). */
export class ClarifiedInvalidError extends Error {
  constructor(
    readonly exerciseName: string,
    readonly reason: string,
  ) {
    super(reason);
    this.name = "ClarifiedInvalidError";
  }
}

/** The tap doesn't match any candidate, or it no longer resolves. */
export class ClarifyChoiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClarifyChoiceError";
  }
}

export async function resolveClarified(
  db: Q,
  action: Extract<StagedAction, { kind: "clarify_exercise" }>,
  candidateSlug: string,
  now: Date,
): Promise<Extract<StagedAction, { kind: "log_sets" }>> {
  if (!action.candidates.some((c) => c.slug === candidateSlug)) {
    throw new ClarifyChoiceError("not one of the candidates");
  }
  const input: LogSetsInput = {
    ...action.input,
    exercise: { slug: candidateSlug, said: action.said },
  };
  const r = await resolveLog(db, input, now, { trustSlug: true });
  if (r.kind === "error") {
    const name = action.candidates.find((c) => c.slug === candidateSlug)?.name ?? candidateSlug;
    throw new ClarifiedInvalidError(name, r.error);
  }
  if (r.kind !== "ok") throw new ClarifyChoiceError("could not resolve the chosen exercise");
  return { kind: "log_sets", input, resolved: r.log };
}

const LOAD_KEYS = [
  "load_kg",
  "plates_per_side_kg",
  "pair_total_kg",
  "added_kg",
  "assist_kg",
  "band",
] as const;

function loadSignature(e: ResolvedEntry): string {
  return `${e.loadKg}|${e.addedKg}|${e.assistKg}`;
}

function applyChanges(
  e: ResolvedEntry,
  c: EditLastInput["changes"],
  exercise: ResolvedExercise,
): ResolvedEntry {
  const out = { ...e };
  if (c.reps !== undefined) out.reps = c.reps;
  if (exercise.type === "bodyweight_plus") {
    const added = c.added_kg ?? c.load_kg;
    if (added !== undefined) out.addedKg = added;
    if (c.assist_kg !== undefined) out.assistKg = c.assist_kg;
    // "assisted 20" means no added weight, and vice versa.
    if (added === undefined && c.assist_kg !== undefined) out.addedKg = 0;
    if (added !== undefined && c.assist_kg === undefined) out.assistKg = 0;
  } else if (
    c.load_kg !== undefined ||
    c.plates_per_side_kg !== undefined ||
    c.pair_total_kg !== undefined
  ) {
    const load = convertLoad(exercise, c);
    // checkKeys rejects every combination that can't convert before we get here.
    if (load === null) throw new Error("unreachable: load not convertible after validation");
    out.loadKg = load;
  }
  if (c.duration_s !== undefined) out.durationS = c.duration_s;
  if (c.distance_m !== undefined) out.distanceM = c.distance_m;
  if (c.pad_height !== undefined) out.padHeight = c.pad_height;
  if (c.band !== undefined) out.note = `band: ${c.band}`;
  return out;
}

export async function stageEdit(db: Q, input: EditLastInput, now: Date): Promise<StageResult> {
  const before = await lastBotGroup(db);
  if (!before) return fail("Nothing to edit.");
  const catalog = await loadCatalog(db);
  const ladder = await loadLadder(db);
  const c = input.changes;

  const current = catalog.find((x) => x.id === before.exercise.id);
  if (!current) return fail("Nothing to edit.");
  let exercise: CatalogExercise = current;
  if (c.exercise_slug && c.exercise_slug !== current.slug) {
    const moved = catalog.find((x) => x.slug === c.exercise_slug);
    if (!moved) return fail(`Unknown exercise "${c.exercise_slug}".`);
    exercise = moved;
  }
  const step = c.hspu_step ? ladder.find((s) => s.slug === c.hspu_step) : undefined;
  if (c.hspu_step && !step) return fail(`Unknown HSPU step "${c.hspu_step}".`);

  const invalid =
    checkKeys(exercise, usedKeys(c), { checkClean: true }) ?? checkConflicts(exercise, c);
  if (invalid) return fail(invalid);

  const count = before.entries.length;
  const setIndexes = input.set_indexes
    ? [...new Set(input.set_indexes)].sort((a, b) => a - b)
    : before.entries.map((e) => e.setIndex);
  const bad = setIndexes.find((i) => !before.entries.some((e) => e.setIndex === i));
  if (bad !== undefined) return fail(`The last entry has ${count} sets; there is no set ${bad}.`);

  const touchesLoad = LOAD_KEYS.some((k) => c[k] !== undefined);
  if (touchesLoad && !input.set_indexes && new Set(before.entries.map(loadSignature)).size > 1) {
    return fail("The sets have different loads. Ask the user which sets to change.");
  }

  const lastChanged = Math.max(...setIndexes);
  const entries = before.entries.map((e) => {
    let out = setIndexes.includes(e.setIndex) ? applyChanges(e, c, exercise) : { ...e };
    if (c.clean !== undefined && setIndexes.includes(e.setIndex)) out.clean = c.clean;
    if (c.rir !== undefined && e.setIndex === lastChanged) {
      out = { ...out, rir: c.rir === "4+" ? 4 : c.rir, rirPlus: c.rir === "4+" };
    }
    return out;
  });

  const exerciseChanged = exercise.id !== current.id;
  let plannedItemId = before.plannedItemId;
  if (exerciseChanged) {
    const ctx = await loadPlanContext(db, before.sessionDate);
    const plan = await loadDayPlan(db, ctx, before.sessionDate);
    plannedItemId = pickItem(plan.items, exercise.id)?.info.id ?? null;
  }
  let plannedRepsMax: number | null = null;
  if (plannedItemId !== null) {
    const [p] = await db
      .select({ repsMax: plannedItems.repsMax })
      .from(plannedItems)
      .where(eq(plannedItems.id, plannedItemId));
    plannedRepsMax = p?.repsMax ?? null;
  }
  const hspuStep = step ? { slug: step.slug, name: step.name } : before.hspuStep;
  const groupChanged = exerciseChanged || step !== undefined || c.note !== undefined;
  if (!groupChanged && JSON.stringify(entries) === JSON.stringify(before.entries)) {
    return fail("The edit would not change anything.");
  }

  const after: GroupSnapshot = {
    ...before,
    exercise: {
      id: exercise.id,
      slug: exercise.slug,
      name: exercise.name,
      type: exercise.type,
      loadBasis: exercise.loadBasis,
      equipment: exercise.equipment,
    },
    plannedItemId,
    hspuStep,
    entries,
  };
  const lastSession = await lastSessionRef(db, exercise, trainingDate(now), before.groupId);
  const sets =
    setIndexes.length === count
      ? "all sets"
      : `set${setIndexes.length > 1 ? "s" : ""} ${setIndexes.join(", ")}`;
  return {
    ok: true,
    action: {
      kind: "edit_group",
      input,
      before,
      after,
      setIndexes,
      lastSession,
      plannedRepsMax,
    },
    preview: `Staged edit of ${before.exercise.name} (${dateLabel(before.sessionDate)}, ${sets}): now ${exercise.name} ${describeEntries(entries)}. ${TAIL}`,
  };
}

export async function stageUndoLast(db: Q, _now: Date): Promise<StageResult> {
  const snapshot = await lastBotGroup(db);
  if (!snapshot) return fail("Nothing to undo.");
  return {
    ok: true,
    action: { kind: "delete_group", snapshot },
    preview: `Staged removal of ${snapshot.exercise.name} ${describeEntries(snapshot.entries)} (${dateLabel(snapshot.sessionDate)}). The bot will ask the user to confirm. Do not repeat numbers.`,
  };
}

// ---------------------------------------------------------------------------
// Backend for the AI loop

const range = (min: number | null, max: number | null): string | null =>
  min === null ? null : max === null || max === min ? String(min) : `${min}-${max}`;

export interface BackendOptions {
  /** The chat's unsaved request, if any: edits and undo then act on nothing but saved logs. */
  openPending?: { summary: string } | null;
}

export function createLoggingBackend(
  db: Db,
  now: Date | (() => Date),
  options: BackendOptions = {},
): LoggingBackend {
  const clock = () => (typeof now === "function" ? now() : now);
  const blocked = (): StageResult | null =>
    options.openPending
      ? fail(
          `There is an unsaved request (${options.openPending.summary}). Restate the full corrected request with log_sets instead.`,
        )
      : null;
  return {
    async getSession(input: GetSessionInput) {
      const t = clock();
      const today = trainingDate(t);
      const ctx = await loadPlanContext(db, today);
      const date = dateForDay(ctx, today, input.day);
      const s = await getSession(db, date);
      if (s.kind === "before_start") return { kind: "before_start", startDate: s.startDate };
      if (s.kind === "finished") return { kind: "plan_finished" };
      if (s.kind === "rest") {
        return { kind: "rest_day", date: s.date, week: s.week, phase: s.phase };
      }
      return {
        kind: "session",
        date: s.date,
        weekday: s.weekday,
        week: s.week,
        phase: s.phase,
        focus: s.focus,
        deload: s.isDeload,
        items: s.items.map((i) => ({
          name: i.planName,
          options: i.options.map((o) => o.slug),
          sets: range(i.setsMin, i.setsMax),
          reps: range(i.repsMin, i.repsMax),
          prescription: i.prescriptionRaw,
          rir: range(i.rirMin, i.rirMax),
          status: i.status,
        })),
      };
    },
    stageLogSets: (input) => stageLogSets(db, input, clock()),
    stageEdit: async (input) => blocked() ?? stageEdit(db, input, clock()),
    stageUndoLast: async (_input: UndoLastInput) => blocked() ?? stageUndoLast(db, clock()),
  };
}
