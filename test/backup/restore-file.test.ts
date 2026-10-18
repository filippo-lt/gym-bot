import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { isLocalHost, parseBackupFile, RestoreRefusedError } from "../../src/backup/restore.js";

const file = (over: Record<string, unknown> = {}) => ({
  format: "gymbot-backup",
  version: 1,
  created_at: "2026-10-18T17:00:00.000Z",
  migrations: ["abc"],
  excluded: ["chat_lease", "inbox"],
  manifest: { plans: { rows: 1, sha256: "x" } },
  tables: { plans: [{ id: 1 }] },
  ...over,
});
const bytes = (v: unknown) =>
  new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v));

function reason(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof RestoreRefusedError) return e.reason;
    throw e;
  }
  return undefined;
}

describe("parseBackupFile", () => {
  it("reads a plain file", () => {
    const b = parseBackupFile(bytes(file()), "b.json");
    expect(b.meta.migrations).toEqual(["abc"]);
    expect(b.tables.plans).toHaveLength(1);
  });

  it("round trips a gzipped file", () => {
    const b = parseBackupFile(new Uint8Array(gzipSync(bytes(file()))), "b.json.gz");
    expect(b.tables.plans).toEqual([{ id: 1 }]);
  });

  it("refuses bad JSON", () => {
    expect(reason(() => parseBackupFile(bytes("{nope"), "b.json"))).toBe("not_backup");
  });

  it("refuses bad gzip", () => {
    expect(reason(() => parseBackupFile(bytes("plain"), "b.json.gz"))).toBe("not_backup");
  });

  it("refuses a wrong format or version", () => {
    expect(reason(() => parseBackupFile(bytes(file({ format: "other" })), "b.json"))).toBe(
      "not_backup",
    );
    expect(reason(() => parseBackupFile(bytes(file({ version: 2 })), "b.json"))).toBe("not_backup");
  });

  it("refuses a row count that differs from the manifest", () => {
    const f = file({ tables: { plans: [{ id: 1 }, { id: 2 }] } });
    expect(reason(() => parseBackupFile(bytes(f), "b.json"))).toBe("manifest_mismatch");
  });
});

describe("isLocalHost", () => {
  it("accepts local hosts only", () => {
    for (const h of ["localhost", "127.0.0.1", "::1", "[::1]"]) expect(isLocalHost(h)).toBe(true);
    for (const h of ["db.supabase.co", "10.0.0.5", "localhost.evil.com"])
      expect(isLocalHost(h)).toBe(false);
  });
});
