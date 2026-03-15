import type { GeneratedArt, InventoryItem, Rarity } from "../types";

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

export function buildGeneratedArtUrl(prompt: string, seed: string, focus: GeneratedArt["focus"]): string {
  const base = import.meta.env.VITE_IMAGE_API_BASE ?? "https://image.pollinations.ai/prompt";
  const size =
    focus === "portrait"
      ? "768x896"
      : focus === "item"
        ? "768x768"
        : focus === "enemy"
          ? "896x896"
          : "1216x768";
  const [width, height] = size.split("x");
  const styleHint =
    focus === "portrait"
      ? " painterly portrait, crisp face, expressive lighting"
      : focus === "item"
        ? " isolated artifact concept art, centered composition"
        : focus === "enemy"
          ? " enemy concept art, dynamic stance, readable silhouette"
        : " cinematic scene art, atmospheric composition";

  return `${base}/${encodeURIComponent(`${prompt}${styleHint}`)}?width=${width}&height=${height}&seed=${encodeURIComponent(seed)}&model=flux&nologo=true&enhance=true`;
}
