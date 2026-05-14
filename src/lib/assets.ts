import type { ArtFocus, ArtSettings, ArtWorkflowConfig, GeneratedArt, InventoryItem, Rarity } from "../types";

const rarityPalette: Record<Rarity, [string, string, string]> = {
  common: ["#75695a", "#f2e8d5", "#d6c5af"],
  uncommon: ["#3f6c52", "#d2f6dc", "#8bc69e"],
  rare: ["#255a77", "#d0f1ff", "#78bfd9"],
  epic: ["#6e4a7f", "#f3d8ff", "#be86d7"],
  legendary: ["#8a5822", "#ffedc6", "#f2b652"],
  mythic: ["#7e1f24", "#ffd9db", "#f06d7a"],
};

function initials(name: string): string {
  const tokens = name
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);

  if (tokens.length === 0) {
    return "IT";
  }

  return tokens.slice(0, 2).map((token) => token[0]?.toUpperCase() ?? "").join("");
}

export function buildItemIconUrl(item: Pick<InventoryItem, "name" | "rarity" | "tags">): string {
  const [deep, light, accent] = rarityPalette[item.rarity];
  const topTag = item.tags[0]?.slice(0, 10).toUpperCase() ?? "MISC";
  const glyph = initials(item.name);

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="${item.name}">
      <defs>
        <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stop-color="${deep}" />
          <stop offset="100%" stop-color="${accent}" />
        </linearGradient>
      </defs>
      <rect x="6" y="6" width="116" height="116" rx="24" fill="url(#bg)" />
      <rect x="16" y="16" width="96" height="96" rx="18" fill="${light}" fill-opacity="0.18" stroke="${light}" stroke-opacity="0.4" />
      <path d="M20 88 C42 68, 84 108, 108 38" stroke="${light}" stroke-opacity="0.6" stroke-width="5" fill="none" />
      <text x="64" y="70" text-anchor="middle" font-size="38" font-family="'IBM Plex Mono', monospace" font-weight="700" fill="${light}">${glyph}</text>
      <text x="64" y="104" text-anchor="middle" font-size="12" font-family="'IBM Plex Mono', monospace" letter-spacing="1.5" fill="${light}">${topTag}</text>
    </svg>
  `;

  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function escapeSvg(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildArtPlaceholderUrl(title: string, detail: string): string {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 600" role="img" aria-label="${escapeSvg(title)}">
      <defs>
        <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stop-color="#111318" />
          <stop offset="100%" stop-color="#25211a" />
        </linearGradient>
      </defs>
      <rect width="960" height="600" fill="url(#bg)" />
      <rect x="42" y="42" width="876" height="516" fill="none" stroke="#d8d1bd" stroke-opacity="0.55" stroke-width="3" />
      <path d="M80 440 C260 300, 390 510, 560 330 S790 230, 880 380" stroke="#d8d1bd" stroke-opacity="0.28" stroke-width="10" fill="none" />
      <text x="80" y="126" font-size="42" font-family="'IBM Plex Mono', monospace" font-weight="700" fill="#f3ebd7">${escapeSvg(title)}</text>
      <text x="80" y="182" font-size="24" font-family="'IBM Plex Mono', monospace" fill="#d8d1bd">${escapeSvg(detail.slice(0, 82))}</text>
      <text x="80" y="500" font-size="18" font-family="'IBM Plex Mono', monospace" fill="#9f9788">The image request is queued or unavailable.</text>
    </svg>
  `;

  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

export function buildGeneratedArtUrl(
  prompt: string,
  seed: string,
  focus: GeneratedArt["focus"],
  artSettings?: ArtSettings,
): string {
  const base =
    artSettings?.pollinationsBaseUrl ||
    import.meta.env.VITE_IMAGE_API_BASE ||
    "https://image.pollinations.ai/prompt";
  const size =
    focus === "portrait" || focus === "character"
      ? "768x896"
      : focus === "item"
        ? "768x768"
        : focus === "enemy"
          ? "896x896"
          : "1216x768";
  const [width, height] = size.split("x");
  const styleHint =
    focus === "portrait" || focus === "character"
      ? " painterly portrait, crisp face, expressive lighting"
      : focus === "item"
        ? " isolated artifact concept art, centered composition"
        : focus === "enemy"
          ? " enemy concept art, dynamic stance, readable silhouette"
        : " cinematic scene art, atmospheric composition";

  return `${base}/${encodeURIComponent(`${prompt}${styleHint}`)}?width=${width}&height=${height}&seed=${encodeURIComponent(seed)}&model=flux&nologo=true&enhance=true`;
}

function selectedWorkflow(settings: ArtSettings, focus: ArtFocus): ArtWorkflowConfig | undefined {
  const selectedId = settings.selectedWorkflowByFocus[focus];
  return (
    settings.workflows.find((workflow) => workflow.enabled && workflow.id === selectedId) ??
    settings.workflows.find((workflow) => workflow.enabled && workflow.focus === focus) ??
    settings.workflows.find((workflow) => workflow.enabled && workflow.focus === "all")
  );
}

function injectPrompt(
  workflow: Record<string, unknown>,
  config: ArtWorkflowConfig,
  prompt: string,
  seed: string,
) {
  const promptInput = config.promptInputName || "text";
  const negativeInput = config.negativePromptInputName || "text";
  const seedInput = config.seedInputName || "seed";
  const promptNode = config.promptNodeId
    ? workflow[config.promptNodeId] as { inputs?: Record<string, unknown> } | undefined
    : undefined;
  const negativeNode = config.negativePromptNodeId
    ? workflow[config.negativePromptNodeId] as { inputs?: Record<string, unknown> } | undefined
    : undefined;
  const seedNode = config.seedNodeId
    ? workflow[config.seedNodeId] as { inputs?: Record<string, unknown> } | undefined
    : undefined;

  if (promptNode?.inputs) {
    promptNode.inputs[promptInput] = prompt;
  }
  if (negativeNode?.inputs) {
    negativeNode.inputs[negativeInput] = "blurry, low quality, unreadable, malformed hands, cropped subject";
  }
  if (seedNode?.inputs) {
    seedNode.inputs[seedInput] = Math.abs(
      Array.from(seed).reduce((hash, char) => Math.imul(hash ^ char.charCodeAt(0), 16777619), 2166136261),
    );
  }

  if (!promptNode) {
    for (const node of Object.values(workflow)) {
      if (!node || typeof node !== "object" || !("inputs" in node)) {
        continue;
      }
      const inputs = (node as { inputs?: Record<string, unknown> }).inputs;
      if (!inputs) {
        continue;
      }
      const candidateKey = Object.keys(inputs).find((key) =>
        /^(text|prompt|positive)$/i.test(key) && typeof inputs[key] === "string",
      );
      if (candidateKey) {
        inputs[candidateKey] = prompt;
        break;
      }
    }
  }
}

async function waitForComfyImage(
  serverUrl: string,
  promptId: string,
  timeoutSeconds: number,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  const cleanBase = serverUrl.replace(/\/+$/, "");

  while (Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 1200));
    const response = await fetch(`${cleanBase}/history/${encodeURIComponent(promptId)}`);
    if (!response.ok) {
      continue;
    }
    const history = (await response.json()) as Record<string, {
      outputs?: Record<string, { images?: Array<{ filename: string; subfolder?: string; type?: string }> }>;
    }>;
    const entry = history[promptId];
    const image = Object.values(entry?.outputs ?? {})
      .flatMap((output) => output.images ?? [])
      .find(Boolean);
    if (image) {
      const params = new URLSearchParams({
        filename: image.filename,
        subfolder: image.subfolder ?? "",
        type: image.type ?? "output",
      });
      return `${cleanBase}/view?${params.toString()}`;
    }
  }

  return undefined;
}

