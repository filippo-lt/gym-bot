/** Inline-button callback data. Telegram allows at most 64 bytes per button. */

export type PendingAct = "ok" | "ed" | "no";

export type CallbackAction =
  | { t: "pa"; id: number; act: PendingAct }
  /** `action` is the clarify's position in the request; null on buttons sent before it was encoded. */
  | { t: "ex"; pendingId: number; index: number; action: number | null }
  | { t: "rir"; groupId: number; value: number }
  | { t: "cl"; groupId: number; clean: boolean }
  | { t: "ug"; groupId: number }
  | { t: "ue"; key: string; index: number }
  | { t: "md"; id: number }
  /** Undo of a direct readiness / bodyweight / class write: the ledger row it belongs to. */
  | { t: "uw"; key: string; index: number }
  /** /readiness: t = tired, o = ok, s = strong. */
  | { t: "rd"; level: "t" | "o" | "s"; morningDate?: string }
  /** /class toggles: `mask` is the selection after the tap (pull 1, push 2, legs 4); `save` = Save tapped. */
  | { t: "cg"; mask: number; date: string; save: boolean }
  /** Class-with-moves card (a pending): `mask` is the heavy selection after the tap; `save` = Save tapped. */
  | { t: "cm"; id: number; mask: number; save: boolean }
  /** HSPU advance proposal. */
  | { t: "pr"; id: number; act: "ok" | "no" }
  /** /skip list: one planned item of that date, or the whole session. */
  | { t: "sk"; date: string; item: number | "all" }
  | { t: "us"; key: string; index: number }
  /** Swap questions: t = only that day, r = rest of plan, d = this weekday only, a = every day. */
  | { t: "sw"; id: number; ans: "t" | "r" | "d" | "a" }
  /** Undo of a plan change: the ledger row it belongs to ("p:<pendingId>" or "r:<proposalId>"). */
  | { t: "up"; key: string; index: number };

export const CALLBACK_MAX_BYTES = 64;

export const cb = {
  pending: (id: number, act: PendingAct) => `pa:${id}:${act}`,
  /** `index` is the candidate, `action` the clarify it belongs to (a message can hold several). */
  exercise: (pendingId: number, index: number, action: number) =>
    `ex:${pendingId}:${index}:${action}`,
  /** value 4 means "4+". */
  rir: (groupId: number, value: number) => `rir:${groupId}:${value}`,
  clean: (groupId: number, clean: boolean) => `cl:${groupId}:${clean ? 1 : 0}`,
  undoGroup: (groupId: number) => `ug:${groupId}`,
  /** `key` is the write_ledger source key, e.g. "u:123456" or "p:42". */
  undoEdit: (key: string, index: number) => `ue:${key}:${index}`,
  memory: (id: number) => `md:${id}`,
  undoWrite: (key: string, index: number) => `uw:${key}:${index}`,
  readiness: (level: "t" | "o" | "s") => `rd:${level}`,
  /** Morning-message buttons: the message's own date rides along as YYYYMMDD. */
  readinessMorning: (level: "t" | "o" | "s", date: string) =>
    `rd:${level}:m:${date.replaceAll("-", "")}`,
  /** The class Thursday (ISO date) rides along as YYYYMMDD, so a late Save lands on the card's own day. */
  classMask: (mask: number, date: string) => `cg:${mask}:${date.replaceAll("-", "")}`,
  classSave: (mask: number, date: string) => `cg:${mask}:${date.replaceAll("-", "")}:ok`,
  classMoves: (pendingId: number, mask: number) => `cm:${pendingId}:${mask}`,
  classMovesSave: (pendingId: number, mask: number) => `cm:${pendingId}:${mask}:ok`,
  proposal: (id: number, act: "ok" | "no") => `pr:${id}:${act}`,
  /** `date` is YYYY-MM-DD; sent without dashes to save bytes. */
  skip: (date: string, item: number | "all") => `sk:${date.replaceAll("-", "")}:${item}`,
  /** `key` is the write_ledger source key, like undoEdit. */
  undoSkip: (key: string, index: number) => `us:${key}:${index}`,
  swap: (pendingId: number, ans: "t" | "r" | "d" | "a") => `sw:${pendingId}:${ans}`,
  /** `key` is the write_ledger source key ("p:42" or "r:7"). */
  undoPlan: (key: string, index: number) => `up:${key}:${index}`,
  /** /history for one exercise. Not part of CallbackAction: parsed by parseHistoryCallback. */
  history: (exerciseId: number) => `hx:${exerciseId}`,
  /** /chart for one exercise, or "v" for the volume chart. Not part of CallbackAction: parsed by parseChartCallback. */
  chart: (exerciseId: number | "v") => `ch:${exerciseId}`,
};

const int = (s: string | undefined): number | null =>
  s !== undefined && /^\d{1,15}$/.test(s) ? Number(s) : null;

