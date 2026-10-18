import type { ContentBlock, IntentModel, IntentRequest, IntentResponse } from "./model.js";

export interface ScriptedTurn {
  content: ContentBlock[];
  inputTokens?: number;
  outputTokens?: number;
  /** Resolve after this many ms (honours the abort signal). */
  delayMs?: number;
}

let idCounter = 0;

export function toolUse(name: string, input: unknown): ContentBlock {
  idCounter++;
  return { type: "tool_use", id: `toolu_fake_${idCounter}`, name, input } as ContentBlock;
}

export function text(value: string): ContentBlock {
  return { type: "text", text: value, citations: null } as ContentBlock;
}

/** A turn: tool_use blocks make the loop continue; text-only ends it. */
export function turn(...content: ContentBlock[]): ScriptedTurn {
  return { content };
}

export interface FakeModel extends IntentModel {
  requests: IntentRequest[];
  /** Deep copies of each request's messages taken at call time (the loop mutates the array). */
  messageSnapshots: IntentRequest["messages"][];
}

export function createFakeModel(script: (ScriptedTurn | ContentBlock[])[]): FakeModel {
  let i = 0;
  const requests: IntentRequest[] = [];
  const messageSnapshots: IntentRequest["messages"][] = [];
  return {
    name: "fake-model",
    requests,
    messageSnapshots,
    async create(params) {
      requests.push(params);
      messageSnapshots.push(structuredClone(params.messages));
      const step = script[i++];
      if (!step) throw new Error("fake model: script exhausted");
      const t: ScriptedTurn = Array.isArray(step) ? { content: step } : step;
      if (t.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, t.delayMs);
          params.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(params.signal.reason ?? new Error("aborted"));
            },
            { once: true },
          );
        });
      }
      const res: IntentResponse = {
        content: t.content,
        stop_reason: t.content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
        usage: { input_tokens: t.inputTokens ?? 100, output_tokens: t.outputTokens ?? 20 },
      };
      return res;
    },
  };
}
