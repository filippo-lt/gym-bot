import { describe, expect, it } from "vitest";
import type { BackupMeta } from "../../src/backup/export.js";
import { backupSummary } from "../../src/backup/summary.js";

const meta: BackupMeta = {
  format: "gymbot-backup",
  version: 1,
  created_at: "2026-10-25T18:00:00.000Z",
  migrations: [],
  excluded: [],
  manifest: {
    a_empty: { rows: 0, sha256: "x" },
    log_groups: { rows: 1234, sha256: "x" },
    "we<ird": { rows: 4, sha256: "x" },
  },
};
const now = new Date("2026-10-25T18:00:00Z"); // 19:00 Rome

describe("backupSummary", () => {
  it("lists non-zero tables first, zero ones last, and escapes names", () => {
    const t = backupSummary(meta, now, null);
    expect(t).toContain("Backup of 25 Oct 2026, 19:00 (Rome).");
    expect(t).toContain("Rows: log_groups 1,234, we&lt;ird 4, a_empty 0");
    expect(t).not.toContain("This week");
    expect(t).toContain("Keep these files: they are your only restore point.");
  });

  it("adds the weekly line with caps", () => {
    const t = backupSummary(meta, now, {
      tokens: 45678,
      sttSeconds: 720,
      caps: { tokens: 200000, sttSeconds: 1800 },
    });
    expect(t).toContain(
      "This week: 45,678 tokens, 12 min voice.\nDaily caps: 200,000 tokens, 30 min voice.",
    );
  });

  it("drops the caps when unknown", () => {
    const t = backupSummary(meta, now, {
      tokens: 5,
      sttSeconds: 60,
      caps: { tokens: null, sttSeconds: null },
    });
    expect(t).toContain("This week: 5 tokens, 1 min voice.");
    expect(t).not.toContain("Daily caps");
  });
});
