import {
  CreateWebWorkerMLCEngine,
  type ChatCompletionMessageParam,
  type ChatCompletionMessageToolCall,
  type ChatCompletionTool,
  type InitProgressReport,
  type MLCEngineInterface,
} from "@mlc-ai/web-llm";
import { buildGeneratedArtUrl, buildItemIconUrl } from "./assets";
import { TOOL_CALLING_APP_CONFIG } from "./models";
import { createOpenRouterChatCompletion } from "./openrouter";
import {
  DEFAULT_CLASS_ID,
  getClassDefinition,
  getDefaultSpellsForClass,
  getSpellDefinitionByName,
} from "../data/dnd";
import type {
  AbilityScores,
  CharacterResources,
  EnemyState,
  GameState,
  GeneratedArt,
  InventoryItem,
  MemoryCategory,
  MemoryEntry,
  NpcChatMessage,
  NpcProfile,
  PlayerState,
  ProviderConfig,
  Quest,
  RulesetState,
  SpellDefinition,
  ToolEvent,
} from "../types";

let engine: MLCEngineInterface | null = null;
let activeModelId = "";
let activeWorker: Worker | null = null;

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function asStringArray(value: unknown, limit = 8): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => String(entry).trim())
    .filter(Boolean)
    .slice(0, limit);
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

function mergeAbilityScores(
  current: AbilityScores,
  patch: Record<string, unknown>,
): AbilityScores {
  return {
    strength: clamp(asNumber(patch.strength, current.strength), 1, 30),
    dexterity: clamp(asNumber(patch.dexterity, current.dexterity), 1, 30),
    constitution: clamp(asNumber(patch.constitution, current.constitution), 1, 30),
    intelligence: clamp(asNumber(patch.intelligence, current.intelligence), 1, 30),
    wisdom: clamp(asNumber(patch.wisdom, current.wisdom), 1, 30),
    charisma: clamp(asNumber(patch.charisma, current.charisma), 1, 30),
  };
}

function patchResources(
  current: CharacterResources,
  patch: Record<string, unknown>,
): CharacterResources {
  const maxHealth = clamp(
    asNumber(patch.maxHealth, current.maxHealth) + asNumber(patch.maxHealthDelta, 0),
    1,
    999,
  );
  const maxMana = clamp(
    asNumber(patch.maxMana, current.maxMana) + asNumber(patch.maxManaDelta, 0),
    0,
    999,
  );
  const maxStamina = clamp(
    asNumber(patch.maxStamina, current.maxStamina) + asNumber(patch.maxStaminaDelta, 0),
    0,
    999,
  );

  return {
    maxHealth,
    health: clamp(asNumber(patch.health, current.health) + asNumber(patch.healthDelta, 0), 0, maxHealth),
    maxMana,
    mana: clamp(asNumber(patch.mana, current.mana) + asNumber(patch.manaDelta, 0), 0, maxMana),
    maxStamina,
    stamina: clamp(
      asNumber(patch.stamina, current.stamina) + asNumber(patch.staminaDelta, 0),
      0,
      maxStamina,
    ),
    armorClass: clamp(
      asNumber(patch.armorClass, current.armorClass) + asNumber(patch.armorClassDelta, 0),
      1,
      50,
    ),
    initiative: clamp(
      asNumber(patch.initiative, current.initiative) + asNumber(patch.initiativeDelta, 0),
      -10,
      30,
    ),
    luck: clamp(asNumber(patch.luck, current.luck) + asNumber(patch.luckDelta, 0), 0, 100),
    renown: clamp(
      asNumber(patch.renown, current.renown) + asNumber(patch.renownDelta, 0),
      -100,
      100,
    ),
    gold: clamp(asNumber(patch.gold, current.gold) + asNumber(patch.goldDelta, 0), 0, 999999),
  };
}

function inferBaseline(theme: string): string {
  const lowered = theme.toLowerCase();
  if (/(cyber|neon|station|modern|city|train|arcade|ai)/.test(lowered)) {
    return "hybrid-modern";
  }
  if (/(ancient|forest|dragon|kingdom|sword|guild|palace|throne)/.test(lowered)) {
    return "fantasy-ancient";
  }
  return "dnd-fantasy";
}

function createDefaultAbilityScores(classId: string): AbilityScores {
  const base: AbilityScores = {
    strength: 10,
    dexterity: 10,
    constitution: 10,
    intelligence: 10,
    wisdom: 10,
    charisma: 10,
  };
  const definition = getClassDefinition(classId);
  if (!definition) {
    return base;
  }

  const [primaryA, primaryB] = definition.primaryAbilities;
  const mutate: AbilityScores = { ...base };
  if (primaryA) {
    mutate[primaryA as keyof AbilityScores] = 15;
  }
  if (primaryB) {
    mutate[primaryB as keyof AbilityScores] = 13;
  }
  mutate.constitution = Math.max(mutate.constitution, 12);
  return mutate;
}

function createDefaultResources(classId: string): CharacterResources {
  const definition = getClassDefinition(classId);
  const hitDie = definition?.hitDie ?? 8;
  const maxHealth = 8 + hitDie;
  const hasMagic = definition?.spellcasting !== "none";
  return {
    maxHealth,
    health: maxHealth,
    maxMana: hasMagic ? 6 : 2,
    mana: hasMagic ? 6 : 2,
    maxStamina: 10,
    stamina: 10,
    armorClass: 10 + Math.ceil(hitDie / 3),
    initiative: 1,
    luck: 50,
    renown: 0,
    gold: 25,
  };
}

function createDefaultPlayer(classId: string): PlayerState {
  const normalizedClassId = classId || DEFAULT_CLASS_ID;
  const definition = getClassDefinition(normalizedClassId);

  return {
    classId: normalizedClassId,
    className: definition?.name ?? normalizedClassId,
    level: 1,
    xp: 0,
    background: "Wanderer",
    ancestry: "Human",
    alignment: "Unwritten",
    abilityScores: createDefaultAbilityScores(normalizedClassId),
    resources: createDefaultResources(normalizedClassId),
    classFeatures: definition?.startingFeatures ?? [],
    spells: getDefaultSpellsForClass(normalizedClassId),
    notes: [],
    customTraits: [],
  };
}

