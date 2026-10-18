import Anthropic from "@anthropic-ai/sdk";
import { aiEnv } from "../config/env.js";

export type ContentBlock = Anthropic.Messages.ContentBlock;
export type MessageParam = Anthropic.Messages.MessageParam;
export type ToolDef = Anthropic.Messages.Tool;
export type TextBlockParam = Anthropic.Messages.TextBlockParam;

export interface IntentRequest {
  system: TextBlockParam[];
  messages: MessageParam[];
  tools: ToolDef[];
  max_tokens: number;
  tool_choice?: Anthropic.Messages.ToolChoice;
  signal: AbortSignal;
}

export interface IntentResponse {
  content: ContentBlock[];
  stop_reason: Anthropic.Messages.StopReason | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
}

/** The minimal slice of the Messages API the loop needs. Faked in tests. */
export interface IntentModel {
  readonly name: string;
  create(params: IntentRequest): Promise<IntentResponse>;
}

const REQUEST_TIMEOUT_MS = 35_000;

export function createAnthropicModel(): IntentModel {
  const env = aiEnv();
  const client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    maxRetries: 2,
    timeout: REQUEST_TIMEOUT_MS,
  });
  return {
    name: env.ANTHROPIC_MODEL,
    async create(params) {
      const res = await client.messages.create(
        {
          model: env.ANTHROPIC_MODEL,
          system: params.system,
          messages: params.messages,
          tools: params.tools,
          max_tokens: params.max_tokens,
          ...(params.tool_choice ? { tool_choice: params.tool_choice } : {}),
        },
        { signal: params.signal },
      );
      return { content: res.content, stop_reason: res.stop_reason, usage: res.usage };
    },
  };
}
