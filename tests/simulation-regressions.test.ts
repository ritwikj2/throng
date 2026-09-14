import { describe, expect, it } from "vitest";
import type { Creature, MindDecision, WorldState } from "../shared/types.js";
import {
  applyCommand,
  applyMindDecision,
  createWorld,
  getMindContext,
  stepWorld,
} from "../server/simulation.js";
import { distance, idle, makeCreature, object, VISION } from "../server/simulation-core.js";

function hatch(seed = 31415): WorldState {
  const world = createWorld(seed);
  applyCommand(world, { type: "hatch" });
  return world;
}
function advance(world: WorldState, seconds: number): void {
  for (let index = 0; index < Math.round(seconds * 10); index++) stepWorld(world, 0.1);
}
function until(world: WorldState, condition: () => boolean, seconds = 20): void {
  for (let index = 0; index < seconds * 10 && !condition(); index++) stepWorld(world, 0.1);
  expect(condition()).toBe(true);
}
function planner(
  world: WorldState,
  creature: Creature,
  action: MindDecision["action"],
  targetId?: string,
): boolean {
  getMindContext(world, creature.id);
  return applyMindDecision(world, creature.id, {
    action,
    targetId,
    thought: `Choose ${action}.`,
    reason: "Use the offered evidence.",
    memoryIds: [],
  });
}
function rememberedTarget(kind: "apple" | "ball") {
  const world = hatch();
  world.objects = [];
  const creature = world.creatures[0]!;
  creature.position = { x: 2, y: 12 };
  creature.previousPosition = { ...creature.position };
  creature.needs = {
    food: kind === "apple" ? 35 : 95,
    clean: 95,
    joy: kind === "ball" ? 25 : 95,
    rest: 95,
    social: 95,
  };
  const target = object(world, kind, { x: 16, y: 12 }, 1, 1)!;
  creature.beliefs = [
    {
      objectId: target.id,
      kind,
      position: { ...target.position },
      confidence: 1,
      learnedAt: 0,
      source: "seen",
      observed: { amount: 1, capacity: 1, built: true, progress: 1, at: 0 },
    },
  ];
  idle(world, creature);
  return { world, creature, target };
}

