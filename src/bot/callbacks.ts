/** Inline-button callback data. Telegram allows at most 64 bytes per button. */

export type PendingAct = "ok" | "ed" | "no";

export type CallbackAction =
  | { t: "pa"; id: number; act: PendingAct }
  | { t: "ex"; pendingId: number; index: number }
  | { t: "rir"; groupId: number; value: number }
  | { t: "cl"; groupId: number; clean: boolean }
  | { t: "ug"; groupId: number }
  | { t: "ue"; key: string; index: number }
  | { t: "md"; id: number };

export const CALLBACK_MAX_BYTES = 64;

export const cb = {
  pending: (id: number, act: PendingAct) => `pa:${id}:${act}`,
  exercise: (pendingId: number, index: number) => `ex:${pendingId}:${index}`,
  /** value 4 means "4+". */
  rir: (groupId: number, value: number) => `rir:${groupId}:${value}`,
  clean: (groupId: number, clean: boolean) => `cl:${groupId}:${clean ? 1 : 0}`,
  undoGroup: (groupId: number) => `ug:${groupId}`,
  /** `key` is the write_ledger source key, e.g. "u:123456" or "p:42". */
  undoEdit: (key: string, index: number) => `ue:${key}:${index}`,
  memory: (id: number) => `md:${id}`,
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
      return pendingId === null || index === null || parts.length !== 3
        ? null
        : { t: "ex", pendingId, index };
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
    case "md": {
      const id = int(a);
      return id === null || parts.length !== 2 ? null : { t: "md", id };
    }
    default:
      return null;
  }
}
