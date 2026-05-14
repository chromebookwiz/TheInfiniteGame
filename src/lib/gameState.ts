import type {
  ArtFocus,
  ArtSettings,
  CampaignThemeId,
  CampaignThemeState,
  ContextSettings,
  GameState,
  MemoryEntry,
  SceneControls,
} from "../types";

export const CAMPAIGN_THEME_OPTIONS: Array<Omit<CampaignThemeState, "rationale">> = [
  { id: "mono", label: "White Phosphor", accent: "#f5f5ef" },
  { id: "phosphor", label: "Green CRT", accent: "#4dff88" },
  { id: "amber", label: "Amber Console", accent: "#ffb243" },
  { id: "frost", label: "Frost Signal", accent: "#60c4ff" },
  { id: "verdant", label: "Wild Lantern", accent: "#7bd88f" },
  { id: "ember", label: "Ember Oath", accent: "#ff6b4a" },
  { id: "neon", label: "Neon Veil", accent: "#ff58c8" },
  { id: "royal", label: "Royal Astral", accent: "#b799ff" },
];

const ART_FOCI: ArtFocus[] = ["scene", "portrait", "item", "enemy", "character", "environment"];

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const next = Number(value);
  if (!Number.isFinite(next)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.round(next)));
}

function themeOption(id: CampaignThemeId) {
  return CAMPAIGN_THEME_OPTIONS.find((theme) => theme.id === id) ?? CAMPAIGN_THEME_OPTIONS[0];
}

export function inferCampaignTheme(seed: string): CampaignThemeState {
  const lowered = seed.toLowerCase();
  let id: CampaignThemeId = "mono";
  let rationale = "Clean high-contrast defaults keep the campaign readable.";

  if (/(forest|wild|druid|garden|moss|verdant|jungle|beast|nature)/.test(lowered)) {
    id = "verdant";
    rationale = "The setup leans into living terrain, old growth, and natural pressure.";
  } else if (/(fire|forge|desert|hell|volcano|blood|war|oath|ash|sun)/.test(lowered)) {
    id = "ember";
    rationale = "The setup wants heat, danger, and decisive heroic contrast.";
  } else if (/(cyber|neon|arcade|ai|station|robot|chrome|hacker|city|train)/.test(lowered)) {
    id = "neon";
    rationale = "The setup reads as electric, urban, synthetic, or high-tech.";
  } else if (/(ice|frost|snow|winter|moon|ghost|spirit|grave|star)/.test(lowered)) {
    id = "frost";
    rationale = "The setup suggests cold light, ghosts, distance, or moonlit mystery.";
  } else if (/(king|queen|palace|court|saint|god|angel|throne|astral|wizard)/.test(lowered)) {
    id = "royal";
    rationale = "The setup carries courtly, sacred, arcane, or mythic weight.";
  } else if (/(ancient|ruin|candle|tomb|archive|temple|clock|machine)/.test(lowered)) {
    id = "amber";
    rationale = "The setup suggests machinery, relic light, inscriptions, or old warnings.";
  } else if (/(terminal|crt|radio|signal|green)/.test(lowered)) {
    id = "phosphor";
    rationale = "The setup sounds like a live signal and benefits from CRT tension.";
  }

  const option = themeOption(id);
  return {
    ...option,
    rationale,
  };
}

export function createDefaultSceneControls(): SceneControls {
  return {
    stakes: "The DM is still framing the immediate stakes.",
    availableMoves: ["Investigate", "Talk", "Move", "Use an item"],
    blockedShortcuts: [
      "Declaring success without a roll",
      "Creating free items or allies",
      "Removing threats without consequences",
    ],
    clockName: "Pressure",
    clockValue: 1,
    clockMax: 6,
    lastComplication: "",
  };
}

