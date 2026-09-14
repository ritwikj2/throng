import { randomUUID } from "node:crypto";
import { STRUCTURES } from "../shared/types.js";
import type {
  ActionKind,
  Command,
  CommandResult,
  Creature,
  Memory,
  MindContext,
  MindDecision,
  Need,
  Vec,
  WorldState,
} from "../shared/types.js";
import {
  append,
  clamp,
  distance,
  event,
  externalRelief,
  home,
  idle,
  intention,
  isDurableLoss,
  LIMITS,
  living,
  makeCreature,
  NEEDS,
  object,
  point,
  random,
  remember,
  say,
  salientMemories,
  setIntention,
  text,
  urgent,
  VISION,
} from "./simulation-core.js";
import {
  actionForNeed,
  choosePlan,
  createSite,
  execute,
  fundProjects,
  knownObjects,
  projectReady,
  structureKind,
} from "./simulation-behavior.js";
import { perceive, reflect, shareMemory, updateCollective } from "./simulation-learning.js";

interface MindOffer {
  at: number;
  memories: Set<string>;
  targets: Set<string>;
  actions: Set<ActionKind>;
}
// Request evidence is transient. The saved world contains all simulation state;
// a restored world requires a new context before accepting an external plan.
const offers = new WeakMap<WorldState, Map<string, MindOffer>>();
const MODEL_OFFER_TTL = 360;
const actions: ActionKind[] = [
  "idle",
  "walk",
  "eat",
  "wash",
  "play",
  "rest",
  "socialize",
  "gather",
  "build",
  "sing",
];

