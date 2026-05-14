import type {
  CombatCell,
  CombatState,
  CombatantKind,
  CombatantPosition,
  CombatTerrain,
  EnemyState,
  GameState,
  PartyMemberState,
} from "../types";

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (const char of seed) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function randomFrom(seed: string) {
  let value = hashSeed(seed) || 1;
  return () => {
    value += 0x6d2b79f5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function terrainForRoll(roll: number, hazards: string[]): CombatTerrain {
  if (roll > 0.91 && hazards.length > 0) {
    return "hazard";
  }
  if (roll > 0.82) {
    return "cover";
  }
  if (roll > 0.74) {
    return "difficult";
  }
  if (roll > 0.68) {
    return "elevation";
  }
  return "floor";
}

export function createEmptyCombatState(): CombatState {
  return {
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
  };
}

function createTerrainCells(game: GameState, width: number, height: number, seed: string): CombatCell[] {
  const rng = randomFrom(seed);
  const centerX = Math.floor(width / 2);
  const centerY = Math.floor(height / 2);
  const hazards = game.environment.hazards;
  const cells: CombatCell[] = [];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const nearSpawnLane = x <= 1 || x >= width - 2;
      const centerObjective = Math.abs(x - centerX) <= 1 && Math.abs(y - centerY) <= 1;
      const terrain = centerObjective
        ? "objective"
        : nearSpawnLane
          ? "floor"
          : terrainForRoll(rng(), hazards);
      const hazard = terrain === "hazard" ? hazards[Math.floor(rng() * hazards.length)] : undefined;
      cells.push({
        x,
        y,
        terrain,
        cover: terrain === "cover" ? 2 : terrain === "elevation" ? 1 : 0,
        elevation: terrain === "elevation" ? 1 : 0,
        hazard,
        label: terrain === "objective" ? "Focus" : hazard,
        blocksMovement: terrain === "water" || false,
      });
    }
  }

  return cells;
}

function uniqueSlot(
  occupied: Set<string>,
  preferredX: number,
  preferredY: number,
  width: number,
  height: number,
): { x: number; y: number } {
  for (let radius = 0; radius < Math.max(width, height); radius += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        const x = Math.min(width - 1, Math.max(0, preferredX + dx));
        const y = Math.min(height - 1, Math.max(0, preferredY + dy));
        const key = `${x},${y}`;
        if (!occupied.has(key)) {
          occupied.add(key);
          return { x, y };
        }
      }
    }
  }

  return { x: preferredX, y: preferredY };
}

function playerCombatant(game: GameState, width: number, height: number): CombatantPosition {
  return {
    id: "player",
    kind: "player",
    name: game.playerName,
    x: 1,
    y: Math.floor(height / 2),
    initiative: game.player.resources.initiative,
    conditions: [],
    isActive: true,
    hp: game.player.resources.health,
    maxHp: game.player.resources.maxHealth,
  };
}

function partyCombatant(
  partyMember: PartyMemberState,
  index: number,
  width: number,
  height: number,
  occupied: Set<string>,
): CombatantPosition {
  const slot = uniqueSlot(occupied, 1, Math.floor(height / 2) - 1 + index, width, height);
  return {
    id: partyMember.id,
    kind: "party",
    name: partyMember.name,
    x: slot.x,
    y: slot.y,
    initiative: partyMember.resources.initiative,
    conditions: [],
    isActive: partyMember.automated,
    hp: partyMember.resources.health,
    maxHp: partyMember.resources.maxHealth,
  };
}

function enemyCombatant(
  enemy: EnemyState,
  index: number,
  width: number,
  height: number,
  occupied: Set<string>,
): CombatantPosition {
  const slot = uniqueSlot(occupied, width - 2, Math.floor(height / 2) - 1 + index, width, height);
  return {
    id: enemy.id,
    kind: "enemy",
    name: enemy.name,
    x: slot.x,
    y: slot.y,
    initiative: enemy.stats.speed,
    conditions: [],
    isActive: enemy.stats.health > 0,
    hp: enemy.stats.health,
    maxHp: enemy.stats.maxHealth,
  };
}

