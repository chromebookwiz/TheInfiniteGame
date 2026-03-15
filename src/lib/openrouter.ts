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

  const payload = (await response.json()) as {
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
  };

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

export const OPENROUTER_MODELS = [
  "openai/gpt-4o-mini",
  "anthropic/claude-3.5-haiku",
  "google/gemini-2.0-flash-001",
  "meta-llama/llama-3.3-70b-instruct",
];
