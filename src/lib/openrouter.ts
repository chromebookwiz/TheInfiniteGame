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

export interface LocalModelProbeResult {
  endpoint: string;
  models: string[];
  selectedModel: string;
  discoveryUrl: string;
  completionUrl: string;
  providerHint: string;
  toolCallReady: boolean;
  message: string;
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

function endpointRoot(endpoint: string): string {
  return endpoint
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v1\/chat\/completions$/i, "")
    .replace(/\/chat\/completions$/i, "")
    .replace(/\/v1\/models$/i, "")
    .replace(/\/models$/i, "")
    .replace(/\/v1$/i, "")
    .replace(/\/api$/i, "");
}

function modelDiscoveryCandidates(endpoint: string): Array<{ url: string; providerHint: string }> {
  const root = endpointRoot(endpoint);
  const openAiUrl = `${root}/v1/models`;
  const ollamaUrl = `${root}/api/tags`;
  return [
    { url: openAiUrl, providerHint: "OpenAI-compatible" },
    { url: ollamaUrl, providerHint: "Ollama" },
  ].filter((candidate, index, candidates) =>
    candidates.findIndex((entry) => entry.url === candidate.url) === index,
  );
}

function parseModelList(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const record = payload as {
    data?: Array<{ id?: unknown }>;
    models?: Array<{ id?: unknown; name?: unknown; model?: unknown }>;
  };

  const openAiModels = Array.isArray(record.data)
    ? record.data.map((model) => String(model.id ?? "").trim()).filter(Boolean)
    : [];
  const ollamaModels = Array.isArray(record.models)
    ? record.models
      .map((model) => String(model.name ?? model.model ?? model.id ?? "").trim())
      .filter(Boolean)
    : [];

  return [...new Set([...openAiModels, ...ollamaModels])];
}

async function fetchJsonWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs = 9000,
): Promise<unknown> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`${response.status} ${errorText}`);
    }

    return response.json();
  } finally {
    window.clearTimeout(timeoutId);
  }
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
      stream: false,
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

export async function probeOpenAICompatibleEndpoint(input: {
  endpoint: string;
  apiKey?: string;
  model?: string;
}): Promise<LocalModelProbeResult> {
  const endpoint = input.endpoint.trim().replace(/\/+$/, "");
  if (!endpoint) {
    throw new Error("Enter a local endpoint before probing.");
  }

  const failures: string[] = [];
  let models: string[] = [];
  let discoveryUrl = "";
  let providerHint = "";

  for (const candidate of modelDiscoveryCandidates(endpoint)) {
    try {
      const payload = await fetchJsonWithTimeout(candidate.url, {
        method: "GET",
        headers: createOpenAICompatibleHeaders(input.apiKey),
      });
      models = parseModelList(payload);
      discoveryUrl = candidate.url;
      providerHint = candidate.providerHint;
      if (models.length > 0) {
        break;
      }
      failures.push(`${candidate.providerHint} returned no models from ${candidate.url}.`);
    } catch (error) {
      const detail =
        error instanceof Error && error.name === "AbortError"
          ? "request timed out"
          : error instanceof TypeError
            ? "request failed, possibly CORS or the server is unreachable"
            : error instanceof Error
              ? error.message
              : "unknown error";
      failures.push(`${candidate.providerHint} model probe failed at ${candidate.url}: ${detail}`);
    }
  }

  if (!models.length) {
    throw new Error(
      [
        "Could not discover local models.",
        ...failures,
        "For vLLM, confirm the server exposes an OpenAI-compatible /v1/models endpoint and allows this browser origin. For Ollama, confirm ollama serve is running and CORS allows the app.",
      ].join(" "),
    );
  }

  const selectedModel =
    input.model && models.includes(input.model)
      ? input.model
      : input.model?.trim() || models[0] || "";

  await createOpenAICompatibleChatCompletion({
    endpoint,
    apiKey: input.apiKey,
    model: selectedModel,
    messages: [{ role: "user", content: "Reply with exactly: ok" }],
    temperature: 0,
    maxTokens: 8,
  });

  let toolCallReady = false;
  try {
    const toolProbe = await createOpenAICompatibleChatCompletion({
      endpoint,
      apiKey: input.apiKey,
      model: selectedModel,
      messages: [{ role: "user", content: "Call ping_game_runtime now." }],
      tools: [
        {
          type: "function",
          function: {
            name: "ping_game_runtime",
            description: "Return a simple local runtime health ping.",
            parameters: {
              type: "object",
              properties: {
                ok: { type: "boolean" },
              },
            },
          },
        },
      ],
      temperature: 0,
      maxTokens: 60,
    });
    toolCallReady = Boolean(toolProbe.message.tool_calls?.length);
  } catch {
    toolCallReady = false;
  }

  return {
    endpoint,
    models,
    selectedModel,
    discoveryUrl,
    completionUrl: completionUrl(endpoint),
    providerHint,
    toolCallReady,
    message: toolCallReady
      ? `${providerHint} endpoint connected, found ${models.length} model${models.length === 1 ? "" : "s"}, and accepted tool calls.`
      : `${providerHint} endpoint connected and found ${models.length} model${models.length === 1 ? "" : "s"}. Basic chat works, but tool-call support was not verified.`,
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

  return parseCompletionPayload(await response.json());
}

export const OPENROUTER_MODELS = [
  "openai/gpt-4o-mini",
  "anthropic/claude-3.5-haiku",
  "google/gemini-2.0-flash-001",
  "meta-llama/llama-3.3-70b-instruct",
];
