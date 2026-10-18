import { describe, expect, it } from "vitest";
import type { Failure } from "../../src/failures/classify.js";
import {
  failedText,
  failureText,
  providerLabel,
  reasonPhrase,
  retryingText,
} from "../../src/failures/messages.js";

const f = (kind: Failure["kind"]): Failure => ({ kind, detail: "" });

describe("failure texts", () => {
  it("text input AI kinds", () => {
    expect(failureText(f("ai_timeout"), "text")).toBe(
      "Claude took too long to answer. Please try again. Commands still work.",
    );
    expect(failureText(f("ai_overloaded"), "text")).toBe(
      "Claude (Anthropic) is having problems right now. Try again in a few minutes. Commands still work.",
    );
    expect(failureText(f("ai_rate_limited"), "text")).toBe(
      "Too many AI requests right now. Wait a minute and try again.",
    );
    expect(failureText(f("ai_auth"), "text")).toBe(
      "The Anthropic API key was rejected. Check ANTHROPIC_API_KEY in Vercel. Commands still work.",
    );
    expect(failureText(f("ai_refused"), "text")).toBe(
      "Anthropic refused the request. Check the account's credit. Commands still work.",
    );
    expect(failureText(f("ai_network"), "text")).toBe("I couldn't reach Claude. Please try again.");
  });
  it("photo input AI kinds", () => {
    expect(failureText(f("ai_timeout"), "photo")).toBe(
      "I couldn't read the photo: Claude took too long to answer. Please try again.",
    );
    expect(failureText(f("ai_overloaded"), "photo")).toBe(
      "I couldn't read the photo: Claude (Anthropic) is having problems right now. Try again in a few minutes.",
    );
    expect(failureText(f("ai_rate_limited"), "photo")).toBe(
      "I couldn't read the photo: too many AI requests right now. Wait a minute and try again.",
    );
    expect(failureText(f("ai_auth"), "photo")).toBe(
      "I couldn't read the photo: the Anthropic API key was rejected. Check ANTHROPIC_API_KEY in Vercel.",
    );
    expect(failureText(f("ai_refused"), "photo")).toBe(
      "I couldn't read the photo: Anthropic refused the request. Check the account's credit.",
    );
    expect(failureText(f("ai_network"), "photo")).toBe(
      "I couldn't read the photo: I couldn't reach Claude. Please try again.",
    );
  });
  it("stt kinds name the provider", () => {
    expect(failureText(f("stt_timeout"), "voice", "Groq")).toBe(
      "Transcription took too long (Groq). Please try again or type it.",
    );
    expect(failureText(f("stt_rate_limited"), "voice", "Groq")).toBe(
      "Too many voice notes for Groq right now. Wait a minute or type it.",
    );
    expect(failureText(f("stt_auth"), "voice", "Groq")).toBe(
      "The Groq API key was rejected. Check it in Vercel. Typing still works.",
    );
    expect(failureText(f("stt_down"), "voice", "Groq")).toBe(
      "Groq is having problems right now. Please type it.",
    );
    expect(failureText(f("stt_failed"), "voice", "OpenAI")).toBe(
      "Sorry, I couldn't transcribe that (OpenAI). Please try again or type it.",
    );
  });
  it("download and size", () => {
    expect(failureText(f("download_failed"), "photo")).toBe(
      "I couldn't download that file from Telegram. Please send it again.",
    );
    expect(failureText(f("file_too_large"), "photo")).toBe(
      "That photo is too large (max 3.5 MB). Send it compressed (not as a file) or crop it.",
    );
    expect(failureText(f("file_too_large"), "voice")).toBe(
      "That voice note is too large to download.",
    );
  });
  it("db, unknown, row_timeout", () => {
    expect(failureText(f("db"), "text")).toBe(
      "Sorry, something went wrong (a database error). Please try again.",
    );
    expect(failureText(f("unknown"), "text")).toBe(
      "Sorry, something went wrong (an unexpected error). Please try again.",
    );
    expect(failureText(f("row_timeout"), "text")).toBe(
      "Sorry, something went wrong (it took too long). Please try again.",
    );
  });
  it("reasonPhrase", () => {
    expect(reasonPhrase(f("ai_timeout"))).toBe("Claude took too long");
    expect(reasonPhrase(f("ai_overloaded"))).toBe("Claude is having problems");
    expect(reasonPhrase(f("ai_rate_limited"))).toBe("too many AI requests");
    expect(reasonPhrase(f("ai_auth"))).toBe("the Anthropic key was rejected");
    expect(reasonPhrase(f("ai_refused"))).toBe("Anthropic refused the request");
    expect(reasonPhrase(f("ai_network"))).toBe("I couldn't reach Claude");
    expect(reasonPhrase(f("stt_down"))).toBe("transcription failed");
    expect(reasonPhrase(f("download_failed"))).toBe("the Telegram download failed");
    expect(reasonPhrase(f("file_too_large"))).toBe("the file is too large");
    expect(reasonPhrase(f("db"))).toBe("a database error");
    expect(reasonPhrase(f("row_timeout"))).toBe("it took too long");
    expect(reasonPhrase(f("unknown"))).toBe("an unexpected error");
  });
  it("retrying and failed", () => {
    expect(retryingText(f("db"))).toBe(
      "⚠️ Something went wrong (a database error) while handling your last message. I'll retry automatically, so don't send it again.",
    );
    expect(failedText(f("row_timeout"))).toBe(
      "Sorry, I couldn't process your last message after 3 tries (it took too long). Please send it again.",
    );
  });
  it("file_too_large for text input is neutral", () => {
    expect(failureText(f("file_too_large"), "text")).toBe("That file is too large.");
  });
  it("providerLabel falls back to the raw provider", () => {
    expect(providerLabel("acme:model-1")).toBe("acme");
    expect(providerLabel("plain")).toBe("plain");
  });
  it("providerLabel", () => {
    expect(providerLabel("groq:whisper-large-v3-turbo")).toBe("Groq");
    expect(providerLabel("openai:whisper-1")).toBe("OpenAI");
  });
});