export function createWorld(seed = 0x51a7c0de, name = "The clearing"): WorldState {
  const normalizedSeed = Number.isFinite(seed) ? seed >>> 0 : 0x51a7c0de;
  const world: WorldState = {
    version: 1,
    cognitionMode: "local",
    id: randomUUID(),
    name: text(name, 60) || "The clearing",
    seed: normalizedSeed,
    rng: normalizedSeed || 0x6d2b79f5,
    serial: 0,
    width: 32,
    height: 24,
    time: 0,
    createdAt: new Date().toISOString(),
    speed: 1,
    paused: false,
    hatched: false,
    stage: "egg",
    capacity: 8,
    creatures: [],
    objects: [],
    resources: { wood: 0, stone: 0 },
    collective: {
      coherence: 0,
      trust: 50,
      fear: 0,
      grief: 0,
      lexicon: [],
      messages: [],
      milestones: [],
      sharedKnowledge: 0,
      choirUntil: 0,
    },
    events: [],
    care: { fed: 0, washed: 0, played: 0, petted: 0 },
    stats: { births: 0, deaths: 0, playerKills: 0, discoveries: 0, conversations: 0, built: 0 },
  };
  for (const position of [
    { x: 5, y: 5 },
    { x: 9, y: 5 },
    { x: 12, y: 8 },
    { x: 23, y: 6 },
    { x: 27, y: 10 },
    { x: 25, y: 19 },
    { x: 9, y: 19 },
  ])
    object(
      world,
      "tree",
      { x: position.x + random(world) * 0.6, y: position.y + random(world) * 0.6 },
      27,
      27,
    );
  for (const position of [
    { x: 20, y: 9 },
    { x: 6, y: 14 },
    { x: 24, y: 16 },
    { x: 17, y: 20 },
  ])
    object(world, "rock", position, 24, 24);
  object(world, "apple", { x: 14.8, y: 12 }, 1, 1);
  object(world, "ball", { x: 18, y: 12.4 }, 1, 1);
  say(world, "An egg rests in the clearing. Hatch it when you are ready; time waits for you.");
  return world;
}
function environment(world: WorldState, previousTime: number, dt: number): void {
  const trees = world.objects.filter((item) => item.kind === "tree" && item.amount >= 3);
  for (const target of world.objects) {
    if (target.built && target.kind === "feeder")
      target.amount = Math.min(target.capacity, target.amount + dt * 0.24);
    if (target.kind === "tree")
      target.amount = Math.min(target.capacity, target.amount + dt * 0.008);
  }
  for (const tree of trees) {
    if (
      Math.floor((world.time - tree.createdAt) / 32) <=
      Math.floor((previousTime - tree.createdAt) / 32)
    )
      continue;
    if (
      world.objects.filter(
        (item) => item.kind === "apple" && distance(item.position, tree.position) < 3,
      ).length >= 2
    )
      continue;
    object(
      world,
      "apple",
      {
        x: tree.position.x + (random(world) - 0.5) * 2.5,
        y: tree.position.y + (random(world) - 0.5) * 2.5,
      },
      1,
      1,
    );
  }
  world.objects = world.objects.filter(
    (target) => target.kind !== "apple" || target.amount >= 0.999,
  );
}
function endLife(world: WorldState, victim: Creature, actor: "player" | "environment"): void {
  if (!victim.alive) return;
  const witnesses = living(world).filter(
    (creature) =>
      creature.id !== victim.id && distance(creature.position, victim.position) <= VISION,
  );
  victim.alive = false;
  victim.health = 0;
  victim.previousPosition = { ...victim.position };
  victim.modelPending = false;
  victim.utterance = undefined;
  victim.carried = undefined;
  idle(world, victim);
  victim.intention.text = "Still.";
  victim.intention.reason =
    actor === "player"
      ? "The player squashed this creature."
      : "Needs remained critically low for too long.";
  offers.get(world)?.delete(victim.id);
  world.stats.deaths++;
  if (actor === "player")
    world.stats.playerKills = Math.min(1000000, (world.stats.playerKills ?? 0) + 1);
  event(
    world,
    "loss",
    actor === "player"
      ? `The player squashed ${victim.name}.`
      : `${victim.name} died after sustained extreme unmet needs.`,
    victim.id,
  );
  for (const witness of witnesses) {
    const familiarity =
      witness.relationships.find((relation) => relation.id === victim.id)?.familiarity ?? 0;
    const family = witness.parentId === victim.id || victim.parentId === witness.id;
    remember(
      world,
      witness,
      "loss",
      actor === "player"
        ? `I saw the player squash ${victim.name}. They are gone; the player caused this loss.`
        : `I saw ${victim.name} stop moving after their needs remained critically low.`,
      {
        actor,
        sourceId: actor,
        subjectId: victim.id,
        position: victim.position,
        importance: actor === "player" ? 100 : 90,
        valence: -1,
      },
    );
    externalRelief(
      witness,
      "joy",
      -(actor === "player" ? 14 : 8) - familiarity * 0.08 - (family ? 6 : 0),
    );
    externalRelief(witness, "social", -8 - (family ? 4 : 0));
    witness.contentmentTime = 0;
    idle(world, witness);
    offers.get(world)?.delete(witness.id);
  }
  if (witnesses.length) {
    world.collective.grief = clamp((world.collective.grief ?? 0) + (actor === "player" ? 22 : 12));
    if (actor === "player") {
      world.collective.fear = clamp((world.collective.fear ?? 0) + 26);
      world.collective.trust = clamp(world.collective.trust - 26);
    }
    world.collective.choirUntil = world.time;
    world.collective.coherence = clamp(world.collective.coherence - (actor === "player" ? 10 : 5));
    if (world.cognitionMode !== "model")
      say(
        world,
        actor === "player"
          ? `${witnesses[0]!.name} saw you squash ${victim.name}. We remember who caused this loss.`
          : `${witnesses[0]!.name} saw ${victim.name} stop moving. There are ${living(world).length} of us now.`,
      );
  }
}
function body(world: WorldState, creature: Creature, dt: number): void {
  const rates: Record<Need, number> = {
    food: 0.095,
    clean: 0.035,
    joy: 0.065,
    rest: 0.042,
    social: 0.045,
  };
  for (const need of NEEDS) creature.needs[need] = clamp(creature.needs[need] - rates[need] * dt);
  const severe = ["food", "clean", "rest"].filter(
    (need) => creature.needs[need as Need] < 5,
  ).length;
  creature.health = clamp(creature.health + (severe ? -0.13 * severe : 0.3) * dt);
  if (creature.health > 0) return;
  endLife(world, creature, "environment");
}