export function createDefaultArtSettings(): ArtSettings {
  const selectedWorkflowByFocus = ART_FOCI.reduce<Partial<Record<ArtFocus, string>>>(
    (accumulator, focus) => {
      accumulator[focus] = "";
      return accumulator;
    },
    {},
  );

  return {
    provider: "pollinations",
    pollinationsBaseUrl: import.meta.env.VITE_IMAGE_API_BASE ?? "https://image.pollinations.ai/prompt",
    comfyServerUrl: "http://127.0.0.1:8188",
    comfyClientId: createId("comfy_client"),
    comfyTimeoutSeconds: 90,
    autoGenerate: true,
    workflows: [],
    selectedWorkflowByFocus,
  };
}

export function createDefaultContextSettings(): ContextSettings {
  return {
    storyLimit: 28,
    npcChatLimit: 16,
    memoryLimit: 64,
  };
}

export function normalizeGameState(game: GameState): GameState {
  const artSettings = {
    ...createDefaultArtSettings(),
    ...(game.artSettings ?? {}),
    selectedWorkflowByFocus: {
      ...createDefaultArtSettings().selectedWorkflowByFocus,
      ...(game.artSettings?.selectedWorkflowByFocus ?? {}),
    },
    workflows: game.artSettings?.workflows ?? [],
  };
  const contextSettings = {
    ...createDefaultContextSettings(),
    ...(game.contextSettings ?? {}),
  };

  return {
    ...game,
    campaignTheme: game.campaignTheme ?? inferCampaignTheme(game.theme || game.startingCondition),
    sceneControls: game.sceneControls ?? createDefaultSceneControls(),
    party: game.party ?? [],
    combat: game.combat ?? {
      active: false,
      round: 0,
      turnIndex: 0,
      width: 9,
      height: 7,
      terrainSeed: "unmade",
      terrainPrompt: "",
      terrainGenerated: false,
      cells: [],
      combatants: [],
      objective: "",
      log: [],
      updatedAt: Date.now(),
    },
    archivedStoryCount: game.archivedStoryCount ?? 0,
    artSettings,
    contextSettings: {
      storyLimit: clampInteger(contextSettings.storyLimit, 28, 8, 80),
      npcChatLimit: clampInteger(contextSettings.npcChatLimit, 16, 4, 60),
      memoryLimit: clampInteger(contextSettings.memoryLimit, 64, 16, 160),
    },
  };
}

function summarizeBeatForArchive(beat: GameState["story"][number]): string {
  const cleaned = beat.content.replace(/\s+/g, " ").trim();
  const clipped = cleaned.length > 160 ? `${cleaned.slice(0, 157)}...` : cleaned;
  return `${beat.speaker}: ${clipped}`;
}

export function maintainGameContext(input: GameState): GameState {
  const game = normalizeGameState(input);
  const storyLimit = game.contextSettings.storyLimit;
  const npcChatLimit = game.contextSettings.npcChatLimit;
  const memoryLimit = game.contextSettings.memoryLimit;
  let memoryLedger = game.memoryLedger;
  let archivedStoryCount = game.archivedStoryCount;
  let story = game.story;

  if (story.length > storyLimit) {
    const archive = story.slice(0, story.length - storyLimit);
    story = story.slice(-storyLimit);
    archivedStoryCount += archive.length;
    const summary = archive.slice(-10).map(summarizeBeatForArchive).join("\n");
    const memory: MemoryEntry = {
      id: createId("memory"),
      title: `Archived story ${archivedStoryCount - archive.length + 1}-${archivedStoryCount}`,
      text: summary || `${archive.length} earlier story beats were archived.`,
      category: "canon",
      importance: 7,
      tags: ["archive", "continuity"],
      updatedAt: Date.now(),
    };
    memoryLedger = [memory, ...memoryLedger];
  }

  const npcChats = Object.fromEntries(
    Object.entries(game.npcChats).map(([npcId, chat]) => [npcId, chat.slice(-npcChatLimit)]),
  );

  return {
    ...game,
    story,
    archivedStoryCount,
    npcChats,
    memoryLedger: memoryLedger.slice(0, memoryLimit),
    artGallery: game.artGallery.slice(0, 48),
  };
}
