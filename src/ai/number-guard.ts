/**
 * Number guard (SPEC §3): every number in a model reply must appear in a
 * source the model was given (tool results, prompt context, user message).
 *
 * Known gaps: numbers written as words ("three", "tre") are not checked, and a
 * comma list without spaces ("5,6,7") reads as one decimal ("5.6" then 7).
 */
export type GuardResult = { ok: true } | { ok: false; unknown: string[] };

const NUMBER_RE = /\d+(?:[.,]\d+)?/g;
const LETTER_RE = /\p{L}/u;

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= "0" && c <= "9";
}

/** A letter glued to a digit run. "x"/"×" between digits is a separator, not a letter. */
function isGluedLetter(text: string, idx: number, step: 1 | -1): boolean {
  const c = text[idx];
  if (c === undefined || !LETTER_RE.test(c)) return false;
  if ((c === "x" || c === "X") && isDigit(text[idx + step])) return false;
  return true;
}

function canonical(raw: string): string {
  return (Math.round(Number(raw.replace(",", ".")) * 100) / 100).toString();
}

/**
 * Calls `emit` with each non-skipped token, its canonical full value and, for
 * "a.b" / "a,b" tokens, the canonical value of each side.
 */
function scan(text: string, emit: (token: string, full: string, sides: string[]) => void): void {
  for (const m of text.matchAll(NUMBER_RE)) {
    const token = m[0];
    const start = m.index;
    const end = start + token.length;
    if (isGluedLetter(text, start - 1, -1) && isGluedLetter(text, end, 1)) continue;
    const sep = token.search(/[.,]/);
    const sides = sep > 0 ? [canonical(token.slice(0, sep)), canonical(token.slice(sep + 1))] : [];
    emit(token, canonical(token), sides);
  }
}

/** "26.10": dot, 1-2 digit day (1..31) and 2 digit month (1..12). */
function dateParts(token: string): [string, string] | null {
  const m = /^(\d{1,2})\.(\d{2})$/.exec(token);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  return [canonical(m[1] as string), canonical(m[2] as string)];
}

/**
 * Every number in `reply` must appear in at least one of `sources`.
 * A decimal must match as a whole ("12.5" in a source never allows 12 or 5);
 * only a date-shaped dot token in the reply ("26.10") may pass through its two
 * sides being integer tokens of the sources.
 */
export function checkNumbers(reply: string, sources: string[]): GuardResult {
  const allowed = new Set<string>();
  for (const s of sources) {
    scan(s, (_t, full) => allowed.add(full));
  }
  const unknown: string[] = [];
  const seen = new Set<string>();
  scan(reply, (token, full) => {
    if (seen.has(token) || allowed.has(full)) return;
    const d = dateParts(token);
    if (d && allowed.has(d[0]) && allowed.has(d[1])) return;
    seen.add(token);
    unknown.push(token);
  });
  return unknown.length === 0 ? { ok: true } : { ok: false, unknown };
}
