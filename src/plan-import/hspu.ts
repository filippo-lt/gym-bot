/** Maps the prescription prefix of an HSPU row to a ladder step. */

export type HspuMatch =
  | { kind: "step"; step: string; rest: string }
  | { kind: "state"; rest: string };

const STEP_PREFIXES: { re: RegExp; step: string }[] = [
  { re: /^feet-elevated pike push-up\b/i, step: "feet_elevated_pike" },
  { re: /^hspu negative\b/i, step: "hspu_negative" },
  { re: /^partial-rom wall hspu\b/i, step: "partial_rom_wall_hspu" },
];

/** The user's own state decides the step for these prefixes. */
const STATE_PREFIXES: RegExp[] = [
  /^lower pad\s*\/\s*harder progression\b/i,
  /^hardest clean progression\b/i,
  /^current progression\b/i,
];

export function matchHspuPrefix(text: string): HspuMatch | null {
  const s = text.trim();
  for (const { re, step } of STEP_PREFIXES) {
    const m = re.exec(s);
    if (m) return { kind: "step", step, rest: s.slice(m[0].length).trim() };
  }
  for (const re of STATE_PREFIXES) {
    const m = re.exec(s);
    if (m) return { kind: "state", rest: s.slice(m[0].length).trim() };
  }
  return null;
}
