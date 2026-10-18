import { Bot, type Transformer } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { describe, expect, it } from "vitest";
import { BackupTooLargeError, type sendBackup } from "../../src/backup/send.js";
import { HELP_TEXT } from "../../src/bot/bot.js";
import { createExportCommand } from "../../src/bot/export-command.js";
import type { Db } from "../../src/db/seed-plan.js";

const botInfo = {
  id: 1,
  is_bot: true,
  first_name: "GymBot",
  username: "gymbot",
} as UserFromGetMe;

async function run(backup: typeof sendBackup) {
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const transformer: Transformer = async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: true } as never;
  };
  const bot = new Bot("123:abc", { botInfo });
  bot.api.config.use(transformer);
  bot.command("export", createExportCommand({ db: {} as Db, now: () => new Date(), backup }));
  await bot.handleUpdate({
    update_id: 1,
    message: {
      message_id: 1,
      date: 1,
      chat: { id: 5, type: "private", first_name: "x" },
      from: { id: 5, is_bot: false, first_name: "x" },
      text: "/export",
      entities: [{ type: "bot_command", offset: 0, length: 7 }],
    },
  });
  return calls;
}

describe("/export", () => {
  it("is in the help text", () => {
    expect(HELP_TEXT).toContain("/export");
  });

  it("replies, then the summary and two documents", async () => {
    const calls = await run(async (a) => {
      await a.send({ text: "summary", keyboard: [] });
      await a.sendFile({ kind: "document", name: "a.json", data: new Uint8Array([1]) });
      await a.sendFile({ kind: "document", name: "b.zip", data: new Uint8Array([2]) });
    });
    expect(calls.map((c) => c.method)).toEqual([
      "sendMessage",
      "sendMessage",
      "sendDocument",
      "sendDocument",
    ]);
    expect(calls[0]?.payload.text).toBe("Preparing your backup…");
    expect(calls[1]?.payload.text).toBe("summary");
  });

  it("explains an oversize backup", async () => {
    const calls = await run(async () => {
      throw new BackupTooLargeError(50 * 1024 * 1024);
    });
    expect(calls[1]?.payload.text).toBe(
      "Backup too large for Telegram (50.0 MB). Run pnpm backup locally (no size limit).",
    );
  });

  it("never rethrows other errors", async () => {
    const calls = await run(async () => {
      throw new Error("secret sql");
    });
    const text = String(calls[1]?.payload.text);
    expect(text).toMatch(/^Backup failed \(.+\)\. Please try again\.$/);
    expect(text).not.toContain("secret");
  });
});
