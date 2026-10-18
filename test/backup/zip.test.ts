import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { zip } from "../../src/backup/zip.js";

const dir = mkdtempSync(join(tmpdir(), "gymbot-zip-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("zip", () => {
  it("writes entries that unzip reads back byte for byte", () => {
    const a = "﻿id,name\r\n1,caffè\r\n".repeat(200);
    const b = "tiny";
    const file = join(dir, "t.zip");
    writeFileSync(
      file,
      zip([
        { name: "a.csv", data: new TextEncoder().encode(a) },
        { name: "b.csv", data: new TextEncoder().encode(b) },
      ]),
    );
    expect(execFileSync("unzip", ["-p", file, "a.csv"]).toString("utf8")).toBe(a);
    expect(execFileSync("unzip", ["-p", file, "b.csv"]).toString("utf8")).toBe(b);
    expect(() => execFileSync("unzip", ["-tq", file])).not.toThrow();
  });

  it("sets the UTF-8 name flag", () => {
    const bytes = zip([{ name: "è.csv", data: new Uint8Array([1]) }]);
    expect(Buffer.from(bytes).readUInt16LE(6) & 0x0800).toBe(0x0800);
  });

  it("handles an empty file", () => {
    const file = join(dir, "e.zip");
    writeFileSync(file, zip([{ name: "e.csv", data: new Uint8Array() }]));
    expect(execFileSync("unzip", ["-p", file, "e.csv"]).length).toBe(0);
  });
});
