import type {
  ActionKind,
  ColonyEvent,
  Creature,
  Intention,
  Memory,
  MemoryKind,
  Need,
  Needs,
  ObjectKind,
  Vec,
  WorldObject,
  WorldState,
} from "../shared/types.js";

export const LIMITS = {
  memories: 48,
  beliefs: 32,
  relationships: 24,
  events: 80,
  messages: 40,
  objects: 160,
  creatures: 96,
  lexicon: 24,
  milestones: 16,
} as const;
export const NEEDS: Need[] = ["food", "clean", "joy", "rest", "social"];
export const VISION = 6;
export const REACH = 0.95;
export const clamp = (n: number, low = 0, high = 100): number =>
  Math.max(low, Math.min(high, Number.isFinite(n) ? n : low));
export const distance = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);
export const living = (world: WorldState): Creature[] => world.creatures.filter((c) => c.alive);
export const id = (world: WorldState, prefix: string): string => `${prefix}-${++world.serial}`;
export const text = (value: unknown, limit = 220): string =>
  typeof value === "string"
    ? value
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, limit)
    : "";
export const point = (world: WorldState, value: Vec): Vec => ({
  x: clamp(value.x, 1, world.width - 1),
  y: clamp(value.y, 1, world.height - 1),
});
export const home = (world: WorldState): Vec => ({ x: world.width / 2, y: world.height / 2 });
export function random(world: WorldState): number {
  let n = world.rng || 0x6d2b79f5;
  n ^= n << 13;
  n ^= n >>> 17;
  n ^= n << 5;
  world.rng = n >>> 0;
  return world.rng / 4294967296;
}
export function append<T>(list: T[], value: T, maximum: number): void {
  list.push(value);
  if (list.length > maximum) list.splice(0, list.length - maximum);
}
export function remember(
  world: WorldState,
  creature: Creature,
  kind: MemoryKind,
  content: string,
  fields: Partial<Omit<Memory, "id" | "at" | "kind" | "text">> = {},
): Memory {
  const memory: Memory = {
    id: id(world, "memory"),
    at: world.time,
    kind,
    text: text(content),
    importance: 45,
    valence: 0,
    ...fields,
  };
  if (memory.position) memory.position = { ...memory.position };
  creature.memories.push(memory);
  while (creature.memories.length > LIMITS.memories) {
    const retained = retainedMemoryIds(creature);
    const discard = creature.memories.findIndex((entry) => !retained.has(entry.id));
    creature.memories.splice(discard < 0 ? 0 : discard, 1);
  }
  return memory;
}
export function event(
  world: WorldState,
  kind: ColonyEvent["kind"],
  content: string,
  creatureId?: string,
): void {
  append(
    world.events,
    {
      id: id(world, "event"),
      at: world.time,
      kind,
      text: text(content),
      ...(creatureId ? { creatureId } : {}),
    },
    LIMITS.events,
  );
}
export function say(
  world: WorldState,
  content: string,
  source: "local" | "model" | "player" = "local",
): void {
  append(
    world.collective.messages,
    {
      id: id(world, "message"),
      at: world.time,
      speaker: source === "player" ? "player" : "throng",
      text: text(content, 360),
      source,
    },
    LIMITS.messages,
  );
}
export function intention(
  world: WorldState,
  action: ActionKind,
  content: string,
  reason: string,
  destination?: Vec,
  targetId?: string,
  memoryIds: string[] = [],
): Intention {
  return {
    action,
    text: text(content, 140),
    reason: text(reason, 200),
    source: "local",
    since: world.time,
    until: world.time + 35,
    memoryIds: memoryIds.slice(-6),
    ...(destination ? { destination: point(world, destination) } : {}),
    ...(targetId ? { targetId } : {}),
  };
}
export function setIntention(creature: Creature, plan: Intention, world: WorldState): void {
  creature.intention = plan;
  creature.action = plan.action;
  creature.actionProgress = 0;
  creature.actionStartNeeds = { ...creature.needs };
  creature.lastDecisionAt = world.time;
}
export function idle(world: WorldState, creature: Creature): void {
  creature.action = "idle";
  creature.actionProgress = 0;
  creature.actionStartNeeds = undefined;
  creature.intention = intention(
    world,
    "idle",
    "Looking for my next useful step.",
    "Local policy is considering what I know.",
  );
  creature.intention.until = world.time;
}
export function object(
  world: WorldState,
  kind: ObjectKind,
  position: Vec,
  amount: number,
  capacity = amount,
  built = true,
): WorldObject | undefined {
  if (world.objects.length >= LIMITS.objects) return undefined;
  const result: WorldObject = {
    id: id(world, "object"),
    kind,
    position: point(world, position),
    amount,
    capacity,
    built,
    progress: built ? 1 : 0,
    createdAt: world.time,
    lastUsedAt: world.time,
  };
  world.objects.push(result);
  return result;
}
export function makeCreature(world: WorldState, position: Vec, parent?: Creature): Creature {
  const creatureId = id(world, "creature");
  const name = `T-${String(world.stats.births + 1).padStart(3, "0")}`;
  const needs: Needs = parent
    ? { food: 77, clean: 86, joy: 83, rest: 94, social: 90 }
    : { food: 67, clean: 86, joy: 68, rest: 94, social: 83 };
  const creature: Creature = {
    id: creatureId,
    name,
    position: point(world, position),
    previousPosition: point(world, position),
    facing: 1,
    bornAt: world.time,
    generation: parent ? parent.generation + 1 : 0,
    ...(parent ? { parentId: parent.id } : {}),
    alive: true,
    needs,
    health: 100,
    traits: {
      curiosity: 35 + random(world) * 50,
      sociability: 35 + random(world) * 50,
      diligence: 35 + random(world) * 50,
      sensitivity: 35 + random(world) * 50,
      pitch: 25 + random(world) * 65,
    },
    action: "idle",
    intention: intention(
      world,
      "idle",
      "A light, a sound, and somewhere new.",
      "I have no experience of this place yet.",
    ),
    actionProgress: 0,
    memories: [],
    beliefs: [],
    relationships: [],
    preferences: {},
    rewards: {},
    contentmentTime: 0,
    lastReplicatedAt: world.time,
    lastDecisionAt: -10,
    lastPerceivedAt: -10,
    lastSocialAt: -20,
    lastReflectionAt: world.time,
    lastModelAt: -30,
    modelPending: false,
    learningCount: 0,
  };
  creature.intention.until = world.time;
  world.creatures.push(creature);
  world.stats.births++;
  remember(
    world,
    creature,
    "birth",
    parent
      ? `${parent.name} made room for me. I must discover this place myself.`
      : "I opened my eyes in a clearing in the grass.",
    {
      importance: 90,
      valence: 0.8,
      ...(parent ? { sourceId: parent.id, subjectId: parent.id } : {}),
      position: creature.position,
    },
  );
  return creature;
}
export const needFor = (action: ActionKind): Need | undefined =>
  (
    ({
      eat: "food",
      wash: "clean",
      play: "joy",
      rest: "rest",
      socialize: "social",
      sing: "joy",
    }) as Partial<Record<ActionKind, Need>>
  )[action];
