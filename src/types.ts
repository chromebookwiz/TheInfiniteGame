export type Rarity =
  | "common"
  | "uncommon"
  | "rare"
  | "epic"
  | "legendary"
  | "mythic";

export type QuestStatus = "active" | "completed" | "failed";
export type StorySpeaker = "dm" | "player" | "system";
export type NpcChatRole = "player" | "npc";
export type ArtFocus = "scene" | "portrait" | "item" | "enemy";
export type ProviderKind = "webllm" | "openrouter";
export type MemoryCategory =
  | "canon"
  | "objective"
  | "threat"
  | "relationship"
  | "system"
  | "scene";

export interface AbilityScores {
  strength: number;
  dexterity: number;
  constitution: number;
  intelligence: number;
  wisdom: number;
  charisma: number;
}

export interface CharacterResources {
  maxHealth: number;
  health: number;
  maxMana: number;
  mana: number;
  maxStamina: number;
  stamina: number;
  armorClass: number;
  initiative: number;
  luck: number;
  renown: number;
  gold: number;
}

export interface SpellDefinition {
  id: string;
  name: string;
  level: number;
  school: string;
  description: string;
  sourceClassIds: string[];
  tags: string[];
  resourceCost: number;
  range: string;
  isCustom: boolean;
}

export interface PlayerClassDefinition {
  id: string;
  name: string;
  role: string;
  primaryAbilities: string[];
  hitDie: number;
  spellcasting: "none" | "half" | "full" | "pact" | "hybrid";
  startingFeatures: string[];
  suggestedSpellIds: string[];
}

export interface PlayerState {
  classId: string;
  className: string;
  level: number;
  xp: number;
  background: string;
  ancestry: string;
  alignment: string;
  abilityScores: AbilityScores;
  resources: CharacterResources;
  classFeatures: string[];
  spells: SpellDefinition[];
  notes: string[];
  customTraits: string[];
}

export interface InventoryItem {
  id: string;
  name: string;
  description: string;
  rarity: Rarity;
  tags: string[];
  quantity: number;
  iconPrompt: string;
  iconUrl: string;
  slot: string;
  weight: number;
  value: number;
  modifiers: Record<string, number | string>;
  customAttributes: Record<string, unknown>;
  discoveredAt: number;
}

export interface Quest {
  id: string;
  title: string;
  summary: string;
  steps: string[];
  status: QuestStatus;
  rewardHint?: string;
  updatedAt: number;
}

export interface NpcProfile {
  id: string;
  name: string;
  archetype: string;
  personality: string;
  disposition: string;
  voice: string;
  goals: string[];
  secrets: string[];
  avatarPrompt: string;
  avatarUrl: string;
  createdAt: number;
}

export interface EnemyState {
  id: string;
  name: string;
  archetype: string;
  level: number;
  disposition: string;
  tags: string[];
  abilities: string[];
  lootHints: string[];
  portraitPrompt: string;
  artUrl: string;
  stats: {
    maxHealth: number;
    health: number;
    armorClass: number;
    attack: number;
    magic: number;
    speed: number;
    morale: number;
    threat: number;
  };
  customAttributes: Record<string, unknown>;
  createdAt: number;
}

export interface NpcChatMessage {
  id: string;
  role: NpcChatRole;
  content: string;
  createdAt: number;
}

export interface ToolEvent {
  id: string;
  name: string;
  summary: string;
  payload: Record<string, unknown>;
}

export interface StoryBeat {
  id: string;
  speaker: StorySpeaker;
  content: string;
  createdAt: number;
  toolEvents: ToolEvent[];
  imageUrl?: string;
}

export interface GeneratedArt {
  id: string;
  prompt: string;
  focus: ArtFocus;
  url: string;
  createdAt: number;
  subjectId?: string;
}

export interface EnvironmentState {
  location: string;
  sceneSummary: string;
  atmosphere: string;
  biome: string;
  weather: string;
  timeOfDay: string;
  hazards: string[];
  exits: string[];
  factions: string[];
  pressureClock: string;
}

export interface MemoryEntry {
  id: string;
  title: string;
  text: string;
  category: MemoryCategory;
  importance: number;
  tags: string[];
  updatedAt: number;
}

export interface RulesetState {
  canonBaseline: string;
  rulesSummary: string;
  improviseAllowed: boolean;
  combatStyle: string;
  restStyle: string;
  deathRules: string;
  magicRules: string;
  inventoryRules: string;
  socialRules: string;
  allowedClassIds: string[];
  mutableSystems: string[];
  customMoves: string[];
  ruleNotes: string[];
}

export interface GameState {
  playerName: string;
  theme: string;
  startingCondition: string;
  selectedProvider: ProviderKind;
  selectedModelId: string;
  turnCount: number;
  player: PlayerState;
  environment: EnvironmentState;
  ruleset: RulesetState;
  inventory: InventoryItem[];
  quests: Quest[];
  npcs: NpcProfile[];
  enemies: EnemyState[];
  npcChats: Record<string, NpcChatMessage[]>;
  story: StoryBeat[];
  artGallery: GeneratedArt[];
  memoryLedger: MemoryEntry[];
  latestArtUrl?: string;
}

export interface SavedSession {
  game: GameState;
  selectedNpcId?: string;
}

export interface ModelOption {
  id: string;
  label: string;
  lowResource: boolean;
  vramRequiredMB?: number;
}

export interface EngineStatus {
  phase: "idle" | "loading" | "ready" | "error";
  text: string;
}

export interface ProviderConfig {
  kind: ProviderKind;
  modelId: string;
  openRouterApiKey?: string;
}