function replicate(world: WorldState, creature: Creature, dt: number): void {
  const comfortable =
    creature.health >= 80 &&
    creature.needs.food >= 68 &&
    creature.needs.clean >= 68 &&
    creature.needs.joy >= 68 &&
    creature.needs.rest >= 68 &&
    creature.needs.social >= 45;
  creature.contentmentTime = clamp(
    creature.contentmentTime + (comfortable ? dt : -dt * 0.8),
    0,
    110,
  );
  const interval = (creature.generation === 0 ? 54 : 72) + creature.traits.sensitivity * 0.08;
  if (
    !comfortable ||
    creature.contentmentTime < interval ||
    world.time - creature.lastReplicatedAt < interval ||
    world.time - creature.bornAt < 45 ||
    living(world).length >= Math.min(64, world.capacity)
  )
    return;
  world.creatures = world.creatures.filter(
    (other) => other.alive || world.creatures.length < LIMITS.creatures,
  );
  if (world.creatures.length >= LIMITS.creatures) return;
  const comfort = creature.contentmentTime;
  const child = makeCreature(
    world,
    point(world, {
      x: creature.position.x + (random(world) - 0.5) * 1.2,
      y: creature.position.y + (random(world) - 0.5) * 1.2,
    }),
    creature,
  );
  creature.contentmentTime = 0;
  creature.lastReplicatedAt = world.time;
  creature.needs.food = clamp(creature.needs.food - 9);
  creature.needs.rest = clamp(creature.needs.rest - 6);
  remember(
    world,
    creature,
    "birth",
    `${child.name} split from me after ${comfort.toFixed(0)} seconds of comfort. Their memories will be their own.`,
    { subjectId: child.id, importance: 95, valence: 0.9 },
  );
  event(
    world,
    "birth",
    `${child.name} joined ${creature.name}; ${living(world).length} of us are alive.`,
    child.id,
  );
  say(
    world,
    `${creature.name} had enough food, comfort, and rest to divide. ${child.name} is here; there are now ${living(world).length} of us.`,
  );
}

export function stepWorld(world: WorldState, dt: number): void {
  if (world.paused || !world.hatched || !Number.isFinite(dt) || dt <= 0) return;
  // The runtime supplies simulation seconds, already accounting for speed.
  // Clamp accidental large calls rather than applying an absence penalty.
  const delta = Math.min(dt, 0.1);
  const previousTime = world.time;
  world.time = Math.round((world.time + delta) * 1000000) / 1000000;
  environment(world, previousTime, delta);
  world.collective.fear = clamp((world.collective.fear ?? 0) - delta * 0.01);
  world.collective.grief = clamp((world.collective.grief ?? 0) - delta * 0.006);
  fundProjects(world);
  for (const creature of living(world)) {
    creature.previousPosition = { ...creature.position };
    creature.position = point(world, creature.position);
    body(world, creature, delta);
    if (!creature.alive) continue;
    if (creature.utterance && creature.utterance.until <= world.time)
      creature.utterance = undefined;
    perceive(world, creature);
    const emergency = urgent(creature);
    const doingCare =
      !emergency ||
      (emergency === "food" &&
        creature.intention.action === "walk" &&
        !knownObjects(world, creature).some(
          (target) =>
            target.built && ["apple", "feeder"].includes(target.kind) && target.amount >= 1,
        )) ||
      creature.intention.action === actionForNeed(emergency) ||
      ((emergency === "social" || emergency === "joy") && creature.intention.action === "sing");
    if (
      creature.intention.until <= world.time ||
      creature.intention.action === "idle" ||
      !doingCare
    )
      choosePlan(world, creature);
    execute(world, creature, delta);
    reflect(world, creature);
    replicate(world, creature, delta);
  }
  updateCollective(world);
  if (world.creatures.length > LIMITS.creatures)
    world.creatures = [
      ...living(world),
      ...world.creatures.filter((c) => !c.alive).slice(-(LIMITS.creatures - living(world).length)),
    ];
}
const validPosition = (world: WorldState, value: Vec): boolean =>
  !!value &&
  Number.isFinite(value.x) &&
  Number.isFinite(value.y) &&
  value.x >= 1 &&
  value.x <= world.width - 1 &&
  value.y >= 1 &&
  value.y <= world.height - 1;
const failure = (message: string): CommandResult => ({ ok: false, message });