export const readable = (kind: ObjectKind): string =>
  ({
    apple: "apple",
    ball: "ball",
    tree: "tree",
    rock: "rock",
    feeder: "apple grove",
    bath: "bathing pool",
    carousel: "roundabout",
    beacon: "resonator",
  })[kind];
export function urgent(creature: Creature): Need | undefined {
  return NEEDS.filter(
    (need) => creature.needs[need] < (need === "food" || need === "rest" ? 26 : 18),
  ).sort((a, b) => creature.needs[a] - creature.needs[b])[0];
}

// External relief has its own memory; it must not become reward for whatever
// unrelated action happens to be running. Clamp the adjusted baseline to the
// valid need domain: saturation can forgive a small time cost, never invent a gain.
export function externalRelief(creature: Creature, need: Need, amount: number): number {
  const before = creature.needs[need];
  creature.needs[need] = clamp(before + amount);
  const change = creature.needs[need] - before;
  if (creature.actionStartNeeds) {
    creature.actionStartNeeds[need] = clamp(creature.actionStartNeeds[need] + change);
  }
  return change;
}
export function observation(world: WorldState, target: WorldObject) {
  return {
    amount: target.amount,
    capacity: target.capacity,
    built: target.built,
    progress: target.progress,
    at: world.time,
  };
}

export function isDurableLoss(memory: Memory): boolean {
  return (
    memory.importance >= 85 &&
    (memory.kind === "loss" ||
      (memory.kind === "social" && memory.actor === "player" && memory.valence < 0))
  );
}
export function isModelLesson(creature: Creature, memory: Memory): boolean {
  return (
    memory.kind === "reflection" &&
    memory.sourceId === creature.id &&
    memory.actor === "creature" &&
    memory.text.startsWith("Model lesson:")
  );
}
function retainedMemoryIds(creature: Creature): Set<string> {
  const loss = creature.memories.filter(isDurableLoss);
  const playerLoss = loss.filter((memory) => memory.actor === "player").slice(-8);
  const otherLoss =
    playerLoss.length < 8
      ? loss.filter((memory) => memory.actor !== "player").slice(-(8 - playerLoss.length))
      : [];
  return new Set(
    [
      ...playerLoss,
      ...otherLoss,
      ...creature.memories.filter((memory) => isModelLesson(creature, memory)).slice(-4),
    ].map((memory) => memory.id),
  );
}
export function salientMemories(creature: Creature, now: number): Memory[] {
  const protectedIds = retainedMemoryIds(creature);
  const lowest = [...NEEDS].sort((a, b) => creature.needs[a] - creature.needs[b])[0];
  const score = (memory: Memory): number => {
    const age = Math.max(0, now - memory.at);
    return (
      memory.importance * 0.65 +
      30 / (1 + age / 45) +
      (memory.need === lowest ? 20 : 0) +
      (memory.subjectId && memory.subjectId === creature.intention.targetId ? 22 : 0) +
      (memory.kind === "player" && age < 120 ? 25 : 0)
    );
  };
  const selected = creature.memories.filter((memory) => protectedIds.has(memory.id));
  selected.push(
    ...creature.memories
      .filter((memory) => !protectedIds.has(memory.id))
      .sort((a, b) => score(b) - score(a) || b.at - a.at)
      .slice(0, Math.max(0, 16 - selected.length)),
  );
  return selected
    .slice(0, 16)
    .sort((a, b) => a.at - b.at || creature.memories.indexOf(a) - creature.memories.indexOf(b));
}
