import type { ChatCompletionMessageParam, ChatCompletionTool } from "@mlc-ai/web-llm";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

export interface OpenRouterCompletionResult {
  message: {
    content: string | null;
    tool_calls?: Array<{
      id: string;
      type: "function";
      function: {
        name: string;
        arguments: string;
      };
    }>;
  };
}

function createHeaders(apiKey: string): HeadersInit {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": window.location.origin,
    "X-Title": "The Infinite Game",
  };
}

function createOpenAICompatibleHeaders(apiKey?: string): HeadersInit {
  return {
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    "Content-Type": "application/json",
  };
}

function completionUrl(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/chat/completions")) {
    return trimmed;
  }
  if (trimmed.endsWith("/v1")) {
    return `${trimmed}/chat/completions`;
  }
  return `${trimmed}/v1/chat/completions`;
}

function parseCompletionPayload(payload: {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        type?: "function";
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
  }>;
}): OpenRouterCompletionResult {
  const choice = payload.choices?.[0]?.message;
  return {
    message: {
      content: choice?.content ?? null,
      tool_calls: choice?.tool_calls
        ?.filter((toolCall) => toolCall.function?.name && toolCall.function.arguments)
        .map((toolCall, index) => ({
          id: toolCall.id ?? `${index}`,
          type: "function" as const,
          function: {
            name: toolCall.function?.name ?? "unknown",
            arguments: toolCall.function?.arguments ?? "{}",
          },
        })),
    },
  };
}

export async function createOpenAICompatibleChatCompletion(input: {
  endpoint: string;
  apiKey?: string;
  model: string;
  messages: ChatCompletionMessageParam[];
  tools?: ChatCompletionTool[];
  temperature?: number;
  maxTokens?: number;
}): Promise<OpenRouterCompletionResult> {
  const response = await fetch(completionUrl(input.endpoint), {
    method: "POST",
    headers: createOpenAICompatibleHeaders(input.apiKey),
    body: JSON.stringify({
      model: input.model,
      messages: input.messages,
      tools: input.tools,
      tool_choice: input.tools ? "auto" : undefined,
      temperature: input.temperature ?? 0.9,
      max_tokens: input.maxTokens ?? 800,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Local runtime request failed: ${response.status} ${errorText}`);
  }

  return parseCompletionPayload(await response.json());
}

export async function createOpenRouterChatCompletion(input: {
  apiKey: string;
  model: string;
  messages: ChatCompletionMessageParam[];
  tools?: ChatCompletionTool[];
  temperature?: number;
  maxTokens?: number;
}): Promise<OpenRouterCompletionResult> {
  const response = await fetch(OPENROUTER_API_URL, {
    method: "POST",
    headers: createHeaders(input.apiKey),
    body: JSON.stringify({
      model: input.model,
      messages: input.messages,
      tools: input.tools,
      tool_choice: input.tools ? "auto" : undefined,
      temperature: input.temperature ?? 0.9,
      max_tokens: input.maxTokens ?? 800,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenRouter request failed: ${response.status} ${errorText}`);
  }

  return parseCompletionPayload(await response.json());
}

export const OPENROUTER_MODELS = [
  "openai/gpt-4o-mini",
  "anthropic/claude-3.5-haiku",
  "google/gemini-2.0-flash-001",
  "meta-llama/llama-3.3-70b-instruct",
];