export function applyCommand(world: WorldState, command: Command): CommandResult {
  if (!command || typeof command !== "object") return failure("This command is not valid.");
  if (command.type === "pause") {
    if (typeof command.paused !== "boolean") return failure("Pause must be true or false.");
    world.paused = command.paused;
    return {
      ok: true,
      message: command.paused ? "The colony is paused." : "The colony is awake again.",
    };
  }
  if (command.type === "speed") {
    if (![1, 4, 12].includes(command.speed)) return failure("Choose speed 1, 4, or 12.");
    world.speed = command.speed;
    return { ok: true, message: `Simulation speed set to ${command.speed}×.` };
  }
  if (command.type === "hatch") {
    if (world.hatched) return failure("This egg has already hatched.");
    world.hatched = true;
    world.stage = "care";
    const creature = makeCreature(world, home(world));
    event(world, "birth", `${creature.name} hatched in the clearing.`, creature.id);
    say(
      world,
      `${creature.name} is awake. An apple and a ball are nearby; what happens next will become a memory.`,
    );
    return { ok: true, message: `${creature.name} hatched.`, creatureId: creature.id };
  }
  if (!world.hatched) return failure("Hatch the egg before giving the colony instructions.");
  if (command.type === "capacity") {
    if (world.capacity >= 64)
      return failure("The colony already has room for the maximum of 64 creatures.");
    const required = Math.max(2, world.capacity - 2);
    if (living(world).length < required)
      return failure(
        `Expansion opens at ${required} living creatures; the colony currently has ${living(world).length}.`,
      );
    world.capacity = Math.min(64, world.capacity * 2);
    event(world, "milestone", `The player made room for ${world.capacity} creatures.`);
    return { ok: true, message: `There is now room for ${world.capacity} creatures.` };
  }
  if (command.type === "build") {
    if (!structureKind(command.kind)) return failure("That structure is not available.");
    const info = STRUCTURES[command.kind];
    if (world.objects.some((target) => target.kind === command.kind))
      return failure(`${info.name} is already built or planned.`);
    if (living(world).length < info.population)
      return failure(`${info.name} needs at least ${info.population} living creatures.`);
    if (!validPosition(world, command.position))
      return failure("Choose a building site inside the field.");
    if (
      world.objects.some(
        (target) =>
          !["apple", "ball"].includes(target.kind) &&
          distance(target.position, command.position) < 1.2,
      )
    )
      return failure("That site is occupied; choose a little more space.");
    const site = createSite(world, command.kind, command.position);
    if (!site) return failure("There is no room for another world object.");
    fundProjects(world);
    const wood = Math.max(0, info.wood - site.amount);
    const stone = Math.max(0, info.stone - site.capacity);
    return {
      ok: true,
      message:
        wood || stone
          ? `${info.name} planned. Workers will gather ${wood} wood and ${stone} stone still needed.`
          : `${info.name} funded. Nearby workers can begin construction.`,
    };
  }
  if (command.type === "message") {
    const content = text(command.text, 320);
    if (!content) return failure("Write a message for the colony first.");
    say(world, content, "player");
    for (const creature of living(world))
      remember(world, creature, "player", `The shared message was: ${content}`, {
        sourceId: "player",
        actor: "player",
        importance: 70,
      });
    if (world.cognitionMode === "model")
      return { ok: true, message: "Your message was recorded for the colony." };
    const sharedWords = world.collective.lexicon.filter((word) => word.knownBy.length > 1).length;
    const latest = [...world.events]
      .reverse()
      .find(
        (entry) =>
          entry.kind !== "loss" ||
          living(world).some((creature) =>
            creature.memories.some(
              (memory) => isDurableLoss(memory) && memory.subjectId === entry.creatureId,
            ),
          ),
      );
    if (/food|hungr|eat|apple/i.test(content)) {
      const grove = world.objects.find((target) => target.kind === "feeder" && target.built);
      say(
        world,
        grove
          ? `Our apple grove holds ${Math.floor(grove.amount)} portions. Food becomes useful when someone reaches it and eats.`
          : `We have ${world.objects.filter((target) => target.kind === "apple" && target.amount >= 1).length} fallen apples. We still need to find and eat them; there is no finished apple grove.`,
      );
    } else {
      say(
        world,
        `We heard “${text(content, 90)}”. ${living(world).length} of us are alive, with ${sharedWords} shared words.${latest ? ` Our latest event: ${latest.text}` : " We are still gathering experiences."}`,
      );
    }
    return {
      ok: true,
      message: "Your message is public to the colony; the local reply reports its current state.",
    };
  }
  if (command.type !== "care") return failure("This command is not supported.");
  if (!["feed", "wash", "play", "pet", "tree", "kill"].includes(command.tool))
    return failure("Choose a valid care tool.");
  if (!validPosition(world, command.position)) return failure("Use this tool inside the field.");
  const selected = command.creatureId
    ? living(world).find((creature) => creature.id === command.creatureId)
    : undefined;
  if (command.creatureId && !selected) return failure("That creature is no longer available.");
  if (command.tool === "kill") {
    const victim =
      selected ??
      living(world)
        .filter((creature) => distance(creature.position, command.position) <= 2.3)
        .sort(
          (a, b) =>
            distance(a.position, command.position) - distance(b.position, command.position) ||
            a.id.localeCompare(b.id),
        )[0];
    if (!victim || distance(victim.position, command.position) > 2.3)
      return failure("No living creature is within reach of that point.");
    endLife(world, victim, "player");
    return { ok: true, message: `${victim.name} was squashed.`, creatureId: victim.id };
  }
  const position = selected?.position ?? command.position;
  if (command.tool === "feed" || command.tool === "play" || command.tool === "tree") {
    const kind = command.tool === "feed" ? "apple" : command.tool === "play" ? "ball" : "tree";
    const placed = object(world, kind, position, kind === "tree" ? 27 : 1);
    if (!placed)
      return failure("The field has too many objects. Let the colony use what is already here.");
    if (command.tool === "feed") world.care.fed++;
    if (command.tool === "play") world.care.played++;
    event(
      world,
      "care",
      `The player placed a ${kind} near ${position.x.toFixed(1)}, ${position.y.toFixed(1)}.`,
    );
    return {
      ok: true,
      message:
        kind === "apple"
          ? "Apple placed. A creature must find and eat it to be fed."
          : kind === "ball"
            ? "Ball placed. Nearby creatures can choose to play."
            : "A new tree can grow fruit and supply wood.",
    };
  }
  const recipients = selected
    ? [selected]
    : living(world)
        .filter((creature) => distance(creature.position, position) <= 2.3)
        .sort((a, b) => distance(a.position, position) - distance(b.position, position))
        .slice(0, command.tool === "pet" ? 1 : 6);
  if (!recipients.length) return failure("No creature is close enough to receive that care.");
  let careBenefit = 0;
  for (const creature of recipients) {
    const need: Need = command.tool === "wash" ? "clean" : "social";
    const before = creature.needs[need];
    careBenefit += externalRelief(creature, need, command.tool === "wash" ? 38 : 22);
    if (command.tool === "pet") careBenefit += externalRelief(creature, "joy", 12);
    remember(
      world,
      creature,
      "player",
      `The player ${command.tool === "wash" ? "washed" : "petted"} me; my ${need} improved by ${(creature.needs[need] - before).toFixed(1)}.`,
      {
        sourceId: "player",
        actor: "player",
        need,
        delta: creature.needs[need] - before,
        valence: 0.6,
        importance: 65,
      },
    );
  }
  if (command.tool === "wash") world.care.washed++;
  else world.care.petted++;
  if (careBenefit > 0) {
    const rememberedHarm = living(world).some((creature) =>
      creature.memories.some((memory) => isDurableLoss(memory) && memory.actor === "player"),
    );
    world.collective.trust = clamp(world.collective.trust + (rememberedHarm ? 0.15 : 1.5));
    world.collective.fear = clamp((world.collective.fear ?? 0) - 0.3);
  }
  event(
    world,
    "care",
    `${command.tool === "wash" ? "Washing" : "Petting"} reached ${recipients.map((creature) => creature.name).join(", ")}.`,
  );
  return {
    ok: true,
    message: `Care reached ${recipients.length} ${recipients.length === 1 ? "creature" : "creatures"}.`,
    ...(selected ? { creatureId: selected.id } : {}),
  };
}

