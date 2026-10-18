import { describe, expect, it } from "vitest";
import { toCsv } from "../../src/backup/csv.js";

describe("toCsv", () => {
  it("starts with a BOM, then the header in column order, CRLF rows", () => {
    const out = toCsv(["b", "a"], [{ a: 1, b: "x" }]);
    expect(out.charCodeAt(0)).toBe(0xfeff);
    expect(out.slice(1)).toBe("b,a\r\nx,1\r\n");
  });

  it("quotes cells with quotes, commas and newlines, doubling quotes", () => {
    const out = toCsv(["c"], [{ c: 'say "hi"' }, { c: "a,b" }, { c: "l1\nl2" }, { c: "l1\rl2" }]);
    expect(out.slice(1)).toBe('c\r\n"say ""hi"""\r\n"a,b"\r\n"l1\nl2"\r\n"l1\rl2"\r\n');
  });

  it("renders null, undefined, booleans, arrays and objects", () => {
    const out = toCsv(
      ["n", "u", "t", "arr", "obj"],
      [{ n: null, t: true, arr: ["a", "b"], obj: { k: 1 } }],
    );
    expect(out.slice(1)).toBe('n,u,t,arr,obj\r\n,,true,"[""a"",""b""]","{""k"":1}"\r\n');
  });

  it("writes only the header for no rows", () => {
    expect(toCsv(["a", "b"], []).slice(1)).toBe("a,b\r\n");
  });
});