function createDefaultRuleset(theme: string): RulesetState {
  return {
    canonBaseline: inferBaseline(theme),
    rulesSummary:
      "Default to DnD-style classes and spells, but allow the DM to mutate systems, genre assumptions, and mechanics through tool calls when the fiction demands it.",
    improviseAllowed: true,
    combatStyle: "Turn-based narrative combat with DM-controlled enemies and mutable tactical rules.",
    restStyle: "Short pauses restore some stamina, major rests restore core resources when fiction allows.",
    deathRules: "Defeat creates consequences, danger, injury, capture, or death depending on stakes and DM judgment.",
    magicRules: "Magic starts with DnD-like spellcasting but can be reskinned or rewritten for modern, ancient, hybrid, or custom settings.",
    inventoryRules: "Items can carry arbitrary modifiers, slots, value, and custom attributes.",
    socialRules: "NPC trust, leverage, secrets, and reputation can matter as much as damage numbers.",
    allowedClassIds: [
      "barbarian",
      "bard",
      "cleric",
      "druid",
      "fighter",
      "monk",
      "paladin",
      "ranger",
      "rogue",
      "sorcerer",
      "warlock",
      "wizard",
    ],
    mutableSystems: [
      "stats",
      "classes",
      "spells",
      "inventory",
      "enemy-generation",
      "combat",
      "social",
      "world-rules",
    ],
    customMoves: [],
    ruleNotes: [
      "Use tools to keep the structured state authoritative.",
      "Record durable canon and unresolved threats in memory.",
    ],
  };
}

function bestMemorySlice(memoryLedger: MemoryEntry[]): MemoryEntry[] {
  return [...memoryLedger]
    .sort((left, right) => right.importance - left.importance || right.updatedAt - left.updatedAt)
    .slice(0, 12);
}

function summarizeState(state: GameState) {
  return {
    playerName: state.playerName,
    theme: state.theme,
    startingCondition: state.startingCondition,
    turnCount: state.turnCount,
    player: {
      classId: state.player.classId,
      className: state.player.className,
      level: state.player.level,
      xp: state.player.xp,
      background: state.player.background,
      ancestry: state.player.ancestry,
      alignment: state.player.alignment,
      abilityScores: state.player.abilityScores,
      resources: state.player.resources,
      classFeatures: state.player.classFeatures,
      spells: state.player.spells.map((spell) => ({
        name: spell.name,
        level: spell.level,
        school: spell.school,
        tags: spell.tags,
      })),
      notes: state.player.notes,
      customTraits: state.player.customTraits,
    },
    environment: state.environment,
    ruleset: state.ruleset,
    inventory: state.inventory.map((item) => ({
      id: item.id,
      name: item.name,
      rarity: item.rarity,
      quantity: item.quantity,
      tags: item.tags,
      slot: item.slot,
      modifiers: item.modifiers,
      customAttributes: item.customAttributes,
    })),
    quests: state.quests.map((quest) => ({
      title: quest.title,
      summary: quest.summary,
      status: quest.status,
      steps: quest.steps,
    })),
    npcs: state.npcs.map((npc) => ({
      id: npc.id,
      name: npc.name,
      archetype: npc.archetype,
      disposition: npc.disposition,
      goals: npc.goals,
    })),
    enemies: state.enemies.map((enemy) => ({
      id: enemy.id,
      name: enemy.name,
      archetype: enemy.archetype,
      level: enemy.level,
      disposition: enemy.disposition,
      tags: enemy.tags,
      abilities: enemy.abilities,
      stats: enemy.stats,
    })),
    memoryLedger: bestMemorySlice(state.memoryLedger),
    recentStory: state.story.slice(-6).map((beat) => ({
      speaker: beat.speaker,
      content: beat.content,
    })),
  };
}