export function getMindContext(world: WorldState, creatureId: string): MindContext | null {
  const creature = world.creatures.find(
    (candidate) => candidate.id === creatureId && candidate.alive,
  );
  if (!creature) return null;
  const neighbors = living(world)
    .filter(
      (other) => other.id !== creatureId && distance(other.position, creature.position) <= VISION,
    )
    .sort(
      (a, b) => distance(a.position, creature.position) - distance(b.position, creature.position),
    )
    .slice(0, 12)
    .map((other) => ({
      id: other.id,
      name: other.name,
      action: other.action,
      familiarity: creature.relationships.find((entry) => entry.id === other.id)?.familiarity ?? 0,
    }));
  const available = new Set<ActionKind>(["idle", "walk", "wash", "rest", "sing"]);
  if (neighbors.length) available.add("socialize");
  if (creature.carried) available.add("gather");
  for (const target of knownObjects(world, creature)) {
    if (!target.built) {
      if (projectReady(target)) available.add("build");
      continue;
    }
    if (["apple", "feeder"].includes(target.kind) && target.amount >= 1) available.add("eat");
    if (["ball", "carousel"].includes(target.kind)) available.add("play");
    if (["tree", "rock"].includes(target.kind) && target.amount >= 1) available.add("gather");
  }
  const context: MindContext = structuredClone({
    worldId: world.id,
    bounds: { width: world.width, height: world.height },
    creatureId,
    at: world.time,
    name: creature.name,
    needs: creature.needs,
    traits: creature.traits,
    intention: creature.intention,
    body: {
      position: creature.position,
      health: creature.health,
      age: Math.max(0, world.time - creature.bornAt),
      generation: creature.generation,
      ...(creature.carried ? { carried: creature.carried } : {}),
    },
    ...(creature.cognition ? { cognition: creature.cognition } : {}),
    preferences: Object.fromEntries(Object.entries(creature.preferences).slice(0, 9)),
    rewards: Object.fromEntries(Object.entries(creature.rewards).slice(0, actions.length)),
    relationships: creature.relationships.slice(-LIMITS.relationships),
    memories: salientMemories(creature, world.time),
    beliefs: creature.beliefs.slice(-32),
    neighbors,
    availableActions: [...available],
    playerMessages: world.collective.messages
      .filter((message) => message.speaker === "player")
      .slice(-3)
      .map((message) => message.text),
  });
  let worldOffers = offers.get(world);
  if (!worldOffers) {
    worldOffers = new Map();
    offers.set(world, worldOffers);
  }
  worldOffers.set(creatureId, {
    at: world.time,
    memories: new Set(context.memories.map((memory) => memory.id)),
    targets: new Set([
      ...context.beliefs.map((belief) => belief.objectId),
      ...neighbors.map((neighbor) => neighbor.id),
    ]),
    actions: available,
  });
  for (const [key, offer] of worldOffers)
    if (
      world.time - offer.at > MODEL_OFFER_TTL ||
      !world.creatures.some((candidate) => candidate.id === key && candidate.alive)
    )
      worldOffers.delete(key);
  return context;
}

