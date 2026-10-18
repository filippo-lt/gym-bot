import { describe, expect, it, vi } from "vitest";
import { downloadTelegramFile, FileTooLargeError } from "../../src/telegram/files.js";

const TOKEN = "123:SECRET-TOKEN";

describe("downloadTelegramFile", () => {
  it("rejects files over maxBytes", async () => {
    const fetchImpl = vi.fn();
    const api = { getFile: async () => ({ file_path: "voice/a.oga", file_size: 500 }) };
    await expect(
      downloadTelegramFile({ api, token: TOKEN, fileId: "f", maxBytes: 100, fetchImpl }),
    ).rejects.toBeInstanceOf(FileTooLargeError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a body over maxBytes", async () => {
    const api = { getFile: async () => ({ file_path: "voice/a.oga" }) };
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(500)));
    await expect(
      downloadTelegramFile({ api, token: TOKEN, fileId: "f", maxBytes: 100, fetchImpl }),
    ).rejects.toBeInstanceOf(FileTooLargeError);
  });

  it("returns the bytes", async () => {
    const api = { getFile: async () => ({ file_path: "voice/a.oga", file_size: 3 }) };
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    const out = await downloadTelegramFile({
      api,
      token: TOKEN,
      fileId: "f",
      maxBytes: 100,
      fetchImpl,
    });
    expect([...out]).toEqual([1, 2, 3]);
  });

  it("error never contains the token", async () => {
    const api = { getFile: async () => ({ file_path: "voice/a.oga" }) };
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 404 }));
    const err = await downloadTelegramFile({
      api,
      token: TOKEN,
      fileId: "f",
      maxBytes: 100,
      fetchImpl,
    }).catch((e) => e);
    expect(err.message).toContain("404");
    expect(err.message).not.toContain("SECRET-TOKEN");
    const noPath = await downloadTelegramFile({
      api: { getFile: async () => ({}) },
      token: TOKEN,
      fileId: "f",
      maxBytes: 100,
      fetchImpl,
    }).catch((e) => e);
    expect(noPath.message).not.toContain("SECRET-TOKEN");
  });
});
