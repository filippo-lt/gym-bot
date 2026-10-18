import { afterEach, describe, expect, it, vi } from "vitest";
import { createGroqStt, SttError, sttVocabularyPrompt } from "../../src/stt/stt.js";

const signal = new AbortController().signal;
const audio = new Uint8Array([1, 2, 3]);

afterEach(() => vi.unstubAllGlobals());

describe("stt", () => {
  it("groq stt posts model, prompt and no language", async () => {
    const fetchMock = vi.fn(async () => Response.json({ text: "  squat 100 per 5 \n" }));
    vi.stubGlobal("fetch", fetchMock);
    const stt = createGroqStt("key");
    const text = await stt.transcribe(audio, { filename: "v.ogg", prompt: "Gym log.", signal });
    expect(text).toBe("squat 100 per 5");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    const form = init.body as FormData;
    expect(form.get("model")).toBe("whisper-large-v3-turbo");
    expect(form.get("prompt")).toBe("Gym log.");
    expect(form.get("response_format")).toBe("json");
    expect(form.has("language")).toBe(false);
    expect(stt.name).toBe("groq:whisper-large-v3-turbo");
  });

  it("stt error carries the status, not the body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("secret", { status: 401 })),
    );
    const err = await createGroqStt("key")
      .transcribe(audio, { filename: "v.ogg", prompt: "", signal })
      .catch((e) => e);
    expect(err).toBeInstanceOf(SttError);
    expect(err.message).toContain("401");
    expect(err.message).not.toContain("secret");
  });

  it("sttVocabularyPrompt cuts at 600 chars on a comma", () => {
    const names = Array.from({ length: 100 }, (_, i) => `Exercise number ${i}`);
    const p = sttVocabularyPrompt(names);
    expect(p.length).toBeLessThanOrEqual(600);
    expect(p.startsWith("Gym log. Exercises: Exercise number 0, ")).toBe(true);
    expect(names.some((n) => p.endsWith(n))).toBe(true);
    expect(sttVocabularyPrompt(["Squat", "Bench"])).toBe("Gym log. Exercises: Squat, Bench");
  });
});