describe("remembered objects do not grant remote perception", () => {
  it.each(["apple", "ball"] as const)(
    "unseen changes to a known %s do not change plans, movement, or context",
    (kind) => {
      const { world, target } = rememberedTarget(kind);
      const moved = structuredClone(world);
      const emptied = structuredClone(world);
      const removed = structuredClone(world);
      moved.objects[0]!.position = { x: 29, y: 21 };
      emptied.objects[0]!.amount = 0;
      emptied.objects[0]!.capacity = 0;
      emptied.objects[0]!.built = false;
      removed.objects = [];
      const variants = [world, moved, emptied, removed];
      for (const variant of variants) advance(variant, 2);
      const reference = world.creatures[0]!;
      expect(reference.intention.action).toBe(kind === "apple" ? "eat" : "play");
      expect(reference.intention.destination).toEqual({ x: 16, y: 12 });
      expect(distance(reference.position, { x: 16, y: 12 })).toBeGreaterThan(VISION);
      for (const variant of variants.slice(1)) {
        const creature = variant.creatures[0]!;
        expect(creature.position).toEqual(reference.position);
        expect(creature.intention).toEqual(reference.intention);
        expect(getMindContext(variant, creature.id)).toEqual(getMindContext(world, reference.id));
      }
      until(world, () => (reference.rewards[kind === "apple" ? "eat" : "play"]?.count ?? 0) > 0);
      expect(reference.rewards[kind === "apple" ? "eat" : "play"]!.mean).toBeGreaterThan(0);
      for (const changed of [moved, emptied, removed]) {
        const lost = changed.creatures[0]!;
        until(changed, () => (lost.rewards[kind === "apple" ? "eat" : "play"]?.count ?? 0) > 0);
        expect(lost.rewards[kind === "apple" ? "eat" : "play"]!.mean).toBeLessThan(0);
        expect(distance(lost.position, { x: 16, y: 12 })).toBeLessThanOrEqual(VISION + 0.1);
        if (changed === removed || changed === moved) {
          expect(lost.beliefs.some((belief) => belief.objectId === target.id)).toBe(false);
        }
      }
    },
  );

  it("an offered model target remains usable when removed out of sight, then fails on observation", () => {
    const { world, creature, target } = rememberedTarget("apple");
    getMindContext(world, creature.id);
    world.objects = [];
    expect(
      applyMindDecision(world, creature.id, {
        action: "eat",
        targetId: target.id,
        thought: "Visit the apple I remember.",
        reason: "My last observation had one portion.",
        memoryIds: [],
      }),
    ).toBe(true);
    expect(creature.intention.destination).toEqual({ x: 16, y: 12 });
    advance(world, 2);
    expect(creature.intention.action).toBe("eat");
    expect(creature.intention.source).toBe("model");
    until(world, () => (creature.rewards.eat?.count ?? 0) > 0);
    expect(creature.rewards.eat!.mean).toBeLessThan(0);
    expect(creature.needs.food).toBeLessThan(35);
  });

  it("perception stores an independent observation and retains it after leaving sight", () => {
    const { world, creature, target } = rememberedTarget("apple");
    creature.position = { x: 14, y: 12 };
    creature.beliefs = [];
    stepWorld(world, 0.1);
    const belief = creature.beliefs.find((entry) => entry.objectId === target.id)!;
    expect(belief.observed).toEqual({ amount: 1, capacity: 1, built: true, progress: 1, at: 0.1 });
    creature.position = { x: 2, y: 12 };
    idle(world, creature);
    target.amount = 0;
    target.position = { x: 29, y: 21 };
    advance(world, 1);
    expect(belief.observed?.amount).toBe(1);
    expect(belief.position).toEqual({ x: 16, y: 12 });
    expect(getMindContext(world, creature.id)!.availableActions).toContain("eat");
  });

  it("legacy beliefs without observations do not read hidden availability from the world", () => {
    const { world, creature, target } = rememberedTarget("apple");
    delete creature.beliefs[0]!.observed;
    target.amount = 1000;
    const context = getMindContext(world, creature.id)!;
    expect(context.availableActions).not.toContain("eat");
    expect(context.beliefs[0]!.observed).toBeUndefined();
    expect(planner(world, creature, "walk", target.id)).toBe(true);
    expect(creature.intention.destination).toEqual({ x: 16, y: 12 });
    until(world, () => !!creature.beliefs[0]?.observed);
    expect(getMindContext(world, creature.id)!.beliefs[0]!.observed?.amount).toBe(1000);
  });
});

describe("planner latency and capacity agreement", () => {
  it("accepts a model plan after 15 simulated seconds at 12x, and uses a 360-second boundary", () => {
    const world = hatch();
    const creature = world.creatures[0]!;
    stepWorld(world, 0.1);
    applyCommand(world, { type: "speed", speed: 12 });
    getMindContext(world, creature.id);
    advance(world, 15);
    const decision: MindDecision = {
      action: "rest",
      thought: "Take a short rest.",
      reason: "The body is not in danger.",
      memoryIds: [],
    };
    expect(applyMindDecision(world, creature.id, decision)).toBe(true);
    expect(creature.intention.source).toBe("model");
    getMindContext(world, creature.id);
    world.time += 360;
    expect(applyMindDecision(world, creature.id, decision)).toBe(true);
    getMindContext(world, creature.id);
    world.time += 360.1;
    expect(applyMindDecision(world, creature.id, decision)).toBe(false);
  });

  it("still revalidates visible resources when a delayed response arrives", () => {
    const world = hatch();
    const creature = world.creatures[0]!;
    stepWorld(world, 0.1);
    const apple = world.objects.find((entry) => entry.kind === "apple")!;
    getMindContext(world, creature.id);
    world.time += 15;
    apple.amount = 0;
    expect(
      applyMindDecision(world, creature.id, {
        action: "eat",
        targetId: apple.id,
        thought: "Eat.",
        reason: "A previous observation.",
        memoryIds: [],
      }),
    ).toBe(false);
  });

  it("permits expansion only when the living population is near capacity", () => {
    const world = hatch();
    expect(applyCommand(world, { type: "capacity" })).toMatchObject({ ok: false });
    expect(world.capacity).toBe(8);
    for (let index = 0; index < 4; index++) makeCreature(world, { x: 16, y: 12 });
    const denied = applyCommand(world, { type: "capacity" });
    expect(denied.ok).toBe(false);
    expect(denied.message).toContain("6 living");
    const sixth = makeCreature(world, { x: 16, y: 12 });
    sixth.alive = false;
    expect(applyCommand(world, { type: "capacity" }).ok).toBe(false);
    sixth.alive = true;
    expect(applyCommand(world, { type: "capacity" }).ok).toBe(true);
    expect(world.capacity).toBe(16);
    expect(applyCommand(world, { type: "capacity" }).ok).toBe(false);
  });
});

