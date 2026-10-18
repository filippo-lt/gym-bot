import { describe, expect, it } from "vitest";
import { pickPhoto } from "../../src/bot/pick-photo.js";

const MAX = 1000;

describe("pickPhoto", () => {
  it("takes the largest size when all fit", () => {
    const sizes = [
      { file_id: "s", file_size: 100 },
      { file_id: "m", file_size: 500 },
      { file_id: "l", file_size: 900 },
    ];
    expect(pickPhoto(sizes, MAX)).toEqual({ file_id: "l" });
  });

  it("falls back to the next size when the largest is too big", () => {
    const sizes = [
      { file_id: "s", file_size: 100 },
      { file_id: "m", file_size: 800 },
      { file_id: "l", file_size: 5000 },
    ];
    expect(pickPhoto(sizes, MAX)).toEqual({ file_id: "m" });
  });

  it("returns null when none fits", () => {
    expect(pickPhoto([{ file_id: "s", file_size: 2000 }], MAX)).toBeNull();
  });

  it("returns null for no sizes", () => {
    expect(pickPhoto([], MAX)).toBeNull();
  });

  it("counts an unknown size only when it is the smallest", () => {
    expect(pickPhoto([{ file_id: "s" }, { file_id: "l", file_size: 5000 }], MAX)).toEqual({
      file_id: "s",
    });
    expect(pickPhoto([{ file_id: "s", file_size: 100 }, { file_id: "l" }], MAX)).toEqual({
      file_id: "s",
    });
  });
});