async function requestComfyArt(
  prompt: string,
  seed: string,
  focus: ArtFocus,
  settings: ArtSettings,
): Promise<string> {
  const workflowConfig = selectedWorkflow(settings, focus);
  if (!workflowConfig?.workflowJson.trim()) {
    return buildArtPlaceholderUrl("ComfyUI workflow missing", `${focus}: ${prompt}`);
  }

  const workflow = JSON.parse(workflowConfig.workflowJson) as Record<string, unknown>;
  injectPrompt(workflow, workflowConfig, prompt, seed);
  const cleanBase = settings.comfyServerUrl.replace(/\/+$/, "");
  const response = await fetch(`${cleanBase}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: settings.comfyClientId,
      prompt: workflow,
    }),
  });

  if (!response.ok) {
    throw new Error(`ComfyUI request failed: ${response.status} ${await response.text()}`);
  }

  const payload = (await response.json()) as { prompt_id?: string };
  if (!payload.prompt_id) {
    throw new Error("ComfyUI did not return a prompt id.");
  }

  return (
    await waitForComfyImage(
      settings.comfyServerUrl,
      payload.prompt_id,
      Math.max(10, settings.comfyTimeoutSeconds),
    )
  ) ?? buildArtPlaceholderUrl("ComfyUI timed out", `${focus}: ${prompt}`);
}

export async function generateArtAsset(
  prompt: string,
  seed: string,
  focus: ArtFocus,
  settings?: ArtSettings,
): Promise<string> {
  if (settings?.provider === "comfy") {
    try {
      return await requestComfyArt(prompt, seed, focus, settings);
    } catch (error) {
      return buildArtPlaceholderUrl(
        "ComfyUI unavailable",
        error instanceof Error ? error.message : "Image generation failed.",
      );
    }
  }

  return buildGeneratedArtUrl(prompt, seed, focus, settings);
}
