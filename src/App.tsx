import { useCallback, useEffect, useRef, useState } from "react";
import { DND_CLASSES } from "./data/dnd";
import { STARTING_CONDITIONS, pickRandomStartingCondition } from "./data/startingConditions";
import {
  type AccountUser,
  deleteCloudCampaign,
  getCurrentAccountUser,
  isSupabaseConfigured,
  listCloudCampaignSaves,
  saveCloudCampaign,
  signInWithEmail,
  signInWithGoogle,
  signOutAccount,
  signUpWithEmail,
  subscribeToAccountChanges,
} from "./lib/account";
import {
  chooseActionApproach,
  createInitialGameState,
  ensureEngine,
  runDungeonMasterTurn,
  runNpcTurn,
} from "./lib/gameAgent";
import { createCombatFromGame, moveCombatant } from "./lib/combat";
import {
  inferCampaignTheme,
  maintainGameContext,
  normalizeGameState,
} from "./lib/gameState";
import { getDefaultModelId, getToolCallingModels } from "./lib/models";
import { OPENROUTER_MODELS } from "./lib/openrouter";
import { DEFAULT_OPENROUTER_MODEL } from "./lib/providerConfig";
import {
  clearEncryptedOpenRouterKey,
  getDecryptedOpenRouterKey,
  hasEncryptedOpenRouterKey,
  storeEncryptedOpenRouterKey,
} from "./lib/secureStorage";
import type {
  ActionApproach,
  ActionCheck,
  ArtFocus,
  ArtProviderKind,
  ArtWorkflowConfig,
  CampaignThemeId,
  CloudCampaignSave,
  EngineStatus,
  GameState,
  ModelOption,
  NpcChatMessage,
  ProviderConfig,
  ProviderKind,
  SavedSession,
  StoryBeat,
  StorySpeaker,
} from "./types";

const STORAGE_KEY = "the-infinite-game/session";
const MUSIC_STORAGE_KEY = "the-infinite-game/music";

type GameTab = "journal" | "surroundings" | "combat" | "party" | "inventory" | "player" | "quests";
type AuthMode = "signin" | "signup";
type AsyncStatus = "idle" | "loading" | "ready" | "error";
type TerminalTheme = CampaignThemeId;
type AbilityKey = keyof GameState["player"]["abilityScores"];

const ART_FOCI: ArtFocus[] = ["scene", "environment", "character", "portrait", "enemy", "item"];
const MUSIC_TRACKS = [
  "/music/Glass%20Harbors.mp3",
  "/music/Pearl%20Strings.mp3",
  "/music/Tin%20Cup%20Radiance.mp3",
  "/music/Velvet%20Dungeon.mp3",
];
const DEFAULT_LOCAL_ENDPOINT = "http://127.0.0.1:11434/v1";
const DEFAULT_LOCAL_MODEL = "llama3.1";
const DIRECTOR_PREFIX_PATTERN = /^\/?\s*(?:director|dm|system)\s*[:/-]\s*/i;

function createStoryBeat(
  speaker: StorySpeaker,
  content: string,
  extra?: Partial<StoryBeat>,
): StoryBeat {
  return {
    id: `${speaker}_${crypto.randomUUID()}`,
    speaker,
    content,
    createdAt: Date.now(),
    toolEvents: [],
    ...extra,
  };
}

function createNpcMessage(role: NpcChatMessage["role"], content: string): NpcChatMessage {
  return {
    id: `${role}_${crypto.randomUUID()}`,
    role,
    content,
    createdAt: Date.now(),
  };
}

function formatStoryTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