export function createCombatFromGame(game: GameState, seed = createId("terrain")): CombatState {
  const width = 9;
  const height = 7;
  const occupied = new Set<string>([`1,${Math.floor(height / 2)}`]);
  const combatants: CombatantPosition[] = [
    playerCombatant(game, width, height),
    ...game.party.map((member, index) => partyCombatant(member, index, width, height, occupied)),
    ...game.enemies.map((enemy, index) => enemyCombatant(enemy, index, width, height, occupied)),
  ].sort((left, right) => right.initiative - left.initiative);

  return {
    active: true,
    round: 1,
    turnIndex: 0,
    width,
    height,
    terrainSeed: seed,
    terrainPrompt: `${game.environment.location}: ${game.environment.sceneSummary}`,
    terrainGenerated: true,
    cells: createTerrainCells(game, width, height, seed),
    combatants,
    objective: game.environment.pressureClock || "Control the center before the pressure clock fills.",
    log: [`Combat grid opened at ${game.environment.location}.`],
    updatedAt: Date.now(),
  };
}

function combatantKindForId(game: GameState, id: string): CombatantKind {
  if (id === "player") {
    return "player";
  }
  if (game.party.some((member) => member.id === id)) {
    return "party";
  }
  if (game.enemies.some((enemy) => enemy.id === id)) {
    return "enemy";
  }
  return "npc";
}

function combatantNameForId(game: GameState, id: string): string {
  if (id === "player") {
    return game.playerName;
  }
  return (
    game.party.find((member) => member.id === id)?.name ??
    game.enemies.find((enemy) => enemy.id === id)?.name ??
    game.npcs.find((npc) => npc.id === id)?.name ??
    id
  );
}

export function syncCombatants(game: GameState): CombatState {
  const combat = game.combat.active ? game.combat : createCombatFromGame(game);
  const activeIds = new Set(["player", ...game.party.map((member) => member.id), ...game.enemies.map((enemy) => enemy.id)]);
  const occupied = new Set<string>();
  const synced: CombatantPosition[] = combat.combatants
    .filter((combatant) => activeIds.has(combatant.id))
    .map((combatant) => {
      const partyMember = game.party.find((member) => member.id === combatant.id);
      const enemy = game.enemies.find((entry) => entry.id === combatant.id);
      const hp = combatant.id === "player"
        ? game.player.resources.health
        : partyMember?.resources.health ?? enemy?.stats.health ?? combatant.hp;
      const maxHp = combatant.id === "player"
        ? game.player.resources.maxHealth
        : partyMember?.resources.maxHealth ?? enemy?.stats.maxHealth ?? combatant.maxHp;
      occupied.add(`${combatant.x},${combatant.y}`);
      return {
        ...combatant,
        kind: combatantKindForId(game, combatant.id),
        name: combatantNameForId(game, combatant.id),
        hp,
        maxHp,
        isActive: (hp ?? 1) > 0,
      };
    });

  for (const member of game.party) {
    if (!synced.some((combatant) => combatant.id === member.id)) {
      synced.push(partyCombatant(member, synced.length, combat.width, combat.height, occupied));
    }
  }

  for (const enemy of game.enemies) {
    if (!synced.some((combatant) => combatant.id === enemy.id)) {
      synced.push(enemyCombatant(enemy, synced.length, combat.width, combat.height, occupied));
    }
  }

  return {
    ...combat,
    active: synced.some((combatant) => combatant.kind === "enemy"),
    combatants: synced,
    updatedAt: Date.now(),
  };
}

export function moveCombatant(
  combat: CombatState,
  combatantId: string,
  x: number,
  y: number,
  reason = "Manual reposition",
): CombatState {
  const boundedX = Math.min(combat.width - 1, Math.max(0, Math.round(x)));
  const boundedY = Math.min(combat.height - 1, Math.max(0, Math.round(y)));
  const targetCell = combat.cells.find((cell) => cell.x === boundedX && cell.y === boundedY);
  if (targetCell?.blocksMovement) {
    return combat;
  }

  const combatant = combat.combatants.find((entry) => entry.id === combatantId);
  return {
    ...combat,
    combatants: combat.combatants.map((entry) =>
      entry.id === combatantId ? { ...entry, x: boundedX, y: boundedY } : entry,
    ),
    log: [
      combatant
        ? `${combatant.name} moved to ${String.fromCharCode(65 + boundedX)}${boundedY + 1}. ${reason}`
        : `A combatant moved to ${String.fromCharCode(65 + boundedX)}${boundedY + 1}.`,
      ...combat.log,
    ].slice(0, 16),
    updatedAt: Date.now(),
  };
}