const DUNGEON_MASTER_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "set_environment",
      description:
        "Update the current environment, scene framing, hazards, exits, factions, pressure, and sensory state.",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string" },
          sceneSummary: { type: "string" },
          atmosphere: { type: "string" },
          biome: { type: "string" },
          weather: { type: "string" },
          timeOfDay: { type: "string" },
          hazards: { type: "array", items: { type: "string" } },
          exits: { type: "array", items: { type: "string" } },
          factions: { type: "array", items: { type: "string" } },
          pressureClock: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_player_profile",
      description:
        "Create or update the player class, level, identity, ability scores, class features, and character traits.",
      parameters: {
        type: "object",
        properties: {
          classId: { type: "string" },
          className: { type: "string" },
          level: { type: "number" },
          xp: { type: "number" },
          background: { type: "string" },
          ancestry: { type: "string" },
          alignment: { type: "string" },
          abilityScores: {
            type: "object",
            properties: {
              strength: { type: "number" },
              dexterity: { type: "number" },
              constitution: { type: "number" },
              intelligence: { type: "number" },
              wisdom: { type: "number" },
              charisma: { type: "number" },
            },
          },
          classFeatures: { type: "array", items: { type: "string" } },
          notes: { type: "array", items: { type: "string" } },
          customTraits: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "adjust_player_resources",
      description:
        "Directly set or modify player health, mana, stamina, armor, luck, renown, gold, and progression.",
      parameters: {
        type: "object",
        properties: {
          maxHealth: { type: "number" },
          maxHealthDelta: { type: "number" },
          health: { type: "number" },
          healthDelta: { type: "number" },
          maxMana: { type: "number" },
          maxManaDelta: { type: "number" },
          mana: { type: "number" },
          manaDelta: { type: "number" },
          maxStamina: { type: "number" },
          maxStaminaDelta: { type: "number" },
          stamina: { type: "number" },
          staminaDelta: { type: "number" },
          armorClass: { type: "number" },
          armorClassDelta: { type: "number" },
          initiative: { type: "number" },
          initiativeDelta: { type: "number" },
          luck: { type: "number" },
          luckDelta: { type: "number" },
          renown: { type: "number" },
          renownDelta: { type: "number" },
          gold: { type: "number" },
          goldDelta: { type: "number" },
          level: { type: "number" },
          xp: { type: "number" },
          xpDelta: { type: "number" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grant_spell",
      description:
        "Grant or update a player spell, technique, invocation, martial maneuver, or improvised power.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          level: { type: "number" },
          school: { type: "string" },
          description: { type: "string" },
          sourceClassIds: { type: "array", items: { type: "string" } },
          tags: { type: "array", items: { type: "string" } },
          resourceCost: { type: "number" },
          range: { type: "string" },
          isCustom: { type: "boolean" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "revoke_spell",
      description: "Remove a player spell, maneuver, or power that is lost, blocked, or forgotten.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          reason: { type: "string" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "upsert_inventory_item",
      description:
        "Create or update a player inventory item, including quantity, rarity, slot, value, modifiers, and custom attributes.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          rarity: {
            type: "string",
            enum: ["common", "uncommon", "rare", "epic", "legendary", "mythic"],
          },
          tags: { type: "array", items: { type: "string" } },
          quantity: { type: "number" },
          iconPrompt: { type: "string" },
          slot: { type: "string" },
          weight: { type: "number" },
          value: { type: "number" },
          modifiers: { type: "object" },
          customAttributes: { type: "object" },
        },
        required: ["name", "description"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_inventory_item",
      description: "Take items away from the player inventory by name, whether through use, theft, sacrifice, trade, or destruction.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          quantity: { type: "number" },
          reason: { type: "string" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "upsert_quest",
      description: "Create or update quests, objectives, and rewards.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          summary: { type: "string" },
          steps: { type: "array", items: { type: "string" } },
          status: { type: "string", enum: ["active", "completed", "failed"] },
          rewardHint: { type: "string" },
        },
        required: ["title", "summary", "steps", "status"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "upsert_npc",
      description:
        "Create or update an NPC, including personality, motives, relationship stance, and portrait prompt.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          archetype: { type: "string" },
          personality: { type: "string" },
          disposition: { type: "string" },
          voice: { type: "string" },
          goals: { type: "array", items: { type: "string" } },
          secrets: { type: "array", items: { type: "string" } },
          avatarPrompt: { type: "string" },
        },
        required: ["name", "archetype", "personality", "disposition", "voice"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "spawn_enemy",
      description:
        "Generate an enemy or hostile force with stats, abilities, tags, and loot hints.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          archetype: { type: "string" },
          level: { type: "number" },
          disposition: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          abilities: { type: "array", items: { type: "string" } },
          lootHints: { type: "array", items: { type: "string" } },
          portraitPrompt: { type: "string" },
          maxHealth: { type: "number" },
          health: { type: "number" },
          armorClass: { type: "number" },
          attack: { type: "number" },
          magic: { type: "number" },
          speed: { type: "number" },
          morale: { type: "number" },
          threat: { type: "number" },
          customAttributes: { type: "object" },
        },
        required: ["name", "archetype"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_enemy",
      description: "Modify an existing enemy's stats, disposition, abilities, tags, or custom attributes.",
      parameters: {
        type: "object",
        properties: {
          enemyId: { type: "string" },
          name: { type: "string" },
          archetype: { type: "string" },
          level: { type: "number" },
          disposition: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          abilities: { type: "array", items: { type: "string" } },
          lootHints: { type: "array", items: { type: "string" } },
          portraitPrompt: { type: "string" },
          maxHealth: { type: "number" },
          health: { type: "number" },
          armorClass: { type: "number" },
          attack: { type: "number" },
          magic: { type: "number" },
          speed: { type: "number" },
          morale: { type: "number" },
          threat: { type: "number" },
          customAttributes: { type: "object" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_enemy",
      description: "Remove an enemy when it is defeated, leaves, surrenders, or transforms out of the active roster.",
      parameters: {
        type: "object",
        properties: {
          enemyId: { type: "string" },
          name: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "commit_memory",
      description:
        "Store or update a durable fact, objective, threat, relationship, system note, or scene fact in the campaign memory ledger.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          text: { type: "string" },
          category: {
            type: "string",
            enum: ["canon", "objective", "threat", "relationship", "system", "scene"],
          },
          importance: { type: "number" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["title", "text", "category"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rewrite_ruleset",
      description:
        "Redefine core systems on the fly, including combat style, magic rules, inventory assumptions, social rules, mutable systems, and allowed classes.",
      parameters: {
        type: "object",
        properties: {
          canonBaseline: { type: "string" },
          rulesSummary: { type: "string" },
          improviseAllowed: { type: "boolean" },
          combatStyle: { type: "string" },
          restStyle: { type: "string" },
          deathRules: { type: "string" },
          magicRules: { type: "string" },
          inventoryRules: { type: "string" },
          socialRules: { type: "string" },
          allowedClassIds: { type: "array", items: { type: "string" } },
          mutableSystems: { type: "array", items: { type: "string" } },
          customMoves: { type: "array", items: { type: "string" } },
          ruleNotes: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_art",
      description:
        "Generate art for the scene, an item, an NPC portrait, or an enemy portrait whenever visual context helps the player.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          focus: { type: "string", enum: ["scene", "portrait", "item", "enemy"] },
          subjectId: { type: "string" },
        },
        required: ["prompt", "focus"],
      },
    },
  },
];

const DUNGEON_MASTER_SYSTEM_PROMPT = `You are the Dungeon Master and systems director for an infinite choose-your-own-adventure simulation.

You have OpenClaw-like environment and memory tooling through structured function calls.

Operating contract:
- The tool state is the authoritative simulation state.
- Read the state packet carefully before acting.
- Use the environment, memory, ruleset, inventory, player, quest, NPC, enemy, and art tools to keep the simulation synchronized.
- The player begins from a DnD-style class and spell baseline, but you may adapt or rewrite rules to fit modern, ancient, hybrid, surreal, or custom settings.
- You are allowed to redesign mechanics mid-campaign if the fiction demands it. When you do, call rewrite_ruleset and record the change with commit_memory.
- If the player gains or loses items, update inventory through tools.
- If hostile forces appear or change, create or update enemies through tools.
- If the player's class, powers, or stats evolve, update the player profile and resources through tools.
- Always preserve continuity and avoid contradictions with the memory ledger.
- After all necessary tool calls, narrate crisply in 1 to 3 short paragraphs.
- End with 2 to 4 concrete options followed by 'Or type your own action.'
- Never reveal internal tool or schema details to the player.`;

function buildDungeonMasterMessages(
  state: GameState,
  playerAction: string,
): ChatCompletionMessageParam[] {
  return [
    { role: "system", content: DUNGEON_MASTER_SYSTEM_PROMPT },
    {
      role: "user",
      content: `State packet:\n${JSON.stringify(summarizeState(state), null, 2)}\n\nPlayer action: ${playerAction}`,
    },
  ];
}

function buildNpcMessages(
  state: GameState,
  npc: NpcProfile,
  history: NpcChatMessage[],
  playerInput: string,
): ChatCompletionMessageParam[] {
  const recentHistory = history.slice(-8).map((message) => ({
    role: message.role === "npc" ? "assistant" : "user",
    content: message.content,
  })) as ChatCompletionMessageParam[];

  const npcPrompt = `You are ${npc.name}, an NPC in an ongoing mutable adventure simulation.

Stay in character.
Profile:
- Archetype: ${npc.archetype}
- Personality: ${npc.personality}
- Disposition: ${npc.disposition}
- Voice: ${npc.voice}
- Goals: ${npc.goals.join(", ") || "none stated"}
- Secrets: ${npc.secrets.join(", ") || "none stated"}

Current state:
- Player class: ${state.player.className}
- Location: ${state.environment.location}
- Scene: ${state.environment.sceneSummary}
- Atmosphere: ${state.environment.atmosphere}
- Active quests: ${state.quests.filter((quest) => quest.status === "active").map((quest) => quest.title).join(", ") || "none"}
- Active enemies: ${state.enemies.map((enemy) => enemy.name).join(", ") || "none"}

Rules:
- Speak as ${npc.name}, not as the DM.
- Keep replies to 1 or 2 short paragraphs.
- Offer perspective, emotion, leverage, or hints.
- Do not emit tool calls or system narration.`;

  return [
    { role: "system", content: npcPrompt },
    ...recentHistory,
    { role: "user", content: playerInput },
  ];
}

export function createInitialGameState(input: {
  playerName: string;
  theme: string;
  startingCondition: string;
  selectedProvider: ProviderConfig["kind"];
  selectedModelId: string;
  classId: string;
}): GameState {
  const player = createDefaultPlayer(input.classId);
  const ruleset = createDefaultRuleset(input.theme);

  return {
    playerName: input.playerName,
    theme: input.theme,
    startingCondition: input.startingCondition,
    selectedProvider: input.selectedProvider,
    selectedModelId: input.selectedModelId,
    turnCount: 0,
    player,
    environment: {
      location: "Unknown",
      sceneSummary: "The world is waiting for the first decisive move.",
      atmosphere: "charged",
      biome: "unresolved",
      weather: "unclear",
      timeOfDay: "liminal",
      hazards: [],
      exits: [],
      factions: [],
      pressureClock: "A hidden timer is starting to tick.",
    },
    ruleset,
    inventory: [],
    quests: [],
    npcs: [],
    enemies: [],
    npcChats: {},
    story: [],
    artGallery: [],
    memoryLedger: [
      {
        id: createId("memory"),
        title: "Campaign seed",
        text: input.startingCondition,
        category: "canon",
        importance: 10,
        tags: ["origin", "theme"],
        updatedAt: Date.now(),
      },
      {
        id: createId("memory"),
        title: "Starting class",
        text: `${player.className} at level ${player.level}`,
        category: "system",
        importance: 8,
        tags: ["player", "class"],
        updatedAt: Date.now(),
      },
    ],
  };
}

export async function ensureEngine(
  modelId: string,
  onProgress?: (report: InitProgressReport) => void,
): Promise<MLCEngineInterface> {
  if (engine && activeModelId === modelId) {
    return engine;
  }

  if (activeWorker) {
    activeWorker.terminate();
    activeWorker = null;
  }

  activeWorker = new Worker(new URL("../workers/webllm.worker.ts", import.meta.url), {
    type: "module",
  });
  engine = await CreateWebWorkerMLCEngine(activeWorker, modelId, {
    appConfig: TOOL_CALLING_APP_CONFIG,
    initProgressCallback: onProgress,
    logLevel: "INFO",
  });
  activeModelId = modelId;
  return engine;
}

interface ToolMutationResult {
  nextState: GameState;
  toolResult: Record<string, unknown>;
  toolEvent: ToolEvent;
}

async function createProviderChatCompletion(input: {
  provider: ProviderConfig;
  messages: ChatCompletionMessageParam[];
  tools?: ChatCompletionTool[];
  temperature?: number;
  maxTokens?: number;
}): Promise<{
  content: string | null;
  tool_calls?: ChatCompletionMessageToolCall[];
}> {
  if (input.provider.kind === "openrouter") {
    if (!input.provider.openRouterApiKey) {
      throw new Error("OpenRouter API key is required for the remote provider.");
    }

    const response = await createOpenRouterChatCompletion({
      apiKey: input.provider.openRouterApiKey,
      model: input.provider.modelId,
      messages: input.messages,
      tools: input.tools,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
    });

    return {
      content: response.message.content,
      tool_calls: response.message.tool_calls as ChatCompletionMessageToolCall[] | undefined,
    };
  }

  if (!engine) {
    throw new Error("Engine has not been initialized.");
  }

  const response = await engine.chat.completions.create({
    messages: input.messages,
    tools: input.tools,
    tool_choice: input.tools ? "auto" : undefined,
    stream: false,
    temperature: input.temperature,
    max_tokens: input.maxTokens,
  });
  const assistantMessage = response.choices[0]?.message;
  if (!assistantMessage) {
    throw new Error("The model returned no message.");
  }

  return {
    content: assistantMessage.content ?? null,
    tool_calls: assistantMessage.tool_calls,
  };
}

function grantOrUpdateSpell(player: PlayerState, args: Record<string, unknown>): PlayerState {
  const existingSpell = getSpellDefinitionByName(asString(args.name));
  const spellName = asString(args.name, existingSpell?.name ?? "Unknown Spell");
  const nextSpell: SpellDefinition = {
    id:
      player.spells.find((spell) => normalize(spell.name) === normalize(spellName))?.id ??
      existingSpell?.id ??
      createId("spell"),
    name: spellName,
    level: clamp(asNumber(args.level, existingSpell?.level ?? 1), 0, 9),
    school: asString(args.school, existingSpell?.school ?? "Custom"),
    description: asString(
      args.description,
      existingSpell?.description ?? "A custom power introduced by the dungeon master.",
    ),
    sourceClassIds: asStringArray(args.sourceClassIds, 6).length
      ? asStringArray(args.sourceClassIds, 6)
      : existingSpell?.sourceClassIds ?? [player.classId],
    tags: asStringArray(args.tags, 8).length
      ? asStringArray(args.tags, 8)
      : existingSpell?.tags ?? ["custom"],
    resourceCost: clamp(asNumber(args.resourceCost, existingSpell?.resourceCost ?? 1), 0, 9),
    range: asString(args.range, existingSpell?.range ?? "Self"),
    isCustom: typeof args.isCustom === "boolean" ? args.isCustom : !existingSpell,
  };

  const existingIndex = player.spells.findIndex(
    (spell) => normalize(spell.name) === normalize(spellName),
  );
  const spells = [...player.spells];
  if (existingIndex >= 0) {
    spells[existingIndex] = nextSpell;
  } else {
    spells.unshift(nextSpell);
  }

  return {
    ...player,
    spells,
  };
}

function findEnemy(state: GameState, args: Record<string, unknown>): EnemyState | undefined {
  const byId = asString(args.enemyId);
  if (byId) {
    return state.enemies.find((enemy) => enemy.id === byId);
  }
  const byName = asString(args.name);
  if (byName) {
    return state.enemies.find((enemy) => normalize(enemy.name) === normalize(byName));
  }
  return undefined;
}

function applyToolCall(
  state: GameState,
  toolCall: ChatCompletionMessageToolCall,
): ToolMutationResult {
  const name = toolCall.function.name;
  let args: Record<string, unknown>;

  try {
    args = JSON.parse(toolCall.function.arguments);
  } catch {
    return {
      nextState: state,
      toolResult: { ok: false, error: "Invalid JSON arguments." },
      toolEvent: {
        id: createId("tool"),
        name,
        summary: `Failed to parse arguments for ${name}.`,
        payload: {},
      },
    };
  }

  switch (name) {
    case "set_environment": {
      const nextEnvironment = {
        ...state.environment,
        location: asString(args.location, state.environment.location),
        sceneSummary: asString(args.sceneSummary, state.environment.sceneSummary),
        atmosphere: asString(args.atmosphere, state.environment.atmosphere),
        biome: asString(args.biome, state.environment.biome),
        weather: asString(args.weather, state.environment.weather),
        timeOfDay: asString(args.timeOfDay, state.environment.timeOfDay),
        hazards: asStringArray(args.hazards, 8).length
          ? asStringArray(args.hazards, 8)
          : state.environment.hazards,
        exits: asStringArray(args.exits, 8).length
          ? asStringArray(args.exits, 8)
          : state.environment.exits,
        factions: asStringArray(args.factions, 8).length
          ? asStringArray(args.factions, 8)
          : state.environment.factions,
        pressureClock: asString(args.pressureClock, state.environment.pressureClock),
      };
      return {
        nextState: { ...state, environment: nextEnvironment },
        toolResult: { ok: true, environment: nextEnvironment },
        toolEvent: {
          id: createId("tool"),
          name,
          summary: `Environment updated: ${nextEnvironment.sceneSummary}`,
          payload: nextEnvironment,
        },
      };
    }

    case "set_player_profile": {
      const classId = asString(args.classId, state.player.classId);
      const definition = getClassDefinition(classId);
      const nextPlayer: PlayerState = {
        ...state.player,
        classId,
        className: asString(args.className, definition?.name ?? state.player.className),
        level: clamp(asNumber(args.level, state.player.level), 1, 20),
        xp: clamp(asNumber(args.xp, state.player.xp), 0, 999999),
        background: asString(args.background, state.player.background),
        ancestry: asString(args.ancestry, state.player.ancestry),
        alignment: asString(args.alignment, state.player.alignment),
        abilityScores: args.abilityScores
          ? mergeAbilityScores(state.player.abilityScores, asObject(args.abilityScores))
          : state.player.abilityScores,
        classFeatures: asStringArray(args.classFeatures, 12).length
          ? asStringArray(args.classFeatures, 12)
          : state.player.classFeatures,
        notes: asStringArray(args.notes, 10).length
          ? asStringArray(args.notes, 10)
          : state.player.notes,
        customTraits: asStringArray(args.customTraits, 10).length
          ? asStringArray(args.customTraits, 10)
          : state.player.customTraits,
      };

      return {
        nextState: { ...state, player: nextPlayer },
        toolResult: { ok: true, player: nextPlayer },
        toolEvent: {
          id: createId("tool"),
          name,
          summary: `Player profile updated: ${nextPlayer.className}, level ${nextPlayer.level}.`,
          payload: {
            classId: nextPlayer.classId,
            level: nextPlayer.level,
          },
        },
      };
    }

    case "adjust_player_resources": {
      const nextPlayer: PlayerState = {
        ...state.player,
        level: clamp(asNumber(args.level, state.player.level), 1, 20),
        xp: clamp(asNumber(args.xp, state.player.xp) + asNumber(args.xpDelta, 0), 0, 999999),
        resources: patchResources(state.player.resources, args),
      };

      return {
        nextState: { ...state, player: nextPlayer },
        toolResult: { ok: true, resources: nextPlayer.resources, level: nextPlayer.level, xp: nextPlayer.xp },
        toolEvent: {
          id: createId("tool"),
          name,
          summary: `Player resources updated. Health ${nextPlayer.resources.health}/${nextPlayer.resources.maxHealth}.`,
          payload: { ...nextPlayer.resources },
        },
      };
    }

    case "grant_spell": {
      const nextPlayer = grantOrUpdateSpell(state.player, args);
      const spellName = asString(args.name, "Unknown Spell");
      return {
        nextState: { ...state, player: nextPlayer },
        toolResult: {
          ok: true,
          spell: nextPlayer.spells.find((spell) => normalize(spell.name) === normalize(spellName)),
        },
        toolEvent: {
          id: createId("tool"),
          name,
          summary: `${spellName} added or updated on the player sheet.`,
          payload: { spellName },
        },
      };
    }

    case "revoke_spell": {
      const spellName = asString(args.name);
      const spells = state.player.spells.filter(
        (spell) => normalize(spell.name) !== normalize(spellName),
      );
      return {
        nextState: {
          ...state,
          player: {
            ...state.player,
            spells,
          },
        },
        toolResult: { ok: true, spellName, remaining: spells.length },
        toolEvent: {
          id: createId("tool"),
          name,
          summary: `${spellName} was removed from the player's abilities.`,
          payload: { spellName, reason: asString(args.reason) },
        },
      };
    }

    case "upsert_inventory_item": {
      const itemName = asString(args.name, "Unknown Item");
      const existing = state.inventory.find(
        (item) => normalize(item.name) === normalize(itemName),
      );
      const rarity = asString(args.rarity, existing?.rarity ?? "common") as InventoryItem["rarity"];
      const tags = asStringArray(args.tags, 8);
      const updatedItem: InventoryItem = {
        id: existing?.id ?? createId("item"),
        name: itemName,
        description: asString(args.description, existing?.description ?? "A notable object."),
        rarity,
        tags: tags.length ? tags : existing?.tags ?? ["misc"],
        quantity: clamp(asNumber(args.quantity, existing?.quantity ?? 1), 0, 999),
        iconPrompt: asString(args.iconPrompt, existing?.iconPrompt ?? itemName),
        iconUrl: buildItemIconUrl({
          name: itemName,
          rarity,
          tags: tags.length ? tags : existing?.tags ?? ["misc"],
        }),
        slot: asString(args.slot, existing?.slot ?? "pack"),
        weight: Math.max(0, asNumber(args.weight, existing?.weight ?? 1)),
        value: Math.max(0, asNumber(args.value, existing?.value ?? 0)),
        modifiers: {
          ...(existing?.modifiers ?? {}),
          ...asObject(args.modifiers),
        } as Record<string, number | string>,
        customAttributes: {
          ...(existing?.customAttributes ?? {}),
          ...asObject(args.customAttributes),
        },
        discoveredAt: existing?.discoveredAt ?? Date.now(),
      };
      const inventory = updatedItem.quantity <= 0
        ? state.inventory.filter((item) => item.id !== updatedItem.id)
        : existing
          ? state.inventory.map((item) => (item.id === existing.id ? updatedItem : item))
          : [updatedItem, ...state.inventory];

      return {
        nextState: { ...state, inventory },
        toolResult: { ok: true, item: updatedItem },
        toolEvent: {
          id: createId("tool"),
          name,
          summary: `${updatedItem.name} synchronized in inventory.`,
          payload: {
            itemId: updatedItem.id,
            quantity: updatedItem.quantity,
            modifiers: updatedItem.modifiers,
          },
        },
      };
    }

    case "remove_inventory_item": {
      const itemName = asString(args.name);
      const quantity = clamp(asNumber(args.quantity, 1), 1, 999);
      const existing = state.inventory.find(
        (item) => normalize(item.name) === normalize(itemName),
      );
      if (!existing) {
        return {
          nextState: state,
          toolResult: { ok: false, error: `Item not found: ${itemName}` },
          toolEvent: {
            id: createId("tool"),
            name,
            summary: `Attempted to remove missing item ${itemName}.`,
            payload: {},
          },
        };
      }
      const inventory = state.inventory
        .map((item) =>
          item.id === existing.id ? { ...item, quantity: item.quantity - quantity } : item,
        )
        .filter((item) => item.quantity > 0);

      return {
        nextState: { ...state, inventory },
        toolResult: { ok: true, itemName, reason: asString(args.reason), quantity },
        toolEvent: {
          id: createId("tool"),
          name,
          summary: `${itemName} removed from inventory.`,
          payload: { quantity, reason: asString(args.reason) },
        },
      };
    }

    case "upsert_quest": {
      const title = asString(args.title, "Untitled Quest");
      const existing = state.quests.find(
        (quest) => normalize(quest.title) === normalize(title),
      );
      const nextQuest: Quest = {
        id: existing?.id ?? createId("quest"),
        title,
        summary: asString(args.summary, existing?.summary ?? "A new objective emerges."),
        steps: asStringArray(args.steps, 8),
        status: asString(args.status, existing?.status ?? "active") as Quest["status"],
        rewardHint: asString(args.rewardHint, existing?.rewardHint ?? ""),
        updatedAt: Date.now(),
      };
      const quests = existing
        ? state.quests.map((quest) => (quest.id === existing.id ? nextQuest : quest))
        : [nextQuest, ...state.quests];
      return {
        nextState: { ...state, quests },
        toolResult: { ok: true, quest: nextQuest },
        toolEvent: {
          id: createId("tool"),
          name,
          summary: `Quest synchronized: ${nextQuest.title}.`,
          payload: { questId: nextQuest.id, status: nextQuest.status },
        },
      };
    }

    case "upsert_npc": {
      const npcName = asString(args.name, "Unknown Stranger");
      const existing = state.npcs.find((npc) => normalize(npc.name) === normalize(npcName));
      const npcId = existing?.id ?? createId("npc");
      const avatarPrompt = asString(args.avatarPrompt, npcName);
      const nextNpc: NpcProfile = {
        id: npcId,
        name: npcName,
        archetype: asString(args.archetype, existing?.archetype ?? "enigmatic figure"),
        personality: asString(args.personality, existing?.personality ?? "watchful"),
        disposition: asString(args.disposition, existing?.disposition ?? "curious"),
        voice: asString(args.voice, existing?.voice ?? "measured"),
        goals: asStringArray(args.goals, 6).length ? asStringArray(args.goals, 6) : existing?.goals ?? [],
        secrets: asStringArray(args.secrets, 6).length ? asStringArray(args.secrets, 6) : existing?.secrets ?? [],
        avatarPrompt,
        avatarUrl: buildGeneratedArtUrl(avatarPrompt, npcId, "portrait"),
        createdAt: existing?.createdAt ?? Date.now(),
      };
      const npcs = existing
        ? state.npcs.map((npc) => (npc.id === existing.id ? nextNpc : npc))
        : [nextNpc, ...state.npcs];
      const npcChats = {
        ...state.npcChats,
        [npcId]: state.npcChats[npcId] ?? [
          {
            id: createId("npcmsg"),
            role: "npc",
            content: `${npcName} steps into the story with their own perspective.`,
            createdAt: Date.now(),
          },
        ],
      };
      return {
        nextState: { ...state, npcs, npcChats },
        toolResult: { ok: true, npc: nextNpc },
        toolEvent: {
          id: createId("tool"),
          name,
          summary: `NPC synchronized: ${npcName}.`,
          payload: { npcId, disposition: nextNpc.disposition },
        },
      };
    }

    case "spawn_enemy": {
      const enemyId = createId("enemy");
      const portraitPrompt = asString(args.portraitPrompt, asString(args.name, "Hostile force"));
      const maxHealth = clamp(asNumber(args.maxHealth, 18), 1, 999);
      const nextEnemy: EnemyState = {
        id: enemyId,
        name: asString(args.name, "Unknown Enemy"),
        archetype: asString(args.archetype, "threat"),
        level: clamp(asNumber(args.level, 1), 1, 30),
        disposition: asString(args.disposition, "hostile"),
        tags: asStringArray(args.tags, 8),
        abilities: asStringArray(args.abilities, 8),
        lootHints: asStringArray(args.lootHints, 8),
        portraitPrompt,
        artUrl: buildGeneratedArtUrl(portraitPrompt, enemyId, "enemy"),
        stats: {
          maxHealth,
          health: clamp(asNumber(args.health, maxHealth), 0, maxHealth),
          armorClass: clamp(asNumber(args.armorClass, 12), 1, 50),
          attack: clamp(asNumber(args.attack, 4), 0, 50),
          magic: clamp(asNumber(args.magic, 0), 0, 50),
          speed: clamp(asNumber(args.speed, 3), 0, 50),
          morale: clamp(asNumber(args.morale, 50), 0, 100),
          threat: clamp(asNumber(args.threat, 40), 0, 100),
        },
        customAttributes: asObject(args.customAttributes),
        createdAt: Date.now(),
      };
      return {
        nextState: { ...state, enemies: [nextEnemy, ...state.enemies] },
        toolResult: { ok: true, enemy: nextEnemy },
        toolEvent: {
          id: createId("tool"),
          name,
          summary: `Enemy spawned: ${nextEnemy.name}.`,
          payload: { enemyId: nextEnemy.id, threat: nextEnemy.stats.threat },
        },
      };
    }

    case "update_enemy": {
      const existing = findEnemy(state, args);
      if (!existing) {
        return {
          nextState: state,
          toolResult: { ok: false, error: "Enemy not found." },
          toolEvent: {
            id: createId("tool"),
            name,
            summary: "Attempted to update a missing enemy.",
            payload: {},
          },
        };
      }
      const nextMaxHealth = clamp(asNumber(args.maxHealth, existing.stats.maxHealth), 1, 999);
      const updatedEnemy: EnemyState = {
        ...existing,
        name: asString(args.name, existing.name),
        archetype: asString(args.archetype, existing.archetype),
        level: clamp(asNumber(args.level, existing.level), 1, 30),
        disposition: asString(args.disposition, existing.disposition),
        tags: asStringArray(args.tags, 8).length ? asStringArray(args.tags, 8) : existing.tags,
        abilities: asStringArray(args.abilities, 8).length ? asStringArray(args.abilities, 8) : existing.abilities,
        lootHints: asStringArray(args.lootHints, 8).length ? asStringArray(args.lootHints, 8) : existing.lootHints,
        portraitPrompt: asString(args.portraitPrompt, existing.portraitPrompt),
        artUrl: asString(args.portraitPrompt)
          ? buildGeneratedArtUrl(asString(args.portraitPrompt), existing.id, "enemy")
          : existing.artUrl,
        stats: {
          maxHealth: nextMaxHealth,
          health: clamp(asNumber(args.health, existing.stats.health), 0, nextMaxHealth),
          armorClass: clamp(asNumber(args.armorClass, existing.stats.armorClass), 1, 50),
          attack: clamp(asNumber(args.attack, existing.stats.attack), 0, 50),
          magic: clamp(asNumber(args.magic, existing.stats.magic), 0, 50),
          speed: clamp(asNumber(args.speed, existing.stats.speed), 0, 50),
          morale: clamp(asNumber(args.morale, existing.stats.morale), 0, 100),
          threat: clamp(asNumber(args.threat, existing.stats.threat), 0, 100),
        },
        customAttributes: {
          ...existing.customAttributes,
          ...asObject(args.customAttributes),
        },
      };
      return {
        nextState: {
          ...state,
          enemies: state.enemies.map((enemy) => (enemy.id === existing.id ? updatedEnemy : enemy)),
        },
        toolResult: { ok: true, enemy: updatedEnemy },
        toolEvent: {
          id: createId("tool"),
          name,
          summary: `Enemy updated: ${updatedEnemy.name}.`,
          payload: { enemyId: updatedEnemy.id, health: updatedEnemy.stats.health },
        },
      };
    }

    case "remove_enemy": {
      const existing = findEnemy(state, args);
      if (!existing) {
        return {
          nextState: state,
          toolResult: { ok: false, error: "Enemy not found." },
          toolEvent: {
            id: createId("tool"),
            name,
            summary: "Attempted to remove a missing enemy.",
            payload: {},
          },
        };
      }
      return {
        nextState: {
          ...state,
          enemies: state.enemies.filter((enemy) => enemy.id !== existing.id),
        },
        toolResult: { ok: true, enemyId: existing.id, reason: asString(args.reason) },
        toolEvent: {
          id: createId("tool"),
          name,
          summary: `Enemy removed: ${existing.name}.`,
          payload: { enemyId: existing.id, reason: asString(args.reason) },
        },
      };
    }

    case "commit_memory": {
      const title = asString(args.title, "Untitled note");
      const existing = state.memoryLedger.find(
        (entry) => normalize(entry.title) === normalize(title),
      );
      const nextMemory: MemoryEntry = {
        id: existing?.id ?? createId("memory"),
        title,
        text: asString(args.text, existing?.text ?? ""),
        category: asString(args.category, existing?.category ?? "canon") as MemoryCategory,
        importance: clamp(asNumber(args.importance, existing?.importance ?? 5), 1, 10),
        tags: asStringArray(args.tags, 8).length ? asStringArray(args.tags, 8) : existing?.tags ?? [],
        updatedAt: Date.now(),
      };
      const memoryLedger = existing
        ? state.memoryLedger.map((entry) => (entry.id === existing.id ? nextMemory : entry))
        : [nextMemory, ...state.memoryLedger].slice(0, 40);
      return {
        nextState: { ...state, memoryLedger },
        toolResult: { ok: true, memory: nextMemory },
        toolEvent: {
          id: createId("tool"),
          name,
          summary: `Memory committed: ${nextMemory.title}.`,
          payload: { category: nextMemory.category, importance: nextMemory.importance },
        },
      };
    }

    case "rewrite_ruleset": {
      const nextRuleset: RulesetState = {
        ...state.ruleset,
        canonBaseline: asString(args.canonBaseline, state.ruleset.canonBaseline),
        rulesSummary: asString(args.rulesSummary, state.ruleset.rulesSummary),
        improviseAllowed:
          typeof args.improviseAllowed === "boolean"
            ? args.improviseAllowed
            : state.ruleset.improviseAllowed,
        combatStyle: asString(args.combatStyle, state.ruleset.combatStyle),
        restStyle: asString(args.restStyle, state.ruleset.restStyle),
        deathRules: asString(args.deathRules, state.ruleset.deathRules),
        magicRules: asString(args.magicRules, state.ruleset.magicRules),
        inventoryRules: asString(args.inventoryRules, state.ruleset.inventoryRules),
        socialRules: asString(args.socialRules, state.ruleset.socialRules),
        allowedClassIds: asStringArray(args.allowedClassIds, 20).length
          ? asStringArray(args.allowedClassIds, 20)
          : state.ruleset.allowedClassIds,
        mutableSystems: asStringArray(args.mutableSystems, 20).length
          ? asStringArray(args.mutableSystems, 20)
          : state.ruleset.mutableSystems,
        customMoves: asStringArray(args.customMoves, 20).length
          ? asStringArray(args.customMoves, 20)
          : state.ruleset.customMoves,
        ruleNotes: asStringArray(args.ruleNotes, 20).length
          ? asStringArray(args.ruleNotes, 20)
          : state.ruleset.ruleNotes,
      };
      return {
        nextState: { ...state, ruleset: nextRuleset },
        toolResult: { ok: true, ruleset: nextRuleset },
        toolEvent: {
          id: createId("tool"),
          name,
          summary: `Ruleset updated: ${nextRuleset.canonBaseline}.`,
          payload: {
            canonBaseline: nextRuleset.canonBaseline,
            mutableSystems: nextRuleset.mutableSystems,
          },
        },
      };
    }

    case "generate_art": {
      const focus = asString(args.focus, "scene") as GeneratedArt["focus"];
      const prompt = asString(args.prompt, state.environment.sceneSummary);
      const subjectId = asString(args.subjectId) || undefined;
      const art: GeneratedArt = {
        id: createId("art"),
        prompt,
        focus,
        url: buildGeneratedArtUrl(prompt, subjectId ?? createId("seed"), focus),
        createdAt: Date.now(),
        subjectId,
      };
      return {
        nextState: {
          ...state,
          artGallery: [art, ...state.artGallery].slice(0, 24),
          latestArtUrl: art.url,
        },
        toolResult: { ok: true, art },
        toolEvent: {
          id: createId("tool"),
          name,
          summary: `Generated ${focus} art.`,
          payload: { artId: art.id, focus },
        },
      };
    }

    default:
      return {
        nextState: state,
        toolResult: { ok: false, error: `Unknown tool: ${name}` },
        toolEvent: {
          id: createId("tool"),
          name,
          summary: `Unknown tool requested: ${name}`,
          payload: {},
        },
      };
  }
}

export async function runDungeonMasterTurn(
  currentState: GameState,
  playerAction: string,
  provider: ProviderConfig,
): Promise<{ nextState: GameState; reply: string; toolEvents: ToolEvent[]; imageUrl?: string }> {
  if (provider.kind === "webllm" && !engine) {
    throw new Error("Engine has not been initialized.");
  }

  let workingState: GameState = {
    ...currentState,
    turnCount: currentState.turnCount + 1,
  };
  const messages = buildDungeonMasterMessages(workingState, playerAction);
  const toolEvents: ToolEvent[] = [];

  for (let iteration = 0; iteration < 8; iteration += 1) {
    const assistantMessage = await createProviderChatCompletion({
      provider,
      messages,
      tools: DUNGEON_MASTER_TOOLS,
      temperature: 0.95,
      maxTokens: 840,
    });

    if (assistantMessage.tool_calls?.length) {
      messages.push({
        role: "assistant",
        content: assistantMessage.content ?? null,
        tool_calls: assistantMessage.tool_calls,
      });

      for (const toolCall of assistantMessage.tool_calls) {
        const mutation = applyToolCall(workingState, toolCall);
        workingState = mutation.nextState;
        toolEvents.push(mutation.toolEvent);
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(mutation.toolResult),
        });
      }

      continue;
    }

    return {
      nextState: workingState,
      reply:
        assistantMessage.content?.trim() ||
        "The world pauses in a tense silence, waiting for a sharper move.",
      toolEvents,
      imageUrl: workingState.latestArtUrl,
    };
  }

  return {
    nextState: workingState,
    reply:
      "The simulation is carrying too many simultaneous threads. Take a more focused action to push the scene cleanly forward.",
    toolEvents,
    imageUrl: workingState.latestArtUrl,
  };
}

export async function runNpcTurn(
  state: GameState,
  npcId: string,
  playerInput: string,
  provider: ProviderConfig,
): Promise<string> {
  if (provider.kind === "webllm" && !engine) {
    throw new Error("Engine has not been initialized.");
  }

  const npc = state.npcs.find((entry) => entry.id === npcId);
  if (!npc) {
    throw new Error("NPC not found.");
  }

  const history = state.npcChats[npcId] ?? [];
  const response = await createProviderChatCompletion({
    provider,
    messages: buildNpcMessages(state, npc, history, playerInput),
    temperature: 0.9,
    maxTokens: 320,
  });

  return (
    response.content?.trim() ||
    `${npc.name} watches you carefully and says nothing that can be trusted yet.`
  );
}