export function applyMindDecision(
  world: WorldState,
  creatureId: string,
  decision: MindDecision,
): boolean {
  const creature = world.creatures.find(
    (candidate) => candidate.id === creatureId && candidate.alive,
  );
  const offer = offers.get(world)?.get(creatureId);
  if (
    !creature ||
    !offer ||
    world.time - offer.at > MODEL_OFFER_TTL ||
    !decision ||
    typeof decision !== "object"
  )
    return false;
  if (
    !actions.includes(decision.action) ||
    !offer.actions.has(decision.action) ||
    typeof decision.thought !== "string" ||
    typeof decision.reason !== "string" ||
    !text(decision.thought) ||
    !text(decision.reason)
  )
    return false;
  if (
    !Array.isArray(decision.memoryIds) ||
    decision.memoryIds.length > 6 ||
    decision.memoryIds.some(
      (memoryId) => typeof memoryId !== "string" || !offer.memories.has(memoryId),
    )
  )
    return false;
  if (decision.speech !== undefined && typeof decision.speech !== "string") return false;
  if (
    decision.targetId !== undefined &&
    (typeof decision.targetId !== "string" || !offer.targets.has(decision.targetId))
  )
    return false;
  if (
    decision.goal !== undefined &&
    (typeof decision.goal !== "string" || !text(decision.goal, 180))
  )
    return false;
  if (
    decision.lesson !== undefined &&
    (typeof decision.lesson !== "string" ||
      !text(decision.lesson, 240) ||
      decision.memoryIds.length === 0)
  )
    return false;
  if (decision.destination !== undefined) {
    const destination = decision.destination;
    if (
      decision.action !== "walk" ||
      decision.targetId !== undefined ||
      !destination ||
      typeof destination !== "object" ||
      Array.isArray(destination) ||
      Object.keys(destination).some((key) => key !== "x" && key !== "y") ||
      !validPosition(world, destination)
    )
      return false;
  }
  let sharedMemory: Memory | undefined;
  let recipient: Creature | undefined;
  if (decision.share !== undefined) {
    const share = decision.share;
    if (
      !share ||
      typeof share !== "object" ||
      Array.isArray(share) ||
      Object.keys(share).some((key) => key !== "memoryId" && key !== "recipientId") ||
      typeof share.memoryId !== "string" ||
      typeof share.recipientId !== "string" ||
      !offer.memories.has(share.memoryId) ||
      !offer.targets.has(share.recipientId)
    )
      return false;
    sharedMemory = creature.memories.find((memory) => memory.id === share.memoryId);
    recipient = world.creatures.find(
      (other) =>
        other.id === share.recipientId &&
        other.id !== creatureId &&
        other.alive &&
        distance(other.position, creature.position) <= VISION,
    );
    if (!sharedMemory || !recipient) return false;
  }
  const emergency = urgent(creature);
  if (
    emergency &&
    decision.action !== actionForNeed(emergency) &&
    !((emergency === "joy" || emergency === "social") && decision.action === "sing") &&
    !(
      emergency === "food" &&
      decision.action === "walk" &&
      !knownObjects(world, creature).some(
        (known) => known.built && ["apple", "feeder"].includes(known.kind) && known.amount >= 1,
      )
    )
  )
    return false;
  const target = knownObjects(world, creature).find(
    (candidate) => candidate.id === decision.targetId,
  );
  const neighbor = world.creatures.find(
    (candidate) =>
      candidate.id === decision.targetId &&
      candidate.id !== creatureId &&
      candidate.alive &&
      distance(candidate.position, creature.position) <= VISION,
  );
  if (
    target &&
    !creature.beliefs.some((belief) => belief.objectId === target.id) &&
    distance(target.position, creature.position) > VISION
  )
    return false;
  switch (decision.action) {
    case "eat":
      if (
        !target ||
        !target.built ||
        !["apple", "feeder"].includes(target.kind) ||
        target.amount < 1
      )
        return false;
      break;
    case "play":
      if (!target || !target.built || !["ball", "carousel"].includes(target.kind)) return false;
      break;
    case "wash":
      if (decision.targetId && (!target || !target.built || target.kind !== "bath")) return false;
      break;
    case "sing":
      if (decision.targetId && (!target || !target.built || target.kind !== "beacon")) return false;
      break;
    case "gather":
      if (
        !creature.carried &&
        (!target || !target.built || !["tree", "rock"].includes(target.kind) || target.amount < 1)
      )
        return false;
      break;
    case "build":
      if (!target || !projectReady(target)) return false;
      break;
    case "socialize":
      if (!neighbor) return false;
      break;
    case "walk":
      if (decision.targetId && !target) return false;
      break;
    case "rest":
    case "idle":
      if (decision.targetId) return false;
      break;
  }
  let destination = decision.destination ?? target?.position ?? neighbor?.position;
  if (decision.action === "walk" && !destination) {
    const angle = random(world) * Math.PI * 2;
    destination = point(world, {
      x: creature.position.x + Math.cos(angle) * 4,
      y: creature.position.y + Math.sin(angle) * 4,
    });
  }
  const plan = intention(
    world,
    decision.action,
    decision.thought,
    decision.reason,
    destination,
    decision.targetId,
    [...new Set(decision.memoryIds)],
  );
  plan.source = "model";
  if (decision.action === "gather") plan.until = world.time + 70;
  setIntention(creature, plan, world);
  if (decision.speech && text(decision.speech, 120))
    creature.utterance = {
      text: text(decision.speech, 120),
      at: world.time,
      until: world.time + 5,
      translated: true,
    };
  if (sharedMemory && recipient) shareMemory(world, creature, recipient, sharedMemory);
  const previous = creature.cognition;
  creature.cognition = {
    goal: decision.goal !== undefined ? text(decision.goal, 180) : text(previous?.goal, 180),
    lesson:
      decision.lesson !== undefined ? text(decision.lesson, 240) : text(previous?.lesson, 240),
    lastReasonedAt: world.time,
    decisions: Math.min(100000, Math.max(0, previous?.decisions ?? 0) + 1),
  };
  if (decision.lesson !== undefined)
    remember(
      world,
      creature,
      "reflection",
      `Model lesson: [${[...new Set(decision.memoryIds)].join(", ")}] ${text(decision.lesson, 240)}`,
      {
        actor: "creature",
        sourceId: creature.id,
        importance: 85,
        valence: 0,
      },
    );
  if (decision.speech && text(decision.speech, 120))
    say(world, `${text(creature.name, 40)}: ${text(decision.speech, 120)}`, "model");
  creature.lastModelAt = world.time;
  creature.modelPending = false;
  offers.get(world)?.delete(creatureId);
  return true;
}
