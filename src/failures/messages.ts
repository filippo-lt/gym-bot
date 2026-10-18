import type { Failure, FailureKind } from "./classify.js";

type Input = "text" | "voice" | "photo";

const REASONS: Record<FailureKind, string> = {
  ai_timeout: "Claude took too long",
  ai_overloaded: "Claude is having problems",
  ai_rate_limited: "too many AI requests",
  ai_auth: "the Anthropic key was rejected",
  ai_refused: "Anthropic refused the request",
  ai_network: "I couldn't reach Claude",
  stt_timeout: "transcription failed",
  stt_rate_limited: "transcription failed",
  stt_auth: "transcription failed",
  stt_down: "transcription failed",
  stt_failed: "transcription failed",
  download_failed: "the Telegram download failed",
  file_too_large: "the file is too large",
  db: "a database error",
  row_timeout: "it took too long",
  unknown: "an unexpected error",
};

export function reasonPhrase(f: Failure): string {
  return REASONS[f.kind];
}

/** "groq:whisper-large-v3-turbo" -> "Groq", "openai:whisper-1" -> "OpenAI". */
export function providerLabel(sttName: string): string {
  const provider = sttName.split(":")[0] ?? sttName;
  if (provider === "groq") return "Groq";
  if (provider === "openai") return "OpenAI";
  return provider;
}

const AI_TEXTS: Partial<Record<FailureKind, { body: string; tail: string }>> = {
  ai_timeout: {
    body: "Claude took too long to answer. Please try again.",
    tail: " Commands still work.",
  },
  ai_overloaded: {
    body: "Claude (Anthropic) is having problems right now. Try again in a few minutes.",
    tail: " Commands still work.",
  },
  ai_rate_limited: {
    body: "Too many AI requests right now. Wait a minute and try again.",
    tail: "",
  },
  ai_auth: {
    body: "The Anthropic API key was rejected. Check ANTHROPIC_API_KEY in Vercel.",
    tail: " Commands still work.",
  },
  ai_refused: {
    body: "Anthropic refused the request. Check the account's credit.",
    tail: " Commands still work.",
  },
  ai_network: { body: "I couldn't reach Claude. Please try again.", tail: "" },
};

function lowerFirst(s: string): string {
  // Keep "Claude" and "Anthropic" capitalised.
  return /^(Claude|Anthropic|I )/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1);
}

export function failureText(f: Failure, input: Input, provider = "the provider"): string {
  const ai = AI_TEXTS[f.kind];
  if (ai) {
    return input === "photo"
      ? `I couldn't read the photo: ${lowerFirst(ai.body)}`
      : `${ai.body}${ai.tail}`;
  }
  switch (f.kind) {
    case "stt_timeout":
      return `Transcription took too long (${provider}). Please try again or type it.`;
    case "stt_rate_limited":
      return `Too many voice notes for ${provider} right now. Wait a minute or type it.`;
    case "stt_auth":
      return `The ${provider} API key was rejected. Check it in Vercel. Typing still works.`;
    case "stt_down":
      return `${provider} is having problems right now. Please type it.`;
    case "stt_failed":
      return `Sorry, I couldn't transcribe that (${provider}). Please try again or type it.`;
    case "download_failed":
      return "I couldn't download that file from Telegram. Please send it again.";
    case "file_too_large":
      if (input === "voice") return "That voice note is too large to download.";
      if (input === "photo") {
        return "That photo is too large (max 3.5 MB). Send it compressed (not as a file) or crop it.";
      }
      return "That file is too large.";
    default:
      return `Sorry, something went wrong (${reasonPhrase(f)}). Please try again.`;
  }
}

export function retryingText(f: Failure): string {
  return `⚠️ Something went wrong (${reasonPhrase(f)}) while handling your last message. I'll retry automatically, so don't send it again.`;
}

export function failedText(f: Failure): string {
  return `Sorry, I couldn't process your last message after 3 tries (${reasonPhrase(f)}). Please send it again.`;
}
