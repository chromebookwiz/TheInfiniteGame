import { useCallback, useEffect, useState } from "react";
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
  createInitialGameState,
  ensureEngine,
  runDungeonMasterTurn,
  runNpcTurn,
} from "./lib/gameAgent";
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

type GameTab = "journal" | "surroundings" | "inventory" | "npcs" | "player" | "quests";
type AuthMode = "signin" | "signup";
type AsyncStatus = "idle" | "loading" | "ready" | "error";

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

function buildCampaignTitle(game: GameState): string {
  const trimmedTheme = game.theme.trim();
  const headline = trimmedTheme.length > 52 ? `${trimmedTheme.slice(0, 52)}...` : trimmedTheme;
  return `${game.playerName} · ${headline} · Turn ${game.turnCount}`;
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
  const [selectedClassId, setSelectedClassId] = useState(DND_CLASSES[0]?.id ?? "fighter");
  const [openRouterKeyInput, setOpenRouterKeyInput] = useState("");
  const [openRouterKeyStored, setOpenRouterKeyStored] = useState(false);
  const [game, setGame] = useState<GameState | null>(null);
  const [selectedNpcId, setSelectedNpcId] = useState<string | undefined>(undefined);
  const [activeTab, setActiveTab] = useState<GameTab>("surroundings");
  const [actionInput, setActionInput] = useState("");
  const [npcInput, setNpcInput] = useState("");
  const [busyLabel, setBusyLabel] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [engineStatus, setEngineStatus] = useState<EngineStatus>({
    phase: "idle",
    text: "Choose local WebLLM or OpenRouter before starting.",
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

      setGame(parsed.game);
      setSelectedNpcId(parsed.selectedNpcId);
      setSelectedProvider(parsed.game.selectedProvider ?? "openrouter");
      setSelectedModelId(parsed.game.selectedProvider === "webllm" ? parsed.game.selectedModelId : "");
      setSelectedOpenRouterModel(
        parsed.game.selectedProvider === "openrouter"
          ? parsed.game.selectedModelId
          : DEFAULT_OPENROUTER_MODEL,
      );
      setSelectedClassId(parsed.game.player.classId);
      setEngineStatus({
        phase: "idle",
        text: `Saved campaign found for ${parsed.game.playerName}. Resume with ${parsed.game.selectedProvider === "openrouter" ? `OpenRouter / ${parsed.game.selectedModelId}` : `WebLLM / ${parsed.game.selectedModelId}`}.`,
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
      setSelectedProvider("webllm");
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
    setGame(save.game);
    setSelectedNpcId(save.selectedNpcId);
    setSelectedProvider(save.game.selectedProvider);
    setSelectedClassId(save.game.player.classId);
    setSelectedModelId(save.game.selectedProvider === "webllm" ? save.game.selectedModelId : "");
    setSelectedOpenRouterModel(
      save.game.selectedProvider === "openrouter"
        ? save.game.selectedModelId
        : DEFAULT_OPENROUTER_MODEL,
    );
    setCloudSaveId(save.id);
    setActiveTab("surroundings");
    setEngineStatus({
      phase: "idle",
      text: `Loaded cloud campaign: ${save.title}`,
    });
    if (save.game.selectedProvider === "webllm") {
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
        classId: selectedClassId,
      });

      const seededGame: GameState = {
        ...baseGame,
        story: [
          createStoryBeat("system", `Campaign seed: ${startingCondition}`),
          createStoryBeat("system", `Starting class: ${baseGame.player.className}`),
          createStoryBeat(
            "system",
            `Runtime provider: ${provider.kind === "openrouter" ? `OpenRouter / ${provider.modelId}` : `WebLLM / ${provider.modelId}`}`,
          ),
        ],
      };

      const opening = await runDungeonMasterTurn(
        seededGame,
        "Begin the adventure. Establish the opening scene, the immediate tension, the first opportunity, any necessary ruleset changes for the setting, and any enemies or NPCs that should already be active.",
        provider,
      );

      const nextGame: GameState = {
        ...opening.nextState,
        story: [
          ...opening.nextState.story,
          createStoryBeat("dm", opening.reply, {
            toolEvents: opening.toolEvents,
            imageUrl: opening.imageUrl,
          }),
        ],
      };

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

  async function handleStoryAction() {
    if (!game || !actionInput.trim()) {
      return;
    }

    const playerAction = actionInput.trim();
    const withPlayerBeat: GameState = {
      ...game,
      story: [...game.story, createStoryBeat("player", playerAction)],
    };

    setGame(withPlayerBeat);
    setActionInput("");
    setBusyLabel("The dungeon master is resolving the simulation...");
    setErrorMessage("");

    try {
      const provider = await buildProviderConfig(withPlayerBeat.selectedProvider);
      await ensureProviderReady(provider);
      const result = await runDungeonMasterTurn(withPlayerBeat, playerAction, provider);
      const nextGame: GameState = {
        ...result.nextState,
        story: [
          ...result.nextState.story,
          createStoryBeat("dm", result.reply, {
            toolEvents: result.toolEvents,
            imageUrl: result.imageUrl,
          }),
        ],
      };
      setGame(nextGame);
      setActiveTab("journal");
      if (!selectedNpcId && nextGame.npcs[0]) {
        setSelectedNpcId(nextGame.npcs[0].id);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "The turn failed.");
      setGame(game);
    } finally {
      setBusyLabel("");
    }
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
      const nextGame: GameState = {
        ...stagedGame,
        npcChats: {
          ...stagedGame.npcChats,
          [selectedNpcId]: [...updatedChat, createNpcMessage("npc", reply)],
        },
      };
      setGame(nextGame);
      setActiveTab("npcs");
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
    setNpcInput("");
    setBusyLabel("");
    setErrorMessage("");
    setEngineStatus({
      phase: "idle",
      text: "Choose local WebLLM or OpenRouter before starting.",
    });
  }

  const activeNpc = game?.npcs.find((npc) => npc.id === selectedNpcId) ?? game?.npcs[0];
  const activeNpcChat = activeNpc ? game?.npcChats[activeNpc.id] ?? [] : [];
  const usingCustomTheme = customTheme.trim().length > 0;
  const selectedClass = DND_CLASSES.find((entry) => entry.id === selectedClassId) ?? DND_CLASSES[0];
  const startDisabled = Boolean(busyLabel) || (selectedProvider === "webllm"
    ? webllmCatalogStatus === "loading" || !selectedModelId
    : !openRouterKeyStored || !selectedOpenRouterModel.trim());
  const latestSceneArt =
    game?.artGallery.slice().reverse().find((art) => art.focus === "scene")?.url ??
    game?.latestArtUrl;
  const gameTabs: Array<{ id: GameTab; label: string }> = [
    { id: "journal", label: "Journal" },
    { id: "surroundings", label: "Surroundings" },
    { id: "inventory", label: "Inventory" },
    { id: "npcs", label: "NPCs + Enemies" },
    { id: "player", label: "Character" },
    { id: "quests", label: "Quests + Rules" },
  ];

  return (
    <div className={`app-shell arena-shell ${game ? "in-game-shell" : "home-terminal-shell"}`}>
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
            <p className="eyebrow terminal-eyebrow">Infinite Adventure Director</p>
            {!game ? <p className="terminal-prompt">C:\&gt; boot infinite_game.exe --interactive</p> : null}
            <h1 className={!game ? "terminal-title" : undefined}>The Infinite Game</h1>
            <p className={`hero-copy ${!game ? "terminal-copy" : ""}`}>
              An old-RPG command deck for an endless campaign. Explore through a live dungeon master, track your pack and known actors, and keep the current surroundings in view like a classic first-person CRPG.
            </p>
            {!game ? (
              <div className="terminal-meta-row">
                <span className="terminal-box">STATUS: READY</span>
                <span className="terminal-box">THEME: MONO CRT</span>
                <span className="terminal-box">INPUT: LIVE</span>
              </div>
            ) : null}
          </div>
          <div className="status-stack arena-status-stack">
            <div className={`status-pill status-${engineStatus.phase}`}>{engineStatus.text}</div>
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
                          {save.game.environment.location} · {save.game.selectedProvider === "openrouter" ? "OpenRouter" : "WebLLM"} · Turn {save.game.turnCount}
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
                    {game.environment.location} · {game.environment.atmosphere} · {game.player.className} · {game.selectedProvider === "openrouter" ? `OpenRouter ${game.selectedModelId}` : `WebLLM ${game.selectedModelId}`} · Turn {game.turnCount}
                  </p>
                </div>
                <button type="button" className="ghost-button" onClick={handleReset}>
                  Reset Campaign
                </button>
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
                          {beat.imageUrl ? (
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
                    <div className="arena-scene-frame">
                      {latestSceneArt ? (
                        <img
                          className="hero-art arena-scene-image"
                          src={latestSceneArt}
                          alt={`Surroundings near ${game.environment.location}`}
                        />
                      ) : (
                        <div className="art-placeholder arena-placeholder">
                          The dungeon master has not painted the current surroundings yet.
                        </div>
                      )}
                    </div>
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
                          <article key={item.id} className="inventory-card arena-panel-card">
                            <img src={item.iconUrl} alt={item.name} className="inventory-icon" />
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

                {activeTab === "npcs" ? (
                  <>
                    <div className="panel-header">
                      <p className="eyebrow">NPCs and Enemies</p>
                      <span className="meta-chip">
                        {game.npcs.length} contacts · {game.enemies.length} foes
                      </span>
                    </div>
                    <div className="arena-actors-grid">
                      <section className="arena-actor-column">
                        <div className="panel-header">
                          <strong>Known NPCs</strong>
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
                            <div className="npc-profile">
                              <img src={activeNpc.avatarUrl} alt={activeNpc.name} className="npc-avatar" />
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

                      <section className="arena-actor-column">
                        <div className="panel-header">
                          <strong>Active Enemies</strong>
                          <span className="meta-chip">{game.enemies.length}</span>
                        </div>
                        <div className="stack-list arena-scroll-region">
                          {game.enemies.length === 0 ? (
                            <div className="art-placeholder arena-placeholder">No active enemies.</div>
                          ) : (
                            game.enemies.map((enemy) => (
                              <article key={enemy.id} className="enemy-card arena-panel-card">
                                <img src={enemy.artUrl} alt={enemy.name} className="enemy-avatar" />
                                <div>
                                  <div className="mini-card-header">
                                    <strong>{enemy.name}</strong>
                                    <span className="meta-chip">Lv {enemy.level}</span>
                                  </div>
                                  <p>
                                    {enemy.archetype} · {enemy.disposition}
                                  </p>
                                  <div className="tag-row compact-tags">
                                    <span className="meta-chip">
                                      HP {enemy.stats.health}/{enemy.stats.maxHealth}
                                    </span>
                                    <span className="meta-chip">AC {enemy.stats.armorClass}</span>
                                    <span className="meta-chip">ATK {enemy.stats.attack}</span>
                                    <span className="meta-chip">MAG {enemy.stats.magic}</span>
                                    <span className="meta-chip">THR {enemy.stats.threat}</span>
                                    {enemy.tags.map((tag) => (
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
                <label className="field-label" htmlFor="story-action">
                  What do you do?
                </label>
                <textarea
                  id="story-action"
                  className="text-area"
                  placeholder="Negotiate, investigate, cast, retreat, loot, hack, improvise."
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
              <div className="panel runtime-panel arena-side-panel">
                <div className="panel-header">
                  <p className="eyebrow">Runtime</p>
                  <span className="meta-chip">{game.selectedProvider}</span>
                </div>
                <p className="subtle-copy">{game.selectedModelId}</p>
                {game.selectedProvider === "openrouter" ? (
                  <p className="subtle-copy">
                    OpenRouter mode is active. The user key remains encrypted at rest on this device and is decrypted only for requests.
                  </p>
                ) : (
                  <p className="subtle-copy">
                    WebLLM mode is active. Local inference depends on WebGPU support and available device memory.
                  </p>
                )}
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

              <div className="panel arena-side-panel">
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

              <div className="panel arena-side-panel">
                <div className="panel-header">
                  <p className="eyebrow">Location</p>
                  <span className="meta-chip">{game.environment.timeOfDay}</span>
                </div>
                <strong>{game.environment.location}</strong>
                <p className="subtle-copy">{game.environment.sceneSummary}</p>
                <div className="tag-row">
                  {game.environment.hazards.map((hazard) => (
                    <span key={hazard} className="meta-chip">
                      {hazard}
                    </span>
                  ))}
                  {game.environment.factions.map((faction) => (
                    <span key={faction} className="meta-chip">
                      {faction}
                    </span>
                  ))}
                </div>
              </div>

              <div className="panel arena-side-panel">
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
                <div className="tag-row">
                  {game.player.classFeatures.map((feature) => (
                    <span key={feature} className="meta-chip">
                      {feature}
                    </span>
                  ))}
                  {game.player.customTraits.map((trait) => (
                    <span key={trait} className="meta-chip">
                      {trait}
                    </span>
                  ))}
                </div>
              </div>

              <div className="panel arena-side-panel">
                <div className="panel-header">
                  <p className="eyebrow">Recent Art</p>
                  <span className="meta-chip">{game.artGallery.length} frames</span>
                </div>
                {game.artGallery.length > 0 ? (
                  <div className="art-strip arena-art-strip">
                    {game.artGallery.slice(0, 6).map((art) => (
                      <img key={art.id} src={art.url} alt={art.prompt} className="art-thumb" />
                    ))}
                  </div>
                ) : (
                  <div className="art-placeholder arena-placeholder">
                    Scene, enemy, portrait, and item art appears here as the DM generates it.
                  </div>
                )}
              </div>
            </aside>
          </section>
        )}
      </main>
    </div>
  );
}

export default App;