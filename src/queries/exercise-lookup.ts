/** Pure: turns the words of a query ("hack squat", "fp") into one catalog exercise, or candidates. */
import type { CatalogExercise } from "../logging/catalog.js";
import { loadCatalog } from "../logging/catalog.js";
import type { Db } from "../logging/db.js";
import type { AliasRow } from "../logging/memory.js";
import { activeAliases, normalizeAlias } from "../logging/memory.js";
import { fuzzyScore, judgeGivenSlug, SLUG_FIT_FLOOR } from "../logging/resolve.js";

export const MAX_LOOKUP_CANDIDATES = 4;
/** The top fuzzy match must beat the runner-up by this much to be taken without asking. */
const CLEAR_MARGIN = 2;
const FUZZY_MIN_UNIQUE = 4;

export interface LookupCandidate {
  id: number;
  slug: string;
  name: string;
}

export type ExerciseLookup =
  | { kind: "ok"; exercise: CatalogExercise }
  | { kind: "ambiguous"; candidates: LookupCandidate[] }
  | { kind: "unknown" };

const cand = (c: CatalogExercise): LookupCandidate => ({ id: c.id, slug: c.slug, name: c.name });

function exactMatches(
  said: string,
  catalog: CatalogExercise[],
  aliases: AliasRow[],
): CatalogExercise[] {
  const slugged = said.replaceAll(" ", "_");
  const aliasSlugs = new Set(aliases.filter((a) => a.alias === said).map((a) => a.slug));
  return catalog.filter(
    (c) =>
      c.slug === slugged ||
      aliasSlugs.has(c.slug) ||
      normalizeAlias(c.name) === said ||
      c.aliases.some((a) => normalizeAlias(a) === said),
  );
}

function fuzzyRanked(said: string, catalog: CatalogExercise[]) {
  return catalog
    .map((c) => ({ c, score: fuzzyScore(said, c) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.c.name.localeCompare(b.c.name));
}

function uniqueBySlug(list: CatalogExercise[]): CatalogExercise[] {
  const seen = new Set<string>();
  return list.filter((c) => {
    if (seen.has(c.slug)) return false;
    seen.add(c.slug);
    return true;
  });
}

/** One option of an OR phrase ("squat / hack squat"): an exact match or a clear fuzzy top. */
function pickOne(
  part: string,
  catalog: CatalogExercise[],
  aliases: AliasRow[],
): CatalogExercise | null {
  const said = normalizeAlias(part);
  if (!said) return null;
  const exact = exactMatches(said, catalog, aliases);
  if (exact.length === 1) return exact[0] as CatalogExercise;
  if (exact.length > 1) return null;
  const ranked = fuzzyRanked(part, catalog);
  const [top, second] = ranked;
  if (
    top &&
    top.score >= FUZZY_MIN_UNIQUE &&
    (!second || top.score - second.score >= CLEAR_MARGIN)
  ) {
    return top.c;
  }
  return null;
}

/**
 * Order: a given slug (validated against the words), exact slug / alias / name, an OR phrase,
 * a clear fuzzy winner, else up to four candidates, else unknown.
 */
export function resolveExerciseQuery(
  saidRaw: string,
  slug: string | undefined,
  catalog: CatalogExercise[],
  aliases: AliasRow[],
): ExerciseLookup {
  const said = normalizeAlias(saidRaw);
  const bySlug = slug ? catalog.find((c) => c.slug === slug) : undefined;

  if (bySlug) {
    const aliasSlug = aliases.find((a) => a.alias === said)?.slug;
    const verdict = judgeGivenSlug(saidRaw, bySlug, catalog, aliasSlug);
    if (verdict.kind === "ok") {
      const hit = catalog.find((c) => c.slug === verdict.slug) as CatalogExercise;
      return { kind: "ok", exercise: hit };
    }
    const candidates = verdict.candidates
      .map((c) => catalog.find((x) => x.slug === c.slug))
      .filter((c): c is CatalogExercise => !!c)
      .slice(0, MAX_LOOKUP_CANDIDATES)
      .map(cand);
    return { kind: "ambiguous", candidates };
  }
  if (!said) return { kind: "unknown" };

  const exact = exactMatches(said, catalog, aliases);
  if (exact.length === 1) return { kind: "ok", exercise: exact[0] as CatalogExercise };
  if (exact.length > 1) {
    return {
      kind: "ambiguous",
      candidates: uniqueBySlug(exact).slice(0, MAX_LOOKUP_CANDIDATES).map(cand),
    };
  }

  // "squat / hack squat", "squat or hack squat": the options are the candidates.
  const parts = saidRaw.split(/\s*\/\s*|\s+or\s+/i).filter((p) => p.trim());
  if (parts.length >= 2) {
    const options = uniqueBySlug(
      parts.map((p) => pickOne(p, catalog, aliases)).filter((c): c is CatalogExercise => !!c),
    );
    if (options.length >= 2) {
      return {
        kind: "ambiguous",
        candidates: options.slice(0, MAX_LOOKUP_CANDIDATES).map(cand),
      };
    }
  }

  const ranked = fuzzyRanked(saidRaw, catalog);
  const [top, second] = ranked;
  if (!top || top.score < SLUG_FIT_FLOOR) return { kind: "unknown" };
  if (top.score >= FUZZY_MIN_UNIQUE && (!second || top.score - second.score >= CLEAR_MARGIN)) {
    return { kind: "ok", exercise: top.c };
  }
  return {
    kind: "ambiguous",
    candidates: ranked.slice(0, MAX_LOOKUP_CANDIDATES).map((x) => cand(x.c)),
  };
}

/** Loads the catalog and the user's aliases (sequentially), then resolves. */
export async function lookupExercise(db: Db, said: string, slug?: string): Promise<ExerciseLookup> {
  const catalog = await loadCatalog(db);
  const aliases = await activeAliases(db);
  return resolveExerciseQuery(said, slug, catalog, aliases);
}