function restingWorld(): { world: WorldState; creature: Creature } {
  const world = hatch();
  world.objects = [];
  const creature = world.creatures[0]!;
  creature.needs = { food: 80, clean: 30, joy: 50, rest: 45, social: 40 };
  expect(planner(world, creature, "rest")).toBe(true);
  return { world, creature };
}

describe("actions receive only their own relief", () => {
  it("manual washing and petting do not increase the reward for an ongoing rest", () => {
    const { world: baseline, creature: first } = restingWorld();
    const cared = structuredClone(baseline);
    const second = cared.creatures[0]!;
    advance(baseline, 1);
    advance(cared, 1);
    expect(
      applyCommand(cared, {
        type: "care",
        tool: "wash",
        position: second.position,
        creatureId: second.id,
      }).ok,
    ).toBe(true);
    expect(
      applyCommand(cared, {
        type: "care",
        tool: "pet",
        position: second.position,
        creatureId: second.id,
      }).ok,
    ).toBe(true);
    until(baseline, () => !!first.rewards.rest, 6);
    until(cared, () => !!second.rewards.rest, 6);
    expect(second.needs.clean).toBeGreaterThan(first.needs.clean + 30);
    expect(second.needs.social).toBeGreaterThan(first.needs.social + 20);
    expect(second.rewards.rest!.mean).toBeCloseTo(first.rewards.rest!.mean, 10);
    const ownRest = (creature: Creature) =>
      creature.memories.find((memory) => memory.kind === "experience" && memory.need === "rest");
    expect(ownRest(second)!.delta).toBeCloseTo(ownRest(first)!.delta!, 10);
    expect(second.memories.filter((memory) => memory.kind === "player")).toHaveLength(2);
  });

  it("passive social relief does not increase the recipient's unrelated action reward", () => {
    const { world: baseline, creature: first } = restingWorld();
    const firstNeighbor = makeCreature(baseline, { x: 16.6, y: 12 });
    firstNeighbor.needs = { food: 96, clean: 96, joy: 96, rest: 96, social: 96 };
    expect(planner(baseline, firstNeighbor, "rest")).toBe(true);
    const visited = structuredClone(baseline);
    const recipient = visited.creatures[0]!;
    const visitor = visited.creatures[1]!;
    expect(planner(visited, visitor, "socialize", recipient.id)).toBe(true);
    until(baseline, () => !!first.rewards.rest, 6);
    until(visited, () => !!recipient.rewards.rest, 6);
    expect(recipient.needs.social).toBeGreaterThan(first.needs.social + 20);
    expect(recipient.rewards.rest!.mean).toBeCloseTo(first.rewards.rest!.mean, 10);
    expect(
      recipient.memories.some(
        (memory) => memory.kind === "social" && memory.sourceId === visitor.id,
      ),
    ).toBe(true);
  });
});