export function parseCallback(data: string): CallbackAction | null {
  const parts = data.split(":");
  const [kind, a, b] = parts;
  switch (kind) {
    case "pa": {
      const id = int(a);
      if (id === null || parts.length !== 3 || (b !== "ok" && b !== "ed" && b !== "no")) {
        return null;
      }
      return { t: "pa", id, act: b };
    }
    case "ex": {
      const pendingId = int(a);
      const index = int(b);
      const action = parts.length === 4 ? int(parts[3]) : null;
      if (pendingId === null || index === null) return null;
      if (parts.length === 4 ? action === null : parts.length !== 3) return null;
      return { t: "ex", pendingId, index, action };
    }
    case "rir": {
      const groupId = int(a);
      const value = int(b);
      return groupId === null || value === null || value > 4 || parts.length !== 3
        ? null
        : { t: "rir", groupId, value };
    }
    case "cl": {
      const groupId = int(a);
      return groupId === null || (b !== "0" && b !== "1") || parts.length !== 3
        ? null
        : { t: "cl", groupId, clean: b === "1" };
    }
    case "ug": {
      const groupId = int(a);
      return groupId === null || parts.length !== 2 ? null : { t: "ug", groupId };
    }
    case "ue": {
      // ue:<key>:<idx>, and the key itself contains a colon ("u:123").
      const m = /^ue:([up]:\d{1,15}):(\d{1,3})$/.exec(data);
      return m ? { t: "ue", key: m[1] as string, index: Number(m[2]) } : null;
    }
    case "rd": {
      if (a !== "t" && a !== "o" && a !== "s") return null;
      if (parts.length === 2) return { t: "rd", level: a };
      const m = /^rd:[tos]:m:(\d{4})(\d{2})(\d{2})$/.exec(data);
      if (!m) return null;
      const morningDate = `${m[1]}-${m[2]}-${m[3]}`;
      if (
        Number.isNaN(Date.parse(morningDate)) ||
        new Date(morningDate).toISOString().slice(0, 10) !== morningDate
      ) {
        return null;
      }
      return { t: "rd", level: a, morningDate };
    }
    case "cg": {
      const mask = int(a);
      const d = /^(\d{4})(\d{2})(\d{2})$/.exec(b ?? "");
      if (mask === null || mask > 7 || !d) return null;
      const date = `${d[1]}-${d[2]}-${d[3]}`;
      if (parts.length === 3) return { t: "cg", mask, date, save: false };
      return parts.length === 4 && parts[3] === "ok" ? { t: "cg", mask, date, save: true } : null;
    }
    case "cm": {
      const id = int(a);
      const mask = int(b);
      if (id === null || mask === null || mask > 7) return null;
      if (parts.length === 3) return { t: "cm", id, mask, save: false };
      return parts.length === 4 && parts[3] === "ok" ? { t: "cm", id, mask, save: true } : null;
    }
    case "pr": {
      const id = int(a);
      return id === null || parts.length !== 3 || (b !== "ok" && b !== "no")
        ? null
        : { t: "pr", id, act: b };
    }
    case "uw": {
      const m = /^uw:([up]:\d{1,15}):(\d{1,3})$/.exec(data);
      return m ? { t: "uw", key: m[1] as string, index: Number(m[2]) } : null;
    }
    case "md": {
      const id = int(a);
      return id === null || parts.length !== 2 ? null : { t: "md", id };
    }
    case "sk": {
      const m = /^sk:(\d{4})(\d{2})(\d{2}):(\d{1,15}|all)$/.exec(data);
      if (!m) return null;
      const date = `${m[1]}-${m[2]}-${m[3]}`;
      // Rejects 20261340 and the like: the date must survive a round trip.
      if (Number.isNaN(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
        return null;
      }
      return { t: "sk", date, item: m[4] === "all" ? "all" : Number(m[4]) };
    }
    case "us": {
      const m = /^us:([up]:\d{1,15}):(\d{1,3})$/.exec(data);
      return m ? { t: "us", key: m[1] as string, index: Number(m[2]) } : null;
    }
    case "sw": {
      const id = int(a);
      return id === null || parts.length !== 3 || (b !== "t" && b !== "r" && b !== "d" && b !== "a")
        ? null
        : { t: "sw", id, ans: b };
    }
    case "up": {
      const m = /^up:([pr]:\d{1,15}):(\d{1,3})$/.exec(data);
      return m ? { t: "up", key: m[1] as string, index: Number(m[2]) } : null;
    }
    default:
      return null;
  }
}

/** `hx:<exerciseId>`: handled by its own bot handler, outside the logging flow's dispatch. */
export function parseHistoryCallback(data: string): { exerciseId: number } | null {
  const m = /^hx:(\d{1,9})$/.exec(data);
  return m ? { exerciseId: Number(m[1]) } : null;
}

/** `ch:<exerciseId>` or `ch:v`: handled by its own bot handler, outside the logging flow's dispatch. */
export function parseChartCallback(data: string): { exerciseId: number } | { volume: true } | null {
  if (data === "ch:v") return { volume: true };
  const m = /^ch:(\d{1,9})$/.exec(data);
  return m ? { exerciseId: Number(m[1]) } : null;
}