function formatCalendarTimestamp(timestamp: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function formatResourceMeter(current: number, max: number): string {
  if (max <= 0) {
    return "0%";
  }

  return `${Math.max(0, Math.min(100, (current / max) * 100))}%`;
}

function abilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

function createActionCheck(game: GameState, approach: ActionApproach): ActionCheck {
  const ability = approach.ability as AbilityKey;
  const risk = approach.risk;
  const roll = Math.floor(Math.random() * 20) + 1;
  const modifier = abilityModifier(game.player.abilityScores[ability]);
  const difficulty = risk === "controlled" ? 11 : risk === "desperate" ? 17 : 14;
  const total = roll + modifier;
  const outcomeBand =
    roll === 20 || total >= difficulty + 6
      ? "critical"
      : total >= difficulty
        ? "success"
        : total >= difficulty - 4
          ? "mixed"
          : "miss";

  return {
    id: `check_${crypto.randomUUID()}`,
    ability,
    risk,
    approachLabel: approach.label,
    approachRationale: approach.rationale,
    roll,
    modifier,
    total,
    difficulty,
    outcomeBand,
    createdAt: Date.now(),
  };
}

function buildActionPacket(action: string, check: ActionCheck, game: GameState): string {
  const shortcuts = game.sceneControls.blockedShortcuts.join("; ") || "none listed";
  const moves = game.sceneControls.availableMoves.join("; ") || "improvise carefully";
  const abilityScore = game.player.abilityScores[check.ability];
  return [
    `Player intent: ${action}`,
    `Director-selected approach: ${check.approachLabel ?? check.ability} using ${check.ability}; risk ${check.risk}.`,
    `Approach rationale: ${check.approachRationale ?? "The director chose the governing stat from the declared intent and scene pressure."}`,
    `Action check: ${check.ability} score ${abilityScore}, d20 ${check.roll} ${check.modifier >= 0 ? "+" : ""}${check.modifier} = ${check.total} vs DC ${check.difficulty} (${check.outcomeBand}).`,
    `Scene stakes: ${game.sceneControls.stakes}`,
    `Available action lanes: ${moves}`,
    `Do not allow these shortcuts as declarations: ${shortcuts}`,
    "Resolve this as an attempt, not automatic success. Apply costs, resource changes, grid movement, ally/enemy actions, clocks, and consequences through tools.",
  ].join("\n");
}

function isDirectorCommand(input: string): boolean {
  return DIRECTOR_PREFIX_PATTERN.test(input);
}

function normalizeDirectorCommand(input: string): string {
  return input.replace(DIRECTOR_PREFIX_PATTERN, "").trim();
}

function buildDirectorPacket(command: string, game: GameState): string {
  return [
    `Director command: ${command}`,
    "This is not a player action and should not receive a player roll.",
    "Retrieve the relevant campaign facts from the provided state packet and memory ledger, then use tools to update environment, scene controls, quests, enemies, party, inventory, art, combat, or memory as needed.",
    `Current stakes: ${game.sceneControls.stakes}`,
    `Pressure clock: ${game.sceneControls.clockName} ${game.sceneControls.clockValue}/${game.sceneControls.clockMax}`,
    "After tool calls, report the resulting world change crisply and keep the next playable moment clear.",
  ].join("\n");
}

function buildCampaignTitle(game: GameState): string {
  const trimmedTheme = game.theme.trim();
  const headline = trimmedTheme.length > 52 ? `${trimmedTheme.slice(0, 52)}...` : trimmedTheme;
  return `${game.playerName} · ${headline} · Turn ${game.turnCount}`;
}

function formatProviderLabel(game: Pick<GameState, "selectedProvider" | "selectedModelId" | "selectedEndpoint">): string {
  if (game.selectedProvider === "openrouter") {
    return `OpenRouter / ${game.selectedModelId}`;
  }
  if (game.selectedProvider === "local") {
    return `Local / ${game.selectedModelId}`;
  }
  return `WebLLM / ${game.selectedModelId}`;
}

function isCompatibleSession(value: unknown): value is SavedSession {
  if (!value || typeof value !== "object") {
    return false;
  }

  const session = value as SavedSession;
  return Boolean(
    session.game &&
      session.game.player &&
      session.game.environment &&
      session.game.ruleset &&
      Array.isArray(session.game.inventory) &&
      Array.isArray(session.game.story),
  );
}

function App() {
  const supabaseEnabled = isSupabaseConfigured();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [hasHydratedSession, setHasHydratedSession] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [playerName, setPlayerName] = useState("Traveler");
  const [randomSeed, setRandomSeed] = useState(pickRandomStartingCondition());
  const [customTheme, setCustomTheme] = useState("");
  const [selectedProvider, setSelectedProvider] = useState<ProviderKind>("openrouter");
  const [toolCallingModels, setToolCallingModels] = useState<ModelOption[]>([]);
  const [webllmCatalogStatus, setWebllmCatalogStatus] = useState<AsyncStatus>("idle");
  const [selectedModelId, setSelectedModelId] = useState("");
  const [selectedOpenRouterModel, setSelectedOpenRouterModel] = useState(DEFAULT_OPENROUTER_MODEL);
  const [selectedLocalEndpoint, setSelectedLocalEndpoint] = useState(DEFAULT_LOCAL_ENDPOINT);
  const [selectedLocalModel, setSelectedLocalModel] = useState(DEFAULT_LOCAL_MODEL);
  const [selectedLocalApiKey, setSelectedLocalApiKey] = useState("");
  const [selectedClassId, setSelectedClassId] = useState(DND_CLASSES[0]?.id ?? "fighter");
  const [openRouterKeyInput, setOpenRouterKeyInput] = useState("");
  const [openRouterKeyStored, setOpenRouterKeyStored] = useState(false);
  const [game, setGame] = useState<GameState | null>(null);
  const [selectedNpcId, setSelectedNpcId] = useState<string | undefined>(undefined);
  const [activeTab, setActiveTab] = useState<GameTab>("surroundings");
  const [actionInput, setActionInput] = useState("");
  const [directorInput, setDirectorInput] = useState("");
  const [selectedCombatantId, setSelectedCombatantId] = useState("player");
  const [showSettings, setShowSettings] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [npcInput, setNpcInput] = useState("");
  const [busyLabel, setBusyLabel] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [engineStatus, setEngineStatus] = useState<EngineStatus>({
    phase: "idle",
    text: "Choose OpenRouter, browser WebLLM, or a local Ollama/vLLM endpoint before starting.",
  });
  const [authMode, setAuthMode] = useState<AuthMode>("signup");
  const [accountUser, setAccountUser] = useState<AccountUser | null>(null);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authBusyLabel, setAuthBusyLabel] = useState("");
  const [authMessage, setAuthMessage] = useState("");
  const [cloudHistory, setCloudHistory] = useState<CloudCampaignSave[]>([]);
  const [cloudHistoryBusy, setCloudHistoryBusy] = useState(false);
  const [cloudSaveId, setCloudSaveId] = useState<string | undefined>(undefined);
  const [cloudSyncLabel, setCloudSyncLabel] = useState("");
  const [cloudError, setCloudError] = useState("");
  const [terminalTheme, setTerminalTheme] = useState<TerminalTheme>("mono");
  const [workflowName, setWorkflowName] = useState("Comfy workflow");
  const [workflowFocus, setWorkflowFocus] = useState<ArtFocus>("scene");
  const [workflowJson, setWorkflowJson] = useState("");
  const [workflowPromptNodeId, setWorkflowPromptNodeId] = useState("");
  const [workflowPromptInputName, setWorkflowPromptInputName] = useState("text");
  const [musicTrackIndex, setMusicTrackIndex] = useState(0);
  const [musicVolume, setMusicVolume] = useState(0.55);
  const [musicMuted, setMusicMuted] = useState(false);
  const [musicPlaying, setMusicPlaying] = useState(false);
  const [musicError, setMusicError] = useState("");

  useEffect(() => {
    if (!game) {
      setTerminalTheme(inferCampaignTheme(customTheme.trim() || randomSeed).id);
    }
  }, [customTheme, game, randomSeed]);

  useEffect(() => {
    const raw = localStorage.getItem(MUSIC_STORAGE_KEY);
    if (!raw) {
      return;
    }

    try {
      const parsed = JSON.parse(raw) as {
        trackIndex?: number;
        volume?: number;
        muted?: boolean;
      };
      if (typeof parsed.trackIndex === "number") {
        setMusicTrackIndex(Math.min(MUSIC_TRACKS.length - 1, Math.max(0, parsed.trackIndex)));
      }
      if (typeof parsed.volume === "number") {
        setMusicVolume(Math.min(1, Math.max(0, parsed.volume)));
      }
      if (typeof parsed.muted === "boolean") {
        setMusicMuted(parsed.muted);
      }
    } catch {
      localStorage.removeItem(MUSIC_STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(
      MUSIC_STORAGE_KEY,
      JSON.stringify({ trackIndex: musicTrackIndex, volume: musicVolume, muted: musicMuted }),
    );
  }, [musicMuted, musicTrackIndex, musicVolume]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    audio.volume = musicMuted ? 0 : musicVolume;
    audio.muted = musicMuted;
  }, [musicMuted, musicVolume]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !musicPlaying) {
      return;
    }

    void audio.play().catch(() => {
      setMusicPlaying(false);
      setMusicError("Press play to start music in this browser.");
    });
  }, [musicPlaying, musicTrackIndex]);

  const loadWebllmCatalog = useCallback(async () => {
    if (webllmCatalogStatus === "loading" || webllmCatalogStatus === "ready") {
      return;
    }

    setWebllmCatalogStatus("loading");
    try {
      const [models, defaultModelId] = await Promise.all([
        getToolCallingModels(),
        getDefaultModelId(),
      ]);
      setToolCallingModels(models);
      setSelectedModelId((current) => current || defaultModelId || models[0]?.id || "");
      setWebllmCatalogStatus("ready");
    } catch (error) {
      setWebllmCatalogStatus("error");
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to load the WebLLM model catalog.",
      );
    }
  }, [webllmCatalogStatus]);

  const refreshCloudHistory = useCallback(async () => {
    if (!supabaseEnabled || !accountUser) {
      setCloudHistory([]);
      return;
    }

    setCloudHistoryBusy(true);
    setCloudError("");
    try {
      const saves = await listCloudCampaignSaves();
      setCloudHistory(saves);
    } catch (error) {
      setCloudError(
        error instanceof Error ? error.message : "Failed to load cloud campaign history.",
      );
    } finally {
      setCloudHistoryBusy(false);
    }
  }, [accountUser, supabaseEnabled]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 820px)");
    const sync = () => setIsMobile(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    setOpenRouterKeyStored(hasEncryptedOpenRouterKey());
  }, []);

  useEffect(() => {
    if (selectedProvider === "webllm") {
      void loadWebllmCatalog();
    }
  }, [loadWebllmCatalog, selectedProvider]);

  useEffect(() => {
    if (isMobile && hasEncryptedOpenRouterKey()) {
      setSelectedProvider((current) => (current === "webllm" ? "openrouter" : current));
    }
  }, [isMobile]);

  useEffect(() => {
    if (!supabaseEnabled) {
      return;
    }

    let active = true;

    void getCurrentAccountUser()
      .then((user) => {
        if (!active) {
          return;
        }
        setAccountUser(user);
        if (user) {
          setAuthMessage(
            user.emailVerified
              ? `Signed in as ${user.email}. Cloud history is active.`
              : `Signed in as ${user.email}. Verify the email inbox to finish account confirmation.`,
          );
        }
      })
      .catch((error) => {
        if (active) {
          setCloudError(error instanceof Error ? error.message : "Failed to restore the account session.");
        }
      });

    const unsubscribe = subscribeToAccountChanges((user) => {
      setAccountUser(user);
      if (!user) {
        setCloudHistory([]);
        setCloudSaveId(undefined);
        setCloudSyncLabel("");
        setAuthMessage("Signed out. Local save remains on this device.");
        return;
      }

      setAuthMessage(
        user.emailVerified
          ? `Signed in as ${user.email}. Cloud history is active.`
          : `Signed in as ${user.email}. Verify the email inbox to finish account confirmation.`,
      );
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [supabaseEnabled]);

  useEffect(() => {
    void refreshCloudHistory();
  }, [refreshCloudHistory]);

  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      setHasHydratedSession(true);
      return;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isCompatibleSession(parsed)) {
        localStorage.removeItem(STORAGE_KEY);
        setHasHydratedSession(true);
        return;
      }

      const normalizedGame = normalizeGameState(parsed.game);
      setGame(normalizedGame);
      setSelectedNpcId(parsed.selectedNpcId);
      setSelectedProvider(normalizedGame.selectedProvider ?? "openrouter");
      setSelectedModelId(normalizedGame.selectedProvider === "webllm" ? normalizedGame.selectedModelId : "");
      setSelectedOpenRouterModel(
        normalizedGame.selectedProvider === "openrouter"
          ? normalizedGame.selectedModelId
          : DEFAULT_OPENROUTER_MODEL,
      );
      setSelectedLocalModel(
        normalizedGame.selectedProvider === "local"
          ? normalizedGame.selectedModelId
          : DEFAULT_LOCAL_MODEL,
      );
      setSelectedLocalEndpoint(normalizedGame.selectedEndpoint ?? DEFAULT_LOCAL_ENDPOINT);
      setSelectedClassId(normalizedGame.player.classId);
      setEngineStatus({
        phase: "idle",
        text: `Saved campaign found for ${normalizedGame.playerName}. Resume with ${formatProviderLabel(normalizedGame)}.`,
      });
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    } finally {
      setHasHydratedSession(true);
    }
  }, []);

  useEffect(() => {
    if (!hasHydratedSession) {
      return;
    }

    if (!game) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }

    const payload: SavedSession = {
      game,
      selectedNpcId,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  }, [game, hasHydratedSession, selectedNpcId]);

  useEffect(() => {
    if (!hasHydratedSession || !game || !supabaseEnabled || !accountUser) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setCloudSyncLabel(cloudSaveId ? "Syncing cloud history..." : "Creating cloud save...");
      setCloudError("");
      void saveCloudCampaign({
        saveId: cloudSaveId,
        title: buildCampaignTitle(game),
        game,
        selectedNpcId,
      })
        .then((saved) => {
          setCloudSaveId(saved.id);
          setCloudSyncLabel(`Cloud saved ${formatCalendarTimestamp(saved.updatedAt)}`);
          setCloudHistory((current) => {
            const next = [saved, ...current.filter((entry) => entry.id !== saved.id)];
            return next.sort(
              (left, right) =>
                new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
            );
          });
        })
        .catch((error) => {
          setCloudError(error instanceof Error ? error.message : "Cloud sync failed.");
          setCloudSyncLabel("");
        });
    }, 1200);

    return () => window.clearTimeout(timeoutId);
  }, [accountUser, cloudSaveId, game, hasHydratedSession, selectedNpcId, supabaseEnabled]);

  async function buildProviderConfig(kind: ProviderKind): Promise<ProviderConfig> {
    if (kind === "openrouter") {
      const apiKey = await getDecryptedOpenRouterKey();
      if (!apiKey) {
        throw new Error("No OpenRouter API key is stored on this device.");
      }
      return {
        kind,
        modelId: selectedOpenRouterModel.trim() || DEFAULT_OPENROUTER_MODEL,
        openRouterApiKey: apiKey,
      };
    }

    if (kind === "local") {
      const endpoint = selectedLocalEndpoint.trim() || DEFAULT_LOCAL_ENDPOINT;
      const modelId = selectedLocalModel.trim() || DEFAULT_LOCAL_MODEL;
      return {
        kind,
        endpoint,
        modelId,
        apiKey: selectedLocalApiKey.trim() || undefined,
      };
    }

    const modelId = selectedModelId || (await getDefaultModelId());
    if (!selectedModelId && modelId) {
      setSelectedModelId(modelId);
    }

    return {
      kind,
      modelId,
    };
  }

  async function ensureProviderReady(provider: ProviderConfig) {
    if (provider.kind === "openrouter") {
      setEngineStatus({
        phase: "ready",
        text: `${provider.modelId} is ready through OpenRouter. The API key is stored encrypted on this device.`,
      });
      return;
    }

    if (provider.kind === "local") {
      setEngineStatus({
        phase: "ready",
        text: `${provider.modelId} is ready through ${provider.endpoint}.`,
      });
      return;
    }

    setEngineStatus({ phase: "loading", text: `Loading ${provider.modelId}...` });
    await ensureEngine(provider.modelId, (report) => {
      setEngineStatus({ phase: "loading", text: report.text });
    });
    setEngineStatus({
      phase: "ready",
      text: `${provider.modelId} is ready with local WebLLM tool calling enabled.`,
    });
  }

  async function handleStoreOpenRouterKey() {
    if (!openRouterKeyInput.trim()) {
      setErrorMessage("Enter an OpenRouter API key first.");
      return;
    }

    setBusyLabel("Encrypting API key on this device...");
    setErrorMessage("");
    try {
      await storeEncryptedOpenRouterKey(openRouterKeyInput.trim());
      setOpenRouterKeyInput("");
      setOpenRouterKeyStored(true);
      setEngineStatus({
        phase: "ready",
        text: "OpenRouter API key stored encrypted on this device.",
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to store API key.");
    } finally {
      setBusyLabel("");
    }
  }

  function handleClearOpenRouterKey() {
    clearEncryptedOpenRouterKey();
    setOpenRouterKeyStored(false);
    if (selectedProvider === "openrouter") {
      setSelectedProvider("local");
    }
    setEngineStatus({
      phase: "idle",
      text: "Encrypted OpenRouter API key removed from this device.",
    });
  }

  async function handleAuthSubmit() {
    if (!supabaseEnabled) {
      setCloudError("Supabase auth is not configured in this deployment.");
      return;
    }

    if (!authEmail.trim() || !authPassword.trim()) {
      setCloudError("Enter both email and password.");
      return;
    }

    setAuthBusyLabel(authMode === "signup" ? "Creating account..." : "Signing in...");
    setCloudError("");
    try {
      if (authMode === "signup") {
        const result = await signUpWithEmail(authEmail.trim(), authPassword);
        setAccountUser(result.user);
        setAuthMessage(
          result.needsEmailVerification
            ? `Verification email sent to ${authEmail.trim()}. Finish confirmation, then sign in.`
            : `Account ready for ${authEmail.trim()}. Cloud history is active.`,
        );
      } else {
        const user = await signInWithEmail(authEmail.trim(), authPassword);
        setAccountUser(user);
        setAuthMessage(`Signed in as ${authEmail.trim()}. Cloud history is active.`);
      }
      setAuthPassword("");
    } catch (error) {
      setCloudError(error instanceof Error ? error.message : "Authentication failed.");
    } finally {
      setAuthBusyLabel("");
    }
  }

  async function handleGoogleLogin() {
    if (!supabaseEnabled) {
      setCloudError("Supabase auth is not configured in this deployment.");
      return;
    }

    setAuthBusyLabel("Redirecting to Google...");
    setCloudError("");
    try {
      await signInWithGoogle();
    } catch (error) {
      setCloudError(error instanceof Error ? error.message : "Google sign-in failed.");
      setAuthBusyLabel("");
    }
  }

  async function handleSignOut() {
    setAuthBusyLabel("Signing out...");
    setCloudError("");
    try {
      await signOutAccount();
      setAccountUser(null);
      setCloudHistory([]);
      setCloudSaveId(undefined);
      setCloudSyncLabel("");
    } catch (error) {
      setCloudError(error instanceof Error ? error.message : "Failed to sign out.");
    } finally {
      setAuthBusyLabel("");
    }
  }

  async function handleLoadCloudSave(save: CloudCampaignSave) {
    const normalizedGame = normalizeGameState(save.game);
    setGame(normalizedGame);
    setSelectedNpcId(save.selectedNpcId);
    setSelectedProvider(normalizedGame.selectedProvider);
    setSelectedClassId(normalizedGame.player.classId);
    setSelectedModelId(normalizedGame.selectedProvider === "webllm" ? normalizedGame.selectedModelId : "");
    setSelectedOpenRouterModel(
      normalizedGame.selectedProvider === "openrouter"
        ? normalizedGame.selectedModelId
        : DEFAULT_OPENROUTER_MODEL,
    );
    setSelectedLocalModel(
      normalizedGame.selectedProvider === "local"
        ? normalizedGame.selectedModelId
        : DEFAULT_LOCAL_MODEL,
    );
    setSelectedLocalEndpoint(normalizedGame.selectedEndpoint ?? DEFAULT_LOCAL_ENDPOINT);
    setCloudSaveId(save.id);
    setActiveTab("surroundings");
    setEngineStatus({
      phase: "idle",
      text: `Loaded cloud campaign: ${save.title}`,
    });
    if (normalizedGame.selectedProvider === "webllm") {
      void loadWebllmCatalog();
    }
  }

  async function handleDeleteCloudSave(saveId: string) {
    setCloudHistoryBusy(true);
    setCloudError("");
    try {
      await deleteCloudCampaign(saveId);
      setCloudHistory((current) => current.filter((entry) => entry.id !== saveId));
      if (cloudSaveId === saveId) {
        setCloudSaveId(undefined);
      }
    } catch (error) {
      setCloudError(error instanceof Error ? error.message : "Failed to delete the cloud save.");
    } finally {
      setCloudHistoryBusy(false);
    }
  }

  async function handleStartAdventure() {
    const startingCondition = customTheme.trim() || randomSeed;
    if (!startingCondition) {
      setErrorMessage("Pick a random seed or write a custom theme before starting.");
      return;
    }

    setBusyLabel("Opening the world...");
    setErrorMessage("");

    try {
      const provider = await buildProviderConfig(selectedProvider);
      await ensureProviderReady(provider);

      const baseGame = createInitialGameState({
        playerName: playerName.trim() || "Traveler",
        theme: startingCondition,
        startingCondition,
        selectedProvider: provider.kind,
        selectedModelId: provider.modelId,
        selectedEndpoint: provider.endpoint,
        classId: selectedClassId,
      });

      const seededGame: GameState = {
        ...baseGame,
        story: [
          createStoryBeat("system", `Campaign seed: ${startingCondition}`),
          createStoryBeat("system", `Starting class: ${baseGame.player.className}`),
          createStoryBeat(
            "system",
            `Runtime provider: ${formatProviderLabel({ selectedProvider: provider.kind, selectedModelId: provider.modelId, selectedEndpoint: provider.endpoint })}`,
          ),
        ],
      };

      const opening = await runDungeonMasterTurn(
        seededGame,
        "Begin the adventure. Establish the opening scene, the immediate tension, the first fair opportunity, the campaign UI theme, the current action rails, any necessary ruleset changes for the setting, and any enemies, NPCs, or optional party prospects that should already be active.",
        provider,
      );

      const nextGame: GameState = maintainGameContext({
        ...opening.nextState,
        story: [
          ...opening.nextState.story,
          createStoryBeat("dm", opening.reply, {
            toolEvents: opening.toolEvents,
            imageUrl: opening.imageUrl,
          }),
        ],
      });

      setGame(nextGame);
      setSelectedNpcId(nextGame.npcs[0]?.id);
      setCloudSaveId(undefined);
      setCloudSyncLabel(accountUser ? "Cloud sync queued." : "");
      setActiveTab("surroundings");
      setActionInput("");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to start the adventure.");
      setEngineStatus({ phase: "error", text: "Provider initialization failed." });
    } finally {
      setBusyLabel("");
    }
  }

  async function resolveStoryAction(rawAction: string) {
    if (!game || !rawAction.trim()) {
      return;
    }

    const playerAction = rawAction.trim();
    if (isDirectorCommand(playerAction)) {
      await resolveDirectorCommand(playerAction);
      return;
    }

    const baseGame = game;
    setActionInput("");
    setBusyLabel("The director is choosing the approach...");
    setErrorMessage("");

    try {
      const provider = await buildProviderConfig(baseGame.selectedProvider);
      await ensureProviderReady(provider);
      const approach = await chooseActionApproach(baseGame, playerAction, provider);
      const check = createActionCheck(baseGame, approach);
      const actionPacket = buildActionPacket(playerAction, check, baseGame);
      const withPlayerBeat: GameState = maintainGameContext({
        ...baseGame,
        story: [...baseGame.story, createStoryBeat("player", playerAction, { check })],
      });

      setGame(withPlayerBeat);
      setBusyLabel("The dungeon master is resolving the simulation...");
      const result = await runDungeonMasterTurn(withPlayerBeat, actionPacket, provider);
      const nextGame: GameState = maintainGameContext({
        ...result.nextState,
        story: [
          ...result.nextState.story,
          createStoryBeat("dm", result.reply, {
            toolEvents: result.toolEvents,
            imageUrl: result.imageUrl,
          }),
        ],
      });
      setGame(nextGame);
      setActiveTab("journal");
      if (!selectedNpcId && nextGame.npcs[0]) {
        setSelectedNpcId(nextGame.npcs[0].id);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "The turn failed.");
      setGame(baseGame);
    } finally {
      setBusyLabel("");
    }
  }

  async function resolveDirectorCommand(rawCommand: string) {
    if (!game || !rawCommand.trim()) {
      return;
    }

    const command = normalizeDirectorCommand(rawCommand) || rawCommand.trim();
    if (!command) {
      return;
    }

    const baseGame = game;
    const commandPacket = buildDirectorPacket(command, baseGame);
    const stagedGame: GameState = maintainGameContext({
      ...baseGame,
      story: [
        ...baseGame.story,
        createStoryBeat("system", `Director command: ${command}`),
      ],
    });

    setGame(stagedGame);
    setActionInput("");
    setDirectorInput("");
    setBusyLabel("The director is retrieving context and calling tools...");
    setErrorMessage("");

    try {
      const provider = await buildProviderConfig(stagedGame.selectedProvider);
      await ensureProviderReady(provider);
      const result = await runDungeonMasterTurn(stagedGame, commandPacket, provider);
      const nextGame: GameState = maintainGameContext({
        ...result.nextState,
        story: [
          ...result.nextState.story,
          createStoryBeat("dm", result.reply, {
            toolEvents: result.toolEvents,
            imageUrl: result.imageUrl,
          }),
        ],
      });
      setGame(nextGame);
      setActiveTab("journal");
      if (!selectedNpcId && nextGame.npcs[0]) {
        setSelectedNpcId(nextGame.npcs[0].id);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "The director command failed.");
      setGame(baseGame);
    } finally {
      setBusyLabel("");
    }
  }

  async function handleStoryAction() {
    await resolveStoryAction(actionInput);
  }

  async function handleDirectorAction() {
    await resolveDirectorCommand(directorInput);
  }

  async function handleNpcSend() {
    if (!game || !selectedNpcId || !npcInput.trim()) {
      return;
    }

    const playerLine = npcInput.trim();
    const updatedChat = [
      ...(game.npcChats[selectedNpcId] ?? []),
      createNpcMessage("player", playerLine),
    ];

    const stagedGame: GameState = {
      ...game,
      npcChats: {
        ...game.npcChats,
        [selectedNpcId]: updatedChat,
      },
    };

    setGame(stagedGame);
    setNpcInput("");
    setBusyLabel("The NPC is answering...");
    setErrorMessage("");

    try {
      const provider = await buildProviderConfig(stagedGame.selectedProvider);
      await ensureProviderReady(provider);
      const reply = await runNpcTurn(stagedGame, selectedNpcId, playerLine, provider);
      const nextGame: GameState = maintainGameContext({
        ...stagedGame,
        npcChats: {
          ...stagedGame.npcChats,
          [selectedNpcId]: [...updatedChat, createNpcMessage("npc", reply)],
        },
      });
      setGame(nextGame);
      setActiveTab("party");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "The NPC did not respond.");
      setGame(game);
    } finally {
      setBusyLabel("");
    }
  }

  function handleReset() {
    localStorage.removeItem(STORAGE_KEY);
    setGame(null);
    setSelectedNpcId(undefined);
    setCloudSaveId(undefined);
    setCloudSyncLabel("");
    setActiveTab("surroundings");
    setActionInput("");
    setSelectedCombatantId("player");
    setShowSettings(false);
    setFocusMode(false);
    setNpcInput("");
    setDirectorInput("");
    setBusyLabel("");
    setErrorMessage("");
    setEngineStatus({
      phase: "idle",
      text: "Choose OpenRouter, browser WebLLM, or a local Ollama/vLLM endpoint before starting.",
    });
  }

  async function handleToggleMusic() {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    setMusicError("");
    if (musicPlaying) {
      audio.pause();
      setMusicPlaying(false);
      return;
    }

    try {
      await audio.play();
      setMusicPlaying(true);
    } catch {
      setMusicPlaying(false);
      setMusicError("Music playback needs a browser gesture. Try play again.");
    }
  }

  function handleTrackEnded() {
    setMusicTrackIndex((current) => (current + 1) % MUSIC_TRACKS.length);
    setMusicPlaying(true);
  }

  async function handleSwitchRuntime() {
    if (!game) {
      return;
    }

    setBusyLabel("Switching runtime...");
    setErrorMessage("");
    try {
      const provider = await buildProviderConfig(selectedProvider);
      await ensureProviderReady(provider);
      const nextGame = maintainGameContext({
        ...game,
        selectedProvider: provider.kind,
        selectedModelId: provider.modelId,
        selectedEndpoint: provider.endpoint,
        story: [
          ...game.story,
          createStoryBeat(
            "system",
            `Runtime switched to ${formatProviderLabel({ selectedProvider: provider.kind, selectedModelId: provider.modelId, selectedEndpoint: provider.endpoint })}.`,
          ),
        ],
      });
      setGame(nextGame);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to switch runtime.");
      setEngineStatus({ phase: "error", text: "Runtime switch failed." });
    } finally {
      setBusyLabel("");
    }
  }

  function handleStartCombatGrid() {
    if (!game) {
      return;
    }
    const combat = createCombatFromGame(game);
    setGame(maintainGameContext({ ...game, combat }));
    setSelectedCombatantId("player");
    setActiveTab("combat");
  }

  function handleEndCombatGrid() {
    if (!game) {
      return;
    }
    setGame(
      maintainGameContext({
        ...game,
        combat: {
          ...game.combat,
          active: false,
          log: ["Combat closed by the player.", ...game.combat.log].slice(0, 16),
          updatedAt: Date.now(),
        },
      }),
    );
  }

  function handleCombatCellClick(x: number, y: number) {
    if (!game || !game.combat.active) {
      return;
    }
    setGame(
      maintainGameContext({
        ...game,
        combat: moveCombatant(game.combat, selectedCombatantId || "player", x, y),
      }),
    );
  }

  function updateArtSettings(patch: Partial<GameState["artSettings"]>) {
    if (!game) {
      return;
    }
    setGame(
      maintainGameContext({
        ...game,
        artSettings: {
          ...game.artSettings,
          ...patch,
          selectedWorkflowByFocus: {
            ...game.artSettings.selectedWorkflowByFocus,
            ...(patch.selectedWorkflowByFocus ?? {}),
          },
          workflows: patch.workflows ?? game.artSettings.workflows,
        },
      }),
    );
  }

  function handleAddWorkflow() {
    if (!game || !workflowJson.trim()) {
      setErrorMessage("Paste a ComfyUI workflow JSON before adding it.");
      return;
    }

    try {
      JSON.parse(workflowJson);
    } catch {
      setErrorMessage("The ComfyUI workflow is not valid JSON.");
      return;
    }

    const workflow: ArtWorkflowConfig = {
      id: `workflow_${crypto.randomUUID()}`,
      name: workflowName.trim() || `${workflowFocus} workflow`,
      focus: workflowFocus,
      workflowJson,
      promptNodeId: workflowPromptNodeId.trim() || undefined,
      promptInputName: workflowPromptInputName.trim() || "text",
      enabled: true,
    };
    updateArtSettings({
      workflows: [workflow, ...game.artSettings.workflows],
      selectedWorkflowByFocus: {
        ...game.artSettings.selectedWorkflowByFocus,
        [workflowFocus]: workflow.id,
      },
    });
    setWorkflowJson("");
    setWorkflowName("Comfy workflow");
    setWorkflowPromptNodeId("");
    setWorkflowPromptInputName("text");
    setErrorMessage("");
  }

  function handleSelectWorkflow(focus: ArtFocus, workflowId: string) {
    if (!game) {
      return;
    }
    updateArtSettings({
      selectedWorkflowByFocus: {
        ...game.artSettings.selectedWorkflowByFocus,
        [focus]: workflowId,
      },
    });
  }

  const activeNpc = game?.npcs.find((npc) => npc.id === selectedNpcId) ?? game?.npcs[0];
  const activeNpcChat = activeNpc ? game?.npcChats[activeNpc.id] ?? [] : [];
  const activeTheme = game?.campaignTheme ?? inferCampaignTheme(customTheme.trim() || randomSeed);
  const activeMusicTrack = MUSIC_TRACKS[musicTrackIndex] ?? MUSIC_TRACKS[0];
  const usingCustomTheme = customTheme.trim().length > 0;
  const selectedClass = DND_CLASSES.find((entry) => entry.id === selectedClassId) ?? DND_CLASSES[0];
  const startDisabled = Boolean(busyLabel) || (
    selectedProvider === "webllm"
      ? webllmCatalogStatus === "loading" || !selectedModelId
      : selectedProvider === "local"
        ? !selectedLocalEndpoint.trim() || !selectedLocalModel.trim()
        : !openRouterKeyStored || !selectedOpenRouterModel.trim()
  );
  const latestSceneArt =
    game?.artGallery.slice().reverse().find((art) => art.focus === "scene")?.url ??
    game?.latestArtUrl;
  const activeQuest = game?.quests.find((quest) => quest.status === "active");
  const recentCheck = game?.story.slice().reverse().find((beat) => beat.check)?.check;
  const gameTabs: Array<{ id: GameTab; label: string }> = [
    { id: "journal", label: "Journal" },
    { id: "surroundings", label: "Scene" },
    { id: "combat", label: "Combat" },
    { id: "party", label: "Party" },
    { id: "inventory", label: "Inventory" },
    { id: "player", label: "Character" },
    { id: "quests", label: "Quests" },
  ];

  return (
    <div className={`app-shell arena-shell terminal-shell theme-${game ? activeTheme.id : terminalTheme} ${game ? "in-game-shell" : "home-terminal-shell"} ${focusMode ? "focus-mode" : ""}`}>
      <audio
        ref={audioRef}
        src={activeMusicTrack}
        preload="metadata"
        onEnded={handleTrackEnded}
        onError={() => setMusicError("Music file could not be loaded.")}
      />
      {!game ? (
        <div className="home-rgb-grid" aria-hidden="true">
          <span className="rgb-line rgb-line-red" />
          <span className="rgb-line rgb-line-green" />
          <span className="rgb-line rgb-line-blue" />
        </div>
      ) : null}
      <main className="app-frame">
        <header className={`hero-panel arena-hero ${game ? "" : "terminal-hero"}`}>
          <div>
            {!game ? (
              <>
                <p className="eyebrow terminal-eyebrow">Infinite Adventure Director</p>
                <p className="terminal-prompt">C:\&gt; boot infinite_game.exe --interactive</p>
                <h1 className="terminal-title">The Infinite Game</h1>
                <p className="hero-copy terminal-copy">
                  A live dungeon master, durable world state, tactical scenes, and an endless campaign loop.
                </p>
              </>
            ) : (
              <>
                <p className="eyebrow terminal-eyebrow">Live Campaign</p>
                <h1 className="compact-title">{game.environment.location}</h1>
                <div className="terminal-meta-row">
                  <span className="terminal-box">TURN {game.turnCount}</span>
                  <span className="terminal-box">HP {game.player.resources.health}/{game.player.resources.maxHealth}</span>
                  <span className="terminal-box">{game.sceneControls.clockName} {game.sceneControls.clockValue}/{game.sceneControls.clockMax}</span>
                </div>
              </>
            )}
            {!game ? (
              <div className="terminal-meta-row">
                <span className="terminal-box">STATUS: READY</span>
                <span className="terminal-box">THEME: {activeTheme.label}</span>
                <span className="terminal-box">INPUT: LIVE</span>
              </div>
            ) : null}
          </div>
          <div className="status-stack arena-status-stack">
            {!game || showSettings ? <div className={`status-pill status-${engineStatus.phase}`}>{engineStatus.text}</div> : null}
            {isMobile ? (
              <div className="status-pill status-busy">
                Mobile device detected. OpenRouter is recommended for smoother play.
              </div>
            ) : null}
            {busyLabel ? <div className="status-pill status-busy">{busyLabel}</div> : null}
            {authBusyLabel ? <div className="status-pill status-busy">{authBusyLabel}</div> : null}
            {authMessage ? <div className="status-pill status-ready">{authMessage}</div> : null}
            {cloudSyncLabel ? <div className="status-pill status-ready">{cloudSyncLabel}</div> : null}
            {cloudError ? <div className="status-pill status-error">{cloudError}</div> : null}
            {errorMessage ? <div className="status-pill status-error">{errorMessage}</div> : null}
            {musicError ? <div className="status-pill status-error">{musicError}</div> : null}
            {game ? (
              <div className="top-actions">
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => {
                    setFocusMode((current) => !current);
                    setShowSettings(false);
                  }}
                >
                  {focusMode ? "Exit Focus" : "Focus"}
                </button>
                {!focusMode ? (
                  <button type="button" className="ghost-button" onClick={() => setShowSettings((current) => !current)}>
                    {showSettings ? "Close Settings" : "Settings"}
                  </button>
                ) : null}
              </div>
            ) : null}
            <div className="music-strip">
              <div className="music-controls">
                <button
                  type="button"
                  className="ghost-button icon-button"
                  onClick={() => void handleToggleMusic()}
                  title="Toggle background music"
                >
                  {musicPlaying ? "Audio On" : "Audio"}
                </button>
                <button
                  type="button"
                  className="ghost-button icon-button"
                  onClick={() => setMusicMuted((current) => !current)}
                  title="Mute music"
                >
                  {musicMuted ? "Muted" : "Mute"}
                </button>
              </div>
              <input
                className="music-volume"
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={musicMuted ? 0 : musicVolume}
                onChange={(event) => {
                  setMusicVolume(Number(event.target.value));
                  setMusicMuted(false);
                }}
                aria-label="Music volume"
              />
            </div>
          </div>
        </header>

        {!game ? (
          <section className="setup-grid setup-grid-wide terminal-setup-grid">
            <article className="panel spotlight-panel">
              <div className="panel-header">
                <p className="eyebrow">1. Theme Seed</p>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => setRandomSeed(pickRandomStartingCondition())}
                >
                  Reroll Seed
                </button>
              </div>
              <p className="spotlight-copy">{usingCustomTheme ? customTheme.trim() : randomSeed}</p>
              <p className="subtle-copy">
                Random mode draws from {STARTING_CONDITIONS.length} opening conditions. A custom theme overrides the seed while the DM keeps one structured simulation layer behind the story.
              </p>
              <div className="terminal-divider" aria-hidden="true" />
              <label className="field-label" htmlFor="custom-theme">
                Custom theme or opening condition
              </label>
              <textarea
                id="custom-theme"
                className="text-area"
                placeholder="Example: A city of ghost-operated elevators becomes the front line in a hidden war between saints and logistics AIs."
                value={customTheme}
                onChange={(event) => setCustomTheme(event.target.value)}
              />
            </article>

            <article className="panel form-panel">
              <div className="panel-header">
                <p className="eyebrow">2. Runtime + Player</p>
              </div>
              <div className="terminal-divider" aria-hidden="true" />

              <label className="field-label">Runtime provider</label>
              <div className="provider-toggle">
                <button
                  type="button"
                  className={`provider-button ${selectedProvider === "webllm" ? "provider-button-active" : ""}`}
                  onClick={() => setSelectedProvider("webllm")}
                >
                  Local WebLLM
                </button>
                <button
                  type="button"
                  className={`provider-button ${selectedProvider === "openrouter" ? "provider-button-active" : ""}`}
                  onClick={() => setSelectedProvider("openrouter")}
                >
                  OpenRouter
                </button>
                <button
                  type="button"
                  className={`provider-button ${selectedProvider === "local" ? "provider-button-active" : ""}`}
                  onClick={() => setSelectedProvider("local")}
                >
                  Ollama / vLLM
                </button>
              </div>

              {selectedProvider === "webllm" ? (
                <>
                  <label className="field-label" htmlFor="model-id">
                    WebLLM model
                  </label>
                  {webllmCatalogStatus === "ready" ? (
                    <select
                      id="model-id"
                      className="text-input"
                      value={selectedModelId}
                      onChange={(event) => setSelectedModelId(event.target.value)}
                    >
                      {toolCallingModels.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <div className="mini-card status-card">
                      <strong>
                        {webllmCatalogStatus === "loading"
                          ? "Loading local model catalog..."
                          : "WebLLM stays unloaded until you choose local play."}
                      </strong>
                      <p>
                        {webllmCatalogStatus === "error"
                          ? "The local model catalog failed to load. Switch providers or try again by selecting Local WebLLM once more."
                          : "The browser only fetches the WebLLM model registry after you opt into the local provider."}
                      </p>
                    </div>
                  )}
                  <p className="subtle-copy">
                    Local mode keeps the model in-browser and now defers the WebLLM bundle until you explicitly choose this provider.
                  </p>
                </>
              ) : selectedProvider === "local" ? (
                <>
                  <label className="field-label" htmlFor="local-endpoint">
                    Local endpoint
                  </label>
                  <input
                    id="local-endpoint"
                    className="text-input"
                    value={selectedLocalEndpoint}
                    onChange={(event) => setSelectedLocalEndpoint(event.target.value)}
                    placeholder="http://127.0.0.1:11434/v1"
                  />
                  <label className="field-label" htmlFor="local-model">
                    Local model
                  </label>
                  <input
                    id="local-model"
                    className="text-input"
                    value={selectedLocalModel}
                    onChange={(event) => setSelectedLocalModel(event.target.value)}
                    placeholder="llama3.1"
                  />
                  <label className="field-label" htmlFor="local-api-key">
                    API key
                  </label>
                  <input
                    id="local-api-key"
                    className="text-input"
                    type="password"
                    value={selectedLocalApiKey}
                    onChange={(event) => setSelectedLocalApiKey(event.target.value)}
                    placeholder="optional for vLLM gateways"
                  />
                </>
              ) : (
                <>
                  <label className="field-label" htmlFor="openrouter-model">
                    OpenRouter model
                  </label>
                  <input
                    id="openrouter-model"
                    className="text-input"
                    list="openrouter-models"
                    value={selectedOpenRouterModel}
                    onChange={(event) => setSelectedOpenRouterModel(event.target.value)}
                    placeholder="openai/gpt-4o-mini"
                  />
                  <datalist id="openrouter-models">
                    {OPENROUTER_MODELS.map((model) => (
                      <option key={model} value={model} />
                    ))}
                  </datalist>
                  <label className="field-label" htmlFor="openrouter-key">
                    OpenRouter API key
                  </label>
                  <input
                    id="openrouter-key"
                    className="text-input"
                    type="password"
                    value={openRouterKeyInput}
                    onChange={(event) => setOpenRouterKeyInput(event.target.value)}
                    placeholder={openRouterKeyStored ? "Encrypted key stored on this device" : "sk-or-v1-..."}
                  />
                  <div className="provider-actions">
                    <button type="button" className="ghost-button" onClick={handleStoreOpenRouterKey}>
                      Save Encrypted Key
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={handleClearOpenRouterKey}
                      disabled={!openRouterKeyStored}
                    >
                      Clear Stored Key
                    </button>
                  </div>
                  <p className="subtle-copy">
                    The key is encrypted at rest in the browser using Web Crypto plus IndexedDB-backed key material. For stronger production security, a server-side Vercel env key is still preferable.
                  </p>
                </>
              )}

              <label className="field-label" htmlFor="player-name">
                Player name
              </label>
              <input
                id="player-name"
                className="text-input"
                value={playerName}
                onChange={(event) => setPlayerName(event.target.value)}
                maxLength={40}
              />

              <label className="field-label" htmlFor="class-id">
                Starting class
              </label>
              <select
                id="class-id"
                className="text-input"
                value={selectedClassId}
                onChange={(event) => setSelectedClassId(event.target.value)}
              >
                {DND_CLASSES.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>

              {selectedClass ? (
                <div className="class-card">
                  <strong>{selectedClass.name}</strong>
                  <p>{selectedClass.role}</p>
                  <div className="tag-row">
                    {selectedClass.primaryAbilities.map((ability) => (
                      <span key={ability} className="meta-chip">
                        {ability}
                      </span>
                    ))}
                    <span className="meta-chip">d{selectedClass.hitDie}</span>
                    <span className="meta-chip">{selectedClass.spellcasting}</span>
                  </div>
                </div>
              ) : null}

              <button
                type="button"
                className="primary-button"
                onClick={handleStartAdventure}
                disabled={startDisabled}
              >
                Start Adventure
              </button>
              <div className="seed-list">
                {STARTING_CONDITIONS.slice(0, 8).map((seed) => (
                  <button
                    key={seed}
                    type="button"
                    className={`seed-chip ${seed === randomSeed ? "seed-chip-active" : ""}`}
                    onClick={() => setRandomSeed(seed)}
                  >
                    {seed}
                  </button>
                ))}
              </div>
            </article>

            <article className="panel form-panel">
              <div className="panel-header">
                <p className="eyebrow">3. Account + History</p>
                {supabaseEnabled && accountUser ? (
                  <button type="button" className="ghost-button" onClick={() => void refreshCloudHistory()}>
                    Refresh History
                  </button>
                ) : null}
              </div>
              <div className="terminal-divider" aria-hidden="true" />

              {!supabaseEnabled ? (
                <div className="mini-card status-card">
                  <strong>Cloud auth is disabled in this deployment.</strong>
                  <p>
                    Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to enable verified email sign-up, Google OAuth, and shared campaign history.
                  </p>
                </div>
              ) : accountUser ? (
                <div className="account-shell">
                  <div className="mini-card status-card">
                    <strong>{accountUser.displayName}</strong>
                    <p>{accountUser.email}</p>
                    <div className="tag-row compact-tags">
                      <span className="meta-chip">{accountUser.provider}</span>
                      <span className="meta-chip">
                        {accountUser.emailVerified ? "email verified" : "verification pending"}
                      </span>
                    </div>
                    <button type="button" className="ghost-button" onClick={handleSignOut}>
                      Sign Out
                    </button>
                  </div>

                  <div className="history-list">
                    {cloudHistoryBusy ? <p className="subtle-copy">Loading cloud history...</p> : null}
                    {!cloudHistoryBusy && cloudHistory.length === 0 ? (
                      <div className="mini-card status-card">
                        <strong>No cloud campaigns yet.</strong>
                        <p>Start or resume a campaign and it will sync automatically to this account.</p>
                      </div>
                    ) : null}
                    {cloudHistory.map((save) => (
                      <article key={save.id} className="mini-card history-card">
                        <div className="mini-card-header">
                          <strong>{save.title}</strong>
                          <span className="meta-chip">{formatCalendarTimestamp(save.updatedAt)}</span>
                        </div>
                        <p>
                          {save.game.environment.location} - {save.game.selectedProvider === "local" ? "Local" : save.game.selectedProvider === "openrouter" ? "OpenRouter" : "WebLLM"} - Turn {save.game.turnCount}
                        </p>
                        <div className="button-row">
                          <button type="button" className="ghost-button" onClick={() => void handleLoadCloudSave(save)}>
                            Load
                          </button>
                          <button type="button" className="ghost-button" onClick={() => void handleDeleteCloudSave(save.id)}>
                            Delete
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="account-shell">
                  <div className="provider-toggle auth-toggle">
                    <button
                      type="button"
                      className={`provider-button ${authMode === "signup" ? "provider-button-active" : ""}`}
                      onClick={() => setAuthMode("signup")}
                    >
                      Create Account
                    </button>
                    <button
                      type="button"
                      className={`provider-button ${authMode === "signin" ? "provider-button-active" : ""}`}
                      onClick={() => setAuthMode("signin")}
                    >
                      Sign In
                    </button>
                  </div>
                  <label className="field-label" htmlFor="auth-email">
                    Email
                  </label>
                  <input
                    id="auth-email"
                    className="text-input"
                    type="email"
                    value={authEmail}
                    onChange={(event) => setAuthEmail(event.target.value)}
                    placeholder="you@example.com"
                  />
                  <label className="field-label" htmlFor="auth-password">
                    Password
                  </label>
                  <input
                    id="auth-password"
                    className="text-input"
                    type="password"
                    value={authPassword}
                    onChange={(event) => setAuthPassword(event.target.value)}
                    placeholder="Use a strong password"
                  />
                  <button type="button" className="primary-button" onClick={handleAuthSubmit}>
                    {authMode === "signup" ? "Create Verified Account" : "Sign In"}
                  </button>
                  <button type="button" className="ghost-button" onClick={handleGoogleLogin}>
                    Continue With Google
                  </button>
                  <p className="subtle-copy">
                    Email sign-up sends a verification link through Supabase Auth. Google OAuth uses the same account system and unlocks synced campaign history.
                  </p>
                </div>
              )}
            </article>
          </section>
        ) : (
          <section className="arena-layout">
            <section className="arena-main-column">
              <div className="panel story-header-panel arena-header-panel">
                <div>
                  <p className="eyebrow">Campaign Frame</p>
                  <h2>{game.theme}</h2>
                  <p className="subtle-copy">
                    {game.player.className} - {activeTheme.label} - Turn {game.turnCount}
                  </p>
                </div>
                <button type="button" className="ghost-button" onClick={handleReset}>
                  Reset Campaign
                </button>
              </div>

              <div className="panel arena-live-hud">
                <section className="hud-scene">
                  <div className={`hud-scene-visual ${game.artSettings.autoGenerate && latestSceneArt ? "" : "hud-scene-empty"}`}>
                    {game.artSettings.autoGenerate && latestSceneArt ? (
                      <img src={latestSceneArt} alt={`Generated scene for ${game.environment.location}`} />
                    ) : (
                      <span>{game.environment.location}</span>
                    )}
                  </div>
                  <div className="hud-scene-copy">
                    <div className="mini-card-header">
                      <strong>{game.environment.location}</strong>
                      <span className="meta-chip">{game.environment.timeOfDay}</span>
                    </div>
                    <p>{game.environment.sceneSummary}</p>
                    <div className="tag-row compact-tags">
                      <span className="meta-chip">{game.environment.atmosphere}</span>
                      <span className="meta-chip">{game.environment.weather}</span>
                      {game.environment.hazards.slice(0, 2).map((hazard) => (
                        <span key={hazard} className="meta-chip">
                          {hazard}
                        </span>
                      ))}
                    </div>
                  </div>
                </section>

                <section className="hud-status">
                  <div className="hud-vitals-grid">
                    <div className="hud-vital">
                      <span>HP</span>
                      <strong>{game.player.resources.health}/{game.player.resources.maxHealth}</strong>
                      <div className="meter-track">
                        <span style={{ width: formatResourceMeter(game.player.resources.health, game.player.resources.maxHealth) }} />
                      </div>
                    </div>
                    <div className="hud-vital">
                      <span>Mana</span>
                      <strong>{game.player.resources.mana}/{game.player.resources.maxMana}</strong>
                      <div className="meter-track">
                        <span style={{ width: formatResourceMeter(game.player.resources.mana, game.player.resources.maxMana) }} />
                      </div>
                    </div>
                    <div className="hud-vital">
                      <span>Stamina</span>
                      <strong>{game.player.resources.stamina}/{game.player.resources.maxStamina}</strong>
                      <div className="meter-track">
                        <span style={{ width: formatResourceMeter(game.player.resources.stamina, game.player.resources.maxStamina) }} />
                      </div>
                    </div>
                    <div className="hud-vital">
                      <span>Clock</span>
                      <strong>{game.sceneControls.clockValue}/{game.sceneControls.clockMax}</strong>
                      <small>{game.sceneControls.clockName}</small>
                    </div>
                    <div className="hud-vital">
                      <span>Armor</span>
                      <strong>{game.player.resources.armorClass}</strong>
                      <small>Lv {game.player.level} {game.player.className}</small>
                    </div>
                    <div className="hud-vital">
                      <span>Last Roll</span>
                      <strong>{recentCheck ? `${recentCheck.total}` : "--"}</strong>
                      <small>{recentCheck ? `${recentCheck.approachLabel ?? recentCheck.ability} ${recentCheck.risk}` : "pending"}</small>
                    </div>
                  </div>
                  <div className="hud-stakes">
                    <strong>{game.sceneControls.stakes}</strong>
                    <p>{activeQuest ? activeQuest.title : game.environment.pressureClock}</p>
                  </div>
                </section>

                <section className="hud-rosters">
                  <div className="hud-roster-block">
                    <div className="mini-card-header">
                      <strong>Party</strong>
                      <span className="meta-chip">{game.party.length + 1}</span>
                    </div>
                    <div className="hud-token-row">
                      <article className="hud-token hud-token-player">
                        <span className="hud-token-icon hud-token-initials">
                          {game.playerName.slice(0, 2).toUpperCase()}
                        </span>
                        <div>
                          <strong>{game.playerName}</strong>
                          <small>{game.player.className}</small>
                        </div>
                      </article>
                      {game.party.length === 0 ? (
                        <span className="hud-empty">No allies</span>
                      ) : (
                        game.party.slice(0, 5).map((member) => (
                          <article key={member.id} className="hud-token hud-token-party">
                            {game.artSettings.autoGenerate ? (
                              <img src={member.avatarUrl} alt={member.name} className="hud-token-icon" />
                            ) : (
                              <span className="hud-token-icon hud-token-initials">
                                {member.name.slice(0, 2).toUpperCase()}
                              </span>
                            )}
                            <div>
                              <strong>{member.name}</strong>
                              <small>HP {member.resources.health}/{member.resources.maxHealth}</small>
                            </div>
                          </article>
                        ))
                      )}
                    </div>
                  </div>

                  <div className="hud-roster-block">
                    <div className="mini-card-header">
                      <strong>Enemies</strong>
                      <span className="meta-chip">{game.enemies.length}</span>
                    </div>
                    <div className="hud-token-row">
                      {game.enemies.length === 0 ? (
                        <span className="hud-empty">No active enemies</span>
                      ) : (
                        game.enemies.slice(0, 5).map((enemy) => (
                          <article key={enemy.id} className="hud-token hud-token-enemy">
                            {game.artSettings.autoGenerate ? (
                              <img src={enemy.artUrl} alt={enemy.name} className="hud-token-icon" />
                            ) : (
                              <span className="hud-token-icon hud-token-initials">
                                {enemy.name.slice(0, 2).toUpperCase()}
                              </span>
                            )}
                            <div>
                              <strong>{enemy.name}</strong>
                              <small>HP {enemy.stats.health}/{enemy.stats.maxHealth} THR {enemy.stats.threat}</small>
                            </div>
                          </article>
                        ))
                      )}
                    </div>
                  </div>
                </section>
              </div>

              <div className="panel arena-tab-bar">
                {gameTabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    className={`arena-tab-button ${activeTab === tab.id ? "arena-tab-button-active" : ""}`}
                    onClick={() => setActiveTab(tab.id)}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <div className="panel arena-view-panel">
                {activeTab === "journal" ? (
                  <>
                    <div className="panel-header">
                      <p className="eyebrow">Journal Log</p>
                      <span className="meta-chip">{game.story.length} entries</span>
                    </div>
                    <div className="story-feed arena-scroll-region">
                      {game.story.map((beat) => (
                        <article key={beat.id} className={`story-card story-${beat.speaker}`}>
                          <div className="story-meta">
                            <span>
                              {beat.speaker === "dm"
                                ? "Dungeon Master"
                                : beat.speaker === "player"
                                  ? game.playerName
                                  : "System"}
                            </span>
                            <span>{formatStoryTimestamp(beat.createdAt)}</span>
                          </div>
                          <p>{beat.content}</p>
                          {beat.check ? (
                            <div className="tool-event-row">
                              <span className="tool-event-chip">
                                {beat.check.approachLabel ?? beat.check.ability} / {beat.check.risk}: {beat.check.total} vs {beat.check.difficulty}
                              </span>
                              <span className="tool-event-chip">
                                d20 {beat.check.roll} {beat.check.modifier >= 0 ? "+" : ""}{beat.check.modifier}
                              </span>
                              <span className="tool-event-chip">{beat.check.outcomeBand}</span>
                            </div>
                          ) : null}
                          {game.artSettings.autoGenerate && beat.imageUrl ? (
                            <img className="story-image" src={beat.imageUrl} alt="Generated scene art" />
                          ) : null}
                          {beat.toolEvents.length > 0 ? (
                            <div className="tool-event-row">
                              {beat.toolEvents.map((toolEvent) => (
                                <span key={toolEvent.id} className="tool-event-chip">
                                  {toolEvent.summary}
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </article>
                      ))}
                    </div>
                  </>
                ) : null}

                {activeTab === "surroundings" ? (
                  <>
                    <div className="panel-header">
                      <p className="eyebrow">Surroundings</p>
                      <span className="meta-chip">{game.environment.timeOfDay}</span>
                    </div>
                    {game.artSettings.autoGenerate && latestSceneArt ? (
                      <div className="arena-scene-frame">
                        <img
                          className="hero-art arena-scene-image"
                          src={latestSceneArt}
                          alt={`Surroundings near ${game.environment.location}`}
                        />
                      </div>
                    ) : null}
                    <div className="arena-surroundings-grid">
                      <article className="mini-card arena-panel-card">
                        <div className="mini-card-header">
                          <strong>{game.environment.location}</strong>
                          <span className="meta-chip">{game.environment.biome}</span>
                        </div>
                        <p>{game.environment.sceneSummary}</p>
                        <div className="tag-row compact-tags">
                          <span className="meta-chip">Weather: {game.environment.weather}</span>
                          <span className="meta-chip">Pressure: {game.environment.pressureClock}</span>
                          <span className="meta-chip">Mood: {game.environment.atmosphere}</span>
                        </div>
                      </article>
                      <article className="mini-card arena-panel-card">
                        <strong>Hazards and exits</strong>
                        <div className="tag-row compact-tags">
                          {(game.environment.hazards.length > 0
                            ? game.environment.hazards
                            : ["no active hazards"]
                          ).map((hazard) => (
                            <span key={hazard} className="meta-chip">
                              {hazard}
                            </span>
                          ))}
                        </div>
                        <div className="tag-row compact-tags">
                          {(game.environment.exits.length > 0
                            ? game.environment.exits
                            : ["no obvious exits"]
                          ).map((exit) => (
                            <span key={exit} className="meta-chip">
                              {exit}
                            </span>
                          ))}
                        </div>
                        <div className="tag-row compact-tags">
                          {(game.environment.factions.length > 0
                            ? game.environment.factions
                            : ["no known factions"]
                          ).map((faction) => (
                            <span key={faction} className="meta-chip">
                              {faction}
                            </span>
                          ))}
                        </div>
                      </article>
                    </div>
                  </>
                ) : null}

                {activeTab === "combat" ? (
                  <>
                    <div className="panel-header">
                      <p className="eyebrow">Combat Grid</p>
                      <span className="meta-chip">
                        {game.combat.active ? `Round ${game.combat.round}` : `${game.enemies.length} foes`}
                      </span>
                    </div>
                    <div className="button-row">
                      <button type="button" className="ghost-button" onClick={handleStartCombatGrid}>
                        {game.combat.active ? "Regenerate Terrain" : "Open Grid"}
                      </button>
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={handleEndCombatGrid}
                        disabled={!game.combat.active}
                      >
                        End Combat
                      </button>
                    </div>
                    {game.combat.active ? (
                      <>
                        <div className="combat-toolbar">
                          <label className="field-label" htmlFor="combatant-select">
                            Move
                          </label>
                          <select
                            id="combatant-select"
                            className="text-input"
                            value={selectedCombatantId}
                            onChange={(event) => setSelectedCombatantId(event.target.value)}
                          >
                            {game.combat.combatants.map((combatant) => (
                              <option key={combatant.id} value={combatant.id}>
                                {combatant.name}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div
                          className="combat-grid"
                          style={{ gridTemplateColumns: `repeat(${game.combat.width}, minmax(42px, 1fr))` }}
                        >
                          {game.combat.cells.map((cell) => {
                            const occupants = game.combat.combatants.filter(
                              (combatant) => combatant.x === cell.x && combatant.y === cell.y,
                            );
                            return (
                              <button
                                key={`${cell.x}-${cell.y}`}
                                type="button"
                                className={`combat-cell terrain-${cell.terrain}`}
                                onClick={() => handleCombatCellClick(cell.x, cell.y)}
                                title={`${cell.terrain}${cell.hazard ? `: ${cell.hazard}` : ""}`}
                              >
                                <span className="combat-coordinate">{String.fromCharCode(65 + cell.x)}{cell.y + 1}</span>
                                <span className="combat-terrain">{cell.label ?? cell.terrain}</span>
                                <span className="combatants-stack">
                                  {occupants.map((combatant) => (
                                    <span key={combatant.id} className={`combat-token token-${combatant.kind}`}>
                                      {combatant.name.slice(0, 2).toUpperCase()}
                                    </span>
                                  ))}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                        <div className="arena-actors-grid">
                          <section className="stack-list">
                            {game.combat.combatants.map((combatant) => (
                              <article key={combatant.id} className="mini-card arena-panel-card">
                                <div className="mini-card-header">
                                  <strong>{combatant.name}</strong>
                                  <span className="meta-chip">{combatant.kind}</span>
                                </div>
                                <div className="tag-row compact-tags">
                                  <span className="meta-chip">
                                    {String.fromCharCode(65 + combatant.x)}{combatant.y + 1}
                                  </span>
                                  {combatant.hp !== undefined ? (
                                    <span className="meta-chip">HP {combatant.hp}/{combatant.maxHp}</span>
                                  ) : null}
                                  {combatant.conditions.map((condition) => (
                                    <span key={condition} className="meta-chip">
                                      {condition}
                                    </span>
                                  ))}
                                </div>
                              </article>
                            ))}
                          </section>
                          <section className="stack-list">
                            {game.enemies.length === 0 ? (
                              <div className="art-placeholder arena-placeholder">No active enemies.</div>
                            ) : (
                              game.enemies.map((enemy) => (
                                <article key={enemy.id} className={`enemy-card arena-panel-card ${game.artSettings.autoGenerate ? "" : "no-art-card"}`}>
                                  {game.artSettings.autoGenerate ? (
                                    <img src={enemy.artUrl} alt={enemy.name} className="enemy-avatar" />
                                  ) : null}
                                  <div>
                                    <div className="mini-card-header">
                                      <strong>{enemy.name}</strong>
                                      <span className="meta-chip">Lv {enemy.level}</span>
                                    </div>
                                    <p>{enemy.archetype} - {enemy.disposition}</p>
                                    <div className="tag-row compact-tags">
                                      <span className="meta-chip">HP {enemy.stats.health}/{enemy.stats.maxHealth}</span>
                                      <span className="meta-chip">AC {enemy.stats.armorClass}</span>
                                      <span className="meta-chip">THR {enemy.stats.threat}</span>
                                    </div>
                                  </div>
                                </article>
                              ))
                            )}
                          </section>
                        </div>
                      </>
                    ) : (
                      <div className="art-placeholder arena-placeholder">
                        Open the grid when distance, terrain, or enemy movement matters.
                      </div>
                    )}
                  </>
                ) : null}

                {activeTab === "inventory" ? (
                  <>
                    <div className="panel-header">
                      <p className="eyebrow">Inventory</p>
                      <span className="meta-chip">{game.inventory.length} items</span>
                    </div>
                    <div className="stack-list arena-scroll-region">
                      {game.inventory.length === 0 ? (
                        <div className="art-placeholder arena-placeholder">Your pack is empty.</div>
                      ) : (
                        game.inventory.map((item) => (
                          <article key={item.id} className={`inventory-card arena-panel-card ${game.artSettings.autoGenerate ? "" : "no-art-card"}`}>
                            {game.artSettings.autoGenerate ? (
                              <img src={item.iconUrl} alt={item.name} className="inventory-icon" />
                            ) : null}
                            <div>
                              <div className="mini-card-header">
                                <strong>{item.name}</strong>
                                <span className={`rarity-badge rarity-${item.rarity}`}>{item.rarity}</span>
                              </div>
                              <p>{item.description}</p>
                              <div className="tag-row compact-tags">
                                <span className="meta-chip">Qty {item.quantity}</span>
                                <span className="meta-chip">Slot {item.slot}</span>
                                <span className="meta-chip">Weight {item.weight}</span>
                                <span className="meta-chip">Value {item.value}</span>
                                {item.tags.map((tag) => (
                                  <span key={tag} className="meta-chip">
                                    {tag}
                                  </span>
                                ))}
                              </div>
                            </div>
                          </article>
                        ))
                      )}
                    </div>
                  </>
                ) : null}

                {activeTab === "party" ? (
                  <>
                    <div className="panel-header">
                      <p className="eyebrow">Party and Contacts</p>
                      <span className="meta-chip">
                        {game.party.length} allies - {game.npcs.length} contacts
                      </span>
                    </div>
                    <div className="arena-actors-grid">
                      <section className="arena-actor-column">
                        <div className="panel-header">
                          <strong>AI Party</strong>
                          <span className="meta-chip">{game.party.length}</span>
                        </div>
                        <div className="stack-list arena-scroll-region">
                          {game.party.length === 0 ? (
                            <div className="art-placeholder arena-placeholder">
                              No AI companions yet.
                            </div>
                          ) : (
                            game.party.map((member) => (
                              <article key={member.id} className={`enemy-card arena-panel-card ${game.artSettings.autoGenerate ? "" : "no-art-card"}`}>
                                {game.artSettings.autoGenerate ? (
                                  <img src={member.avatarUrl} alt={member.name} className="enemy-avatar" />
                                ) : null}
                                <div>
                                  <div className="mini-card-header">
                                    <strong>{member.name}</strong>
                                    <span className="meta-chip">Lv {member.level}</span>
                                  </div>
                                  <p>{member.role} - {member.personality}</p>
                                  <div className="tag-row compact-tags">
                                    <span className="meta-chip">HP {member.resources.health}/{member.resources.maxHealth}</span>
                                    <span className="meta-chip">Loyalty {member.loyalty}</span>
                                    <span className="meta-chip">{member.automated ? "auto" : "manual"}</span>
                                  </div>
                                </div>
                              </article>
                            ))
                          )}
                        </div>
                      </section>

                      <section className="arena-actor-column">
                        <div className="panel-header">
                          <strong>Contacts</strong>
                          <span className="meta-chip">{game.npcs.length}</span>
                        </div>
                        <div className="npc-roster">
                          {game.npcs.length === 0 ? (
                            <p className="subtle-copy">No known contacts yet.</p>
                          ) : (
                            game.npcs.map((npc) => (
                              <button
                                key={npc.id}
                                type="button"
                                className={`npc-chip ${activeNpc?.id === npc.id ? "npc-chip-active" : ""}`}
                                onClick={() => setSelectedNpcId(npc.id)}
                              >
                                {npc.name}
                              </button>
                            ))
                          )}
                        </div>
                        {activeNpc ? (
                          <div className="npc-chat-shell arena-panel-card">
                            <div className={`npc-profile ${game.artSettings.autoGenerate ? "" : "no-art-card"}`}>
                              {game.artSettings.autoGenerate ? (
                                <img src={activeNpc.avatarUrl} alt={activeNpc.name} className="npc-avatar" />
                              ) : null}
                              <div>
                                <strong>{activeNpc.name}</strong>
                                <p>{activeNpc.archetype}</p>
                                <p>{activeNpc.personality}</p>
                              </div>
                            </div>
                            <div className="npc-chat-feed">
                              {activeNpcChat.map((message) => (
                                <article key={message.id} className={`npc-message npc-${message.role}`}>
                                  <strong>{message.role === "npc" ? activeNpc.name : game.playerName}</strong>
                                  <p>{message.content}</p>
                                </article>
                              ))}
                            </div>
                            <textarea
                              className="text-area compact-area"
                              placeholder={`Ask ${activeNpc.name} anything.`}
                              value={npcInput}
                              onChange={(event) => setNpcInput(event.target.value)}
                              disabled={Boolean(busyLabel)}
                            />
                            <button
                              type="button"
                              className="primary-button"
                              onClick={handleNpcSend}
                              disabled={Boolean(busyLabel) || !npcInput.trim()}
                            >
                              Send Message
                            </button>
                          </div>
                        ) : (
                          <div className="art-placeholder arena-placeholder">
                            When the DM introduces someone important, their dedicated chat appears here.
                          </div>
                        )}
                      </section>
                    </div>
                  </>
                ) : null}

                {activeTab === "player" ? (
                  <>
                    <div className="panel-header">
                      <p className="eyebrow">Character Sheet</p>
                      <span className="meta-chip">{game.player.className}</span>
                    </div>
                    <div className="arena-character-grid">
                      <article className="mini-card arena-panel-card">
                        <strong>{game.playerName}</strong>
                        <p>{game.player.background || game.player.className}</p>
                        <div className="stat-grid">
                          <div>
                            <span>Health</span>
                            <strong>
                              {game.player.resources.health}/{game.player.resources.maxHealth}
                            </strong>
                          </div>
                          <div>
                            <span>Mana</span>
                            <strong>
                              {game.player.resources.mana}/{game.player.resources.maxMana}
                            </strong>
                          </div>
                          <div>
                            <span>Stamina</span>
                            <strong>
                              {game.player.resources.stamina}/{game.player.resources.maxStamina}
                            </strong>
                          </div>
                          <div>
                            <span>Armor</span>
                            <strong>{game.player.resources.armorClass}</strong>
                          </div>
                          <div>
                            <span>Gold</span>
                            <strong>{game.player.resources.gold}</strong>
                          </div>
                          <div>
                            <span>Level</span>
                            <strong>{game.player.level}</strong>
                          </div>
                        </div>
                        <div className="ability-grid">
                          {Object.entries(game.player.abilityScores).map(([ability, value]) => (
                            <div key={ability}>
                              <span>{ability.slice(0, 3).toUpperCase()}</span>
                              <strong>{value}</strong>
                            </div>
                          ))}
                        </div>
                      </article>
                      <article className="mini-card arena-panel-card">
                        <div className="mini-card-header">
                          <strong>Spells and techniques</strong>
                          <span className="meta-chip">{game.player.spells.length}</span>
                        </div>
                        <div className="stack-list arena-scroll-region">
                          {game.player.spells.length === 0 ? (
                            <p className="subtle-copy">No active spells or techniques yet.</p>
                          ) : (
                            game.player.spells.map((spell) => (
                              <article key={spell.id} className="mini-card arena-sub-card">
                                <div className="mini-card-header">
                                  <strong>{spell.name}</strong>
                                  <span className="meta-chip">Lv {spell.level}</span>
                                </div>
                                <p>{spell.description}</p>
                                <div className="tag-row compact-tags">
                                  <span className="meta-chip">{spell.school}</span>
                                  <span className="meta-chip">Cost {spell.resourceCost}</span>
                                  <span className="meta-chip">{spell.range}</span>
                                </div>
                              </article>
                            ))
                          )}
                        </div>
                      </article>
                    </div>
                  </>
                ) : null}

                {activeTab === "quests" ? (
                  <>
                    <div className="panel-header">
                      <p className="eyebrow">Quests and Rules</p>
                      <span className="meta-chip">{game.quests.length} quests</span>
                    </div>
                    <div className="arena-quests-grid">
                      <section className="stack-list arena-scroll-region">
                        {game.quests.length === 0 ? (
                          <div className="art-placeholder arena-placeholder">
                            The DM has not assigned a quest yet.
                          </div>
                        ) : (
                          game.quests.map((quest) => (
                            <article key={quest.id} className="mini-card arena-panel-card">
                              <div className="mini-card-header">
                                <strong>{quest.title}</strong>
                                <span className={`quest-badge quest-${quest.status}`}>{quest.status}</span>
                              </div>
                              <p>{quest.summary}</p>
                              <ul className="plain-list">
                                {quest.steps.map((step) => (
                                  <li key={step}>{step}</li>
                                ))}
                              </ul>
                            </article>
                          ))
                        )}
                      </section>
                      <section className="stack-list arena-scroll-region">
                        <article className="mini-card arena-panel-card rules-card">
                          <strong>{game.ruleset.rulesSummary}</strong>
                          <p>{game.ruleset.combatStyle}</p>
                          <div className="tag-row compact-tags">
                            <span className="meta-chip">Magic: {game.ruleset.magicRules}</span>
                            <span className="meta-chip">Rests: {game.ruleset.restStyle}</span>
                            <span className="meta-chip">Social: {game.ruleset.socialRules}</span>
                          </div>
                        </article>
                        {game.memoryLedger.slice(0, 8).map((memory) => (
                          <article key={memory.id} className="mini-card arena-panel-card">
                            <div className="mini-card-header">
                              <strong>{memory.title}</strong>
                              <span className="meta-chip">{memory.category}</span>
                            </div>
                            <p>{memory.text}</p>
                          </article>
                        ))}
                      </section>
                    </div>
                  </>
                ) : null}
              </div>

              <div className="panel composer-panel arena-command-panel">
                <div className="scene-rails">
                  <div>
                    <span className="meta-chip">{game.sceneControls.clockName} {game.sceneControls.clockValue}/{game.sceneControls.clockMax}</span>
                    <p className="subtle-copy">{game.sceneControls.stakes}</p>
                  </div>
                  <div className="tag-row compact-tags">
                    {game.sceneControls.availableMoves.map((move) => (
                      <span
                        key={move}
                        className="seed-chip rail-chip"
                      >
                        {move}
                      </span>
                    ))}
                  </div>
                </div>
                <label className="field-label" htmlFor="story-action">
                  Command Line
                </label>
                <textarea
                  id="story-action"
                  className="text-area"
                  placeholder="I slip behind the altar and listen for the engine under the floor. /director: run a faction turn."
                  value={actionInput}
                  onChange={(event) => setActionInput(event.target.value)}
                  disabled={Boolean(busyLabel)}
                />
                <button
                  type="button"
                  className="primary-button"
                  onClick={handleStoryAction}
                  disabled={Boolean(busyLabel) || !actionInput.trim()}
                >
                  Send Action
                </button>
              </div>
            </section>

            <aside className="arena-side-column">
              {showSettings ? (
                <>
                  <div className="panel runtime-panel arena-side-panel settings-panel">
                <div className="panel-header">
                  <p className="eyebrow">Runtime</p>
                  <span className="meta-chip">{formatProviderLabel(game)}</span>
                </div>
                <div className="provider-toggle">
                  <button
                    type="button"
                    className={`provider-button ${selectedProvider === "openrouter" ? "provider-button-active" : ""}`}
                    onClick={() => setSelectedProvider("openrouter")}
                  >
                    OpenRouter
                  </button>
                  <button
                    type="button"
                    className={`provider-button ${selectedProvider === "webllm" ? "provider-button-active" : ""}`}
                    onClick={() => setSelectedProvider("webllm")}
                  >
                    WebLLM
                  </button>
                  <button
                    type="button"
                    className={`provider-button ${selectedProvider === "local" ? "provider-button-active" : ""}`}
                    onClick={() => setSelectedProvider("local")}
                  >
                    Ollama / vLLM
                  </button>
                </div>
                {selectedProvider === "openrouter" ? (
                  <>
                    <label className="field-label" htmlFor="runtime-openrouter-model">
                      OpenRouter model
                    </label>
                    <input
                      id="runtime-openrouter-model"
                      className="text-input"
                      value={selectedOpenRouterModel}
                      onChange={(event) => setSelectedOpenRouterModel(event.target.value)}
                      list="openrouter-models"
                    />
                    <datalist id="openrouter-models">
                      {OPENROUTER_MODELS.map((model) => (
                        <option key={model} value={model} />
                      ))}
                    </datalist>
                    <label className="field-label" htmlFor="runtime-openrouter-key">
                      API key
                    </label>
                    <input
                      id="runtime-openrouter-key"
                      className="text-input"
                      type="password"
                      value={openRouterKeyInput}
                      onChange={(event) => setOpenRouterKeyInput(event.target.value)}
                      placeholder={openRouterKeyStored ? "Encrypted key stored" : "sk-or-v1-..."}
                    />
                    <div className="provider-actions">
                      <button type="button" className="ghost-button" onClick={handleStoreOpenRouterKey}>
                        Save Key
                      </button>
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={handleClearOpenRouterKey}
                        disabled={!openRouterKeyStored}
                      >
                        Clear
                      </button>
                    </div>
                  </>
                ) : selectedProvider === "local" ? (
                  <>
                    <label className="field-label" htmlFor="runtime-local-endpoint">
                      Local endpoint
                    </label>
                    <input
                      id="runtime-local-endpoint"
                      className="text-input"
                      value={selectedLocalEndpoint}
                      onChange={(event) => setSelectedLocalEndpoint(event.target.value)}
                      placeholder="http://127.0.0.1:11434/v1"
                    />
                    <label className="field-label" htmlFor="runtime-local-model">
                      Local model
                    </label>
                    <input
                      id="runtime-local-model"
                      className="text-input"
                      value={selectedLocalModel}
                      onChange={(event) => setSelectedLocalModel(event.target.value)}
                      placeholder="llama3.1"
                    />
                    <label className="field-label" htmlFor="runtime-local-api-key">
                      API key
                    </label>
                    <input
                      id="runtime-local-api-key"
                      className="text-input"
                      type="password"
                      value={selectedLocalApiKey}
                      onChange={(event) => setSelectedLocalApiKey(event.target.value)}
                      placeholder="optional"
                    />
                  </>
                ) : webllmCatalogStatus === "ready" ? (
                  <>
                    <label className="field-label" htmlFor="runtime-webllm-model">
                      WebLLM model
                    </label>
                    <select
                      id="runtime-webllm-model"
                      className="text-input"
                      value={selectedModelId}
                      onChange={(event) => setSelectedModelId(event.target.value)}
                    >
                      {toolCallingModels.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.label}
                        </option>
                      ))}
                    </select>
                  </>
                ) : (
                  <button type="button" className="ghost-button" onClick={() => void loadWebllmCatalog()}>
                    Load WebLLM Models
                  </button>
                )}
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => void handleSwitchRuntime()}
                  disabled={Boolean(busyLabel)}
                >
                  Apply Runtime
                </button>
                  </div>

              <div className="panel arena-side-panel">
                <div className="panel-header">
                  <p className="eyebrow">Director Console</p>
                  <span className="meta-chip">Tool path</span>
                </div>
                <textarea
                  className="text-area compact-area"
                  placeholder="Run a faction turn, recap the stakes, resolve downtime, surface a fair treasure, or generate the next scene image."
                  value={directorInput}
                  onChange={(event) => setDirectorInput(event.target.value)}
                  disabled={Boolean(busyLabel)}
                />
                <button
                  type="button"
                  className="primary-button"
                  onClick={handleDirectorAction}
                  disabled={Boolean(busyLabel) || !directorInput.trim()}
                >
                  Run Director Command
                </button>
              </div>

              <div className="panel arena-side-panel">
                <div className="panel-header">
                  <p className="eyebrow">Art Engine</p>
                  <span className="meta-chip">{game.artSettings.provider}</span>
                </div>
                <label className="field-label" htmlFor="art-provider">
                  Provider
                </label>
                <select
                  id="art-provider"
                  className="text-input"
                  value={game.artSettings.provider}
                  onChange={(event) => updateArtSettings({ provider: event.target.value as ArtProviderKind })}
                >
                  <option value="pollinations">Pollinations</option>
                  <option value="comfy">ComfyUI</option>
                </select>
                {game.artSettings.provider === "comfy" ? (
                  <>
                    <label className="field-label" htmlFor="comfy-url">
                      ComfyUI URL
                    </label>
                    <input
                      id="comfy-url"
                      className="text-input"
                      value={game.artSettings.comfyServerUrl}
                      onChange={(event) => updateArtSettings({ comfyServerUrl: event.target.value })}
                    />
                    <label className="field-label" htmlFor="workflow-name">
                      Add Workflow
                    </label>
                    <input
                      id="workflow-name"
                      className="text-input"
                      value={workflowName}
                      onChange={(event) => setWorkflowName(event.target.value)}
                    />
                    <div className="action-controls">
                      <select
                        className="text-input"
                        value={workflowFocus}
                        onChange={(event) => setWorkflowFocus(event.target.value as ArtFocus)}
                      >
                        {ART_FOCI.map((focus) => (
                          <option key={focus} value={focus}>
                            {focus}
                          </option>
                        ))}
                      </select>
                      <input
                        className="text-input"
                        value={workflowPromptNodeId}
                        onChange={(event) => setWorkflowPromptNodeId(event.target.value)}
                        placeholder="prompt node id"
                      />
                    </div>
                    <input
                      className="text-input"
                      value={workflowPromptInputName}
                      onChange={(event) => setWorkflowPromptInputName(event.target.value)}
                      placeholder="prompt input name"
                    />
                    <textarea
                      className="text-area compact-area"
                      value={workflowJson}
                      onChange={(event) => setWorkflowJson(event.target.value)}
                      placeholder="Paste ComfyUI workflow JSON"
                    />
                    <button type="button" className="ghost-button" onClick={handleAddWorkflow}>
                      Save Workflow
                    </button>
                    <div className="stack-list compact-stack">
                      {ART_FOCI.map((focus) => (
                        <label key={focus} className="field-label workflow-select-row">
                          {focus}
                          <select
                            className="text-input"
                            value={game.artSettings.selectedWorkflowByFocus[focus] ?? ""}
                            onChange={(event) => handleSelectWorkflow(focus, event.target.value)}
                          >
                            <option value="">Auto</option>
                            {game.artSettings.workflows
                              .filter((workflow) => workflow.focus === focus || workflow.focus === "all")
                              .map((workflow) => (
                                <option key={workflow.id} value={workflow.id}>
                                  {workflow.name}
                                </option>
                              ))}
                          </select>
                        </label>
                      ))}
                    </div>
                  </>
                ) : (
                  <>
                    <label className="field-label" htmlFor="pollinations-url">
                      Image API base
                    </label>
                    <input
                      id="pollinations-url"
                      className="text-input"
                      value={game.artSettings.pollinationsBaseUrl}
                      onChange={(event) => updateArtSettings({ pollinationsBaseUrl: event.target.value })}
                    />
                  </>
                )}
                <label className="toggle-row">
                  <input
                    type="checkbox"
                    checked={game.artSettings.autoGenerate}
                    onChange={(event) => updateArtSettings({ autoGenerate: event.target.checked })}
                  />
                  Auto-generate new art
                </label>
              </div>

              <div className="panel arena-side-panel">
                <div className="panel-header">
                  <p className="eyebrow">Context</p>
                  <span className="meta-chip">{game.archivedStoryCount} archived</span>
                </div>
                <div className="action-controls">
                  <label className="field-label" htmlFor="story-limit">
                    Story
                  </label>
                  <input
                    id="story-limit"
                    className="text-input"
                    type="number"
                    min={8}
                    max={80}
                    value={game.contextSettings.storyLimit}
                    onChange={(event) =>
                      setGame(maintainGameContext({
                        ...game,
                        contextSettings: {
                          ...game.contextSettings,
                          storyLimit: Number(event.target.value),
                        },
                      }))
                    }
                  />
                  <label className="field-label" htmlFor="chat-limit">
                    Chats
                  </label>
                  <input
                    id="chat-limit"
                    className="text-input"
                    type="number"
                    min={4}
                    max={60}
                    value={game.contextSettings.npcChatLimit}
                    onChange={(event) =>
                      setGame(maintainGameContext({
                        ...game,
                        contextSettings: {
                          ...game.contextSettings,
                          npcChatLimit: Number(event.target.value),
                        },
                      }))
                    }
                  />
                </div>
              </div>

              <div className="panel arena-side-panel">
                <div className="panel-header">
                  <p className="eyebrow">Cloud History</p>
                  <span className="meta-chip">{accountUser ? cloudHistory.length : 0}</span>
                </div>
                {!supabaseEnabled ? (
                  <p className="subtle-copy">
                    Cloud auth is not configured in this deployment. Add Supabase env vars to enable verified accounts and synced history.
                  </p>
                ) : accountUser ? (
                  <>
                    <p className="subtle-copy">
                      {accountUser.emailVerified
                        ? `Signed in as ${accountUser.email}.`
                        : `Signed in as ${accountUser.email}. Email verification is still pending.`}
                    </p>
                    <div className="stack-list compact-stack">
                      {cloudHistory.slice(0, 4).map((save) => (
                        <article key={save.id} className="mini-card history-card">
                          <div className="mini-card-header">
                            <strong>{save.title}</strong>
                            <span className="meta-chip">{formatCalendarTimestamp(save.updatedAt)}</span>
                          </div>
                          <div className="button-row">
                            <button type="button" className="ghost-button" onClick={() => void handleLoadCloudSave(save)}>
                              Load
                            </button>
                            <button type="button" className="ghost-button" onClick={() => void handleDeleteCloudSave(save.id)}>
                              Delete
                            </button>
                          </div>
                        </article>
                      ))}
                    </div>
                  </>
                ) : (
                  <p className="subtle-copy">
                    Sign in from the setup screen to sync this campaign, restore it on another device, and use verified email or Google OAuth.
                  </p>
                )}
              </div>

                </>
              ) : (
                <>
              <div className="panel arena-side-panel compact-hud">
                <div className="panel-header">
                  <p className="eyebrow">Condition</p>
                  <span className="meta-chip">Turn {game.turnCount}</span>
                </div>
                <div className="meter-list">
                  <div>
                    <div className="meter-row">
                      <span>Health</span>
                      <strong>
                        {game.player.resources.health}/{game.player.resources.maxHealth}
                      </strong>
                    </div>
                    <div className="meter-track">
                      <span style={{ width: formatResourceMeter(game.player.resources.health, game.player.resources.maxHealth) }} />
                    </div>
                  </div>
                  <div>
                    <div className="meter-row">
                      <span>Mana</span>
                      <strong>
                        {game.player.resources.mana}/{game.player.resources.maxMana}
                      </strong>
                    </div>
                    <div className="meter-track">
                      <span style={{ width: formatResourceMeter(game.player.resources.mana, game.player.resources.maxMana) }} />
                    </div>
                  </div>
                  <div>
                    <div className="meter-row">
                      <span>Stamina</span>
                      <strong>
                        {game.player.resources.stamina}/{game.player.resources.maxStamina}
                      </strong>
                    </div>
                    <div className="meter-track">
                      <span style={{ width: formatResourceMeter(game.player.resources.stamina, game.player.resources.maxStamina) }} />
                    </div>
                  </div>
                </div>
              </div>

                  <div className="panel arena-side-panel compact-hud">
                <div className="panel-header">
                  <p className="eyebrow">Location</p>
                  <span className="meta-chip">{game.environment.timeOfDay}</span>
                </div>
                <strong>{game.environment.location}</strong>
                <div className="tag-row compact-tags">
                  {game.environment.hazards.slice(0, 3).map((hazard) => (
                    <span key={hazard} className="meta-chip">
                      {hazard}
                    </span>
                  ))}
                  {game.environment.factions.slice(0, 3).map((faction) => (
                    <span key={faction} className="meta-chip">
                      {faction}
                    </span>
                  ))}
                </div>
              </div>

                  <div className="panel arena-side-panel compact-hud">
                <div className="panel-header">
                  <p className="eyebrow">Quick Sheet</p>
                  <span className="meta-chip">{game.player.className}</span>
                </div>
                <div className="stat-grid">
                  <div>
                    <span>Luck</span>
                    <strong>{game.player.resources.luck}</strong>
                  </div>
                  <div>
                    <span>Renown</span>
                    <strong>{game.player.resources.renown}</strong>
                  </div>
                  <div>
                    <span>Armor</span>
                    <strong>{game.player.resources.armorClass}</strong>
                  </div>
                  <div>
                    <span>Gold</span>
                    <strong>{game.player.resources.gold}</strong>
                  </div>
                  <div>
                    <span>Level</span>
                    <strong>{game.player.level}</strong>
                  </div>
                  <div>
                    <span>XP</span>
                    <strong>{game.player.xp}</strong>
                  </div>
                </div>
              </div>

                  {game.artSettings.autoGenerate && game.artGallery.length > 0 ? (
                    <div className="panel arena-side-panel compact-hud">
                      <div className="panel-header">
                        <p className="eyebrow">Recent Art</p>
                        <span className="meta-chip">{game.artGallery.length}</span>
                      </div>
                      <div className="art-strip arena-art-strip">
                        {game.artGallery.slice(0, 6).map((art) => (
                          <img key={art.id} src={art.url} alt={art.prompt} className="art-thumb" />
                        ))}
                      </div>
                    </div>
                  ) : null}
                </>
              )}
            </aside>
          </section>
        )}
      </main>
    </div>
  );
}

export default App;
