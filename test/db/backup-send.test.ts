import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BackupTooLargeError, sendBackup } from "../../src/backup/send.js";
import type { Message } from "../../src/bot/log-format.js";
import { type JobContext, runDueJobs } from "../../src/jobs/runner.js";
import { isLastChance, weeklyBackupJob } from "../../src/jobs/weekly-backup.js";
import { connect, resetAndSeed } from "./logging-fixture.js";

const { sql, db } = connect();
afterAll(async () => {
  await sql.end({ timeout: 5 });
});
beforeEach(async () => {
  await resetAndSeed(db, sql);
  await sql`truncate table job_runs restart identity`;
  texts.length = 0;
  files.length = 0;
  log.length = 0;
});

const log: string[] = [];
const texts: Message[] = [];
const files: { name: string; data: Uint8Array }[] = [];
const ctxAt = (iso: string, failFile = false): JobContext => ({
  db,
  now: new Date(iso),
  send: async (m) => {
    texts.push(m);
    log.push("text");
  },
  sendFile: async (f) => {
    if (failFile) throw new Error("boom");
    files.push({ name: f.name, data: f.data });
    log.push("file");
  },
});

describe("weekly backup window", () => {
  const at = (iso: string) => weeklyBackupJob.window(new Date(iso));
  it("Sunday 18:00 to 23:00 Rome only", () => {
    expect(at("2026-10-25T16:59:00Z")).toBeNull(); // 17:59 CET
    expect(at("2026-10-25T17:00:00Z")).toEqual({ date: "2026-10-25" });
    expect(at("2026-10-25T21:59:00Z")).toEqual({ date: "2026-10-25" });
    expect(at("2026-10-25T22:00:00Z")).toBeNull();
    expect(at("2026-10-24T16:00:00Z")).toBeNull(); // Saturday
  });
  it("isLastChance from 22:30 Rome", () => {
    expect(isLastChance(new Date("2026-10-25T21:29:00Z"))).toBe(false);
    expect(isLastChance(new Date("2026-10-25T21:30:00Z"))).toBe(true);
  });
});

describe("weekly backup job", () => {
  it("sends one text, then the JSON and the zip", async () => {
    const r = await runDueJobs(ctxAt("2026-10-25T18:00:00Z"), [weeklyBackupJob]);
    expect(r).toEqual([{ job: "weekly_backup", date: "2026-10-25", outcome: "sent" }]);
    expect(log).toEqual(["text", "file", "file"]);
    expect(texts[0]?.text).toContain("This week:");
    expect(files.map((f) => f.name)).toEqual([
      "gymbot-backup-2026-10-25.json",
      "gymbot-backup-2026-10-25-csv.zip",
    ]);
    const parsed = JSON.parse(new TextDecoder().decode(files[0]?.data));
    expect(parsed.format).toBe("gymbot-backup");
  });

  it("a failing send before the last chance sends no failure text", async () => {
    const r = await runDueJobs(ctxAt("2026-10-25T18:00:00Z", true), [weeklyBackupJob]);
    expect(r[0]?.outcome).toBe("failed");
    expect(texts.map((t) => t.text).filter((t) => t.startsWith("Weekly backup failed"))).toEqual(
      [],
    );
  });

  it("a failing send on the last chance sends the failure text", async () => {
    const r = await runDueJobs(ctxAt("2026-10-25T21:45:00Z", true), [weeklyBackupJob]);
    expect(r[0]?.outcome).toBe("failed");
    const last = texts[texts.length - 1]?.text ?? "";
    expect(last).toMatch(/^Weekly backup failed \(.+\)\. Use \/export or pnpm backup\.$/);
  });
});

describe("weekly backup too large", () => {
  it("is announced once, and the job finishes", async () => {
    const mod = await import("../../src/backup/send.js");
    const spy = vi
      .spyOn(mod, "sendBackup")
      .mockRejectedValue(new mod.BackupTooLargeError(50 * 1024 * 1024));
    const r = await runDueJobs(ctxAt("2026-10-25T21:45:00Z"), [weeklyBackupJob]);
    spy.mockRestore();
    expect(r[0]?.outcome).toBe("sent");
    expect(texts.map((t) => t.text)).toEqual([
      "Weekly backup too large for Telegram (50.0 MB). Run pnpm backup locally (no size limit).",
    ]);
  });
});

describe("sendBackup", () => {
  it("refuses an oversize file and sends nothing", async () => {
    const ctx = ctxAt("2026-10-25T18:00:00Z");
    await expect(
      sendBackup({
        db,
        now: ctx.now,
        send: ctx.send,
        sendFile: ctx.sendFile,
        weekly: null,
        maxBytes: 10,
      }),
    ).rejects.toBeInstanceOf(BackupTooLargeError);
    expect(texts).toHaveLength(0);
    expect(files).toHaveLength(0);
  });
});
