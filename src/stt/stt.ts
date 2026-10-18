import { sttEnv } from "../config/env.js";

export const STT_TIMEOUT_MS = 20_000;
export const MAX_VOICE_SECONDS = 120;
const PROMPT_MAX_CHARS = 600;

export interface SpeechToText {
  readonly name: string;
  transcribe(
    audio: Uint8Array,
    opts: { filename: string; prompt: string; signal: AbortSignal },
  ): Promise<string>;
}

/** Carries the HTTP status only: never the response body or the key. */
export class SttError extends Error {
  constructor(
    readonly status: number,
    provider: string,
  ) {
    super(`${provider} transcription failed (HTTP ${status})`);
    this.name = "SttError";
  }
}

function openAiCompatible(name: string, url: string, model: string, apiKey: string): SpeechToText {
  return {
    name: `${name}:${model}`,
    async transcribe(audio, { filename, prompt, signal }) {
      const form = new FormData();
      form.append(
        "file",
        new Blob([audio as unknown as ArrayBuffer], { type: "audio/ogg" }),
        filename,
      );
      form.append("model", model);
      form.append("prompt", prompt);
      form.append("response_format", "json");
      // No `language`: the user mixes Italian and English.
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal,
      });
      if (!res.ok) throw new SttError(res.status, name);
      const json = (await res.json()) as { text?: unknown };
      return typeof json.text === "string" ? json.text.trim() : "";
    },
  };
}

export function createGroqStt(apiKey: string): SpeechToText {
  return openAiCompatible(
    "groq",
    "https://api.groq.com/openai/v1/audio/transcriptions",
    "whisper-large-v3-turbo",
    apiKey,
  );
}

export function createOpenAiStt(apiKey: string): SpeechToText {
  return openAiCompatible(
    "openai",
    "https://api.openai.com/v1/audio/transcriptions",
    "whisper-1",
    apiKey,
  );
}

export function createStt(env = sttEnv()): { stt: SpeechToText; dailySecondsCap: number } {
  const stt =
    env.STT_PROVIDER === "groq"
      ? createGroqStt(env.GROQ_API_KEY as string)
      : createOpenAiStt(env.OPENAI_API_KEY as string);
  return { stt, dailySecondsCap: env.STT_DAILY_SECONDS_CAP };
}

/** Biases Whisper towards the user's exercise names; cut on a comma boundary. */
export function sttVocabularyPrompt(names: string[]): string {
  const head = "Gym log. Exercises: ";
  const full = head + names.join(", ");
  if (full.length <= PROMPT_MAX_CHARS) return full;
  const cut = full.slice(0, PROMPT_MAX_CHARS);
  const comma = cut.lastIndexOf(",");
  return comma >= head.length ? cut.slice(0, comma) : head.trimEnd();
}
