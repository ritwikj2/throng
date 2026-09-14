import { describe, expect, it } from "vitest";
import type { Creature, MindDecision, WorldState } from "../shared/types.js";
import {
  applyCommand,
  applyMindDecision,
  createWorld,
  getMindContext,
  stepWorld,
} from "../server/simulation.js";
import {
  distance,
  home,
  idle,
  LIMITS,
  makeCreature,
  object,
  remember,
} from "../server/simulation-core.js";

function hatch(seed = 42): WorldState {
  const world = createWorld(seed);
  expect(applyCommand(world, { type: "hatch" }).ok).toBe(true);
  return world;
}
function advance(world: WorldState, seconds: number): void {
  for (let index = 0; index < Math.round(seconds * 10); index++) stepWorld(world, 0.1);
}
function until(world: WorldState, condition: () => boolean, maximum = 30): void {
  for (let index = 0; index < maximum * 10 && !condition(); index++) stepWorld(world, 0.1);
  expect(condition()).toBe(true);
}
function satisfied(creature: Creature): void {
  creature.needs = { food: 96, clean: 96, joy: 96, rest: 96, social: 96 };
}
function portable(world: WorldState): unknown {
  const copy = JSON.parse(JSON.stringify(world)) as Record<string, unknown>;
  delete copy.id;
  delete copy.createdAt;
  return copy;
}
function plan(
  action: MindDecision["action"],
  targetId?: string,
  memoryIds: string[] = [],
): MindDecision {
  return {
    action,
    ...(targetId ? { targetId } : {}),
    thought: `Choose ${action} using this creature's knowledge.`,
    reason: "A bounded test of the external planning boundary.",
    memoryIds,
  };
}

describe("simulation lifecycle", () => {
  it("starts with an egg, finite natural objects, and a unique colony ID", () => {
    const a = createWorld(42);
    const b = createWorld(42);
    expect(a.id).not.toBe(b.id);
    expect(portable(a)).toEqual(portable(b));
    expect(a.creatures).toHaveLength(0);
    expect(a.stage).toBe("egg");
    expect(a.capacity).toBe(8);
    expect(new Set(a.objects.map((item) => item.kind))).toEqual(
      new Set(["tree", "rock", "apple", "ball"]),
    );
    stepWorld(a, 0.1);
    expect(a.time).toBe(0);
    for (const item of a.objects) {
      expect(item.position.x).toBeGreaterThanOrEqual(1);
      expect(item.position.x).toBeLessThanOrEqual(31);
      expect(item.position.y).toBeGreaterThanOrEqual(1);
      expect(item.position.y).toBeLessThanOrEqual(23);
      expect(item.amount).toBeLessThanOrEqual(item.capacity);
    }
  });

  it("uses simulation seconds once, pauses completely, and handles invalid or oversized dt gently", () => {
    const world = hatch();
    applyCommand(world, { type: "speed", speed: 12 });
    stepWorld(world, 0.1);
    expect(world.time).toBe(0.1);
    applyCommand(world, { type: "pause", paused: true });
    const before = structuredClone(world);
    stepWorld(world, 100000);
    expect(world).toEqual(before);
    applyCommand(world, { type: "pause", paused: false });
    stepWorld(world, Number.NaN);
    stepWorld(world, -1);
    stepWorld(world, Infinity);
    expect(world.time).toBe(0.1);
    const creature = world.creatures[0]!;
    creature.needs.food = 0;
    creature.health = 50;
    stepWorld(world, 100000);
    expect(world.time).toBe(0.2);
    expect(creature.health).toBeGreaterThan(49);
    expect(creature.alive).toBe(true);
  });

  it("replays a seed and resumes JSON saves without hidden simulation state", () => {
    const first = hatch(77);
    const second = hatch(77);
    advance(first, 35);
    advance(second, 35);
    expect(portable(first)).toEqual(portable(second));
    const restored = JSON.parse(JSON.stringify(first)) as WorldState;
    advance(first, 100);
    advance(restored, 100);
    expect(portable(first)).toEqual(portable(restored));
  });

  it.each([1, 42, 12345])(
    "splits a comfortable creature between 45 and 80 seconds (seed %s)",
    (seed) => {
      const world = hatch(seed);
      until(world, () => world.creatures.length > 1, 80);
      expect(world.time).toBeGreaterThanOrEqual(45);
      expect(world.time).toBeLessThanOrEqual(80);
      const parent = world.creatures[0]!;
      const child = world.creatures[1]!;
      expect(child.parentId).toBe(parent.id);
      expect(child.beliefs).toHaveLength(0);
      expect(child.memories).toHaveLength(1);
      expect(child.memories[0]!.kind).toBe("birth");
      expect(parent.learningCount).toBeGreaterThan(0);
      expect(parent.memories.some((memory) => memory.kind === "reflection")).toBe(true);
    },
  );

  it("does not split an unfed creature and completes purposeful food searches", () => {
    const world = hatch();
    const creature = world.creatures[0]!;
    world.objects = [];
    creature.needs.food = 4;
    advance(world, 170);
    expect(world.creatures).toHaveLength(1);
    expect(creature.alive).toBe(true);
    expect(creature.contentmentTime).toBe(0);
    expect(creature.rewards.walk?.count).toBeGreaterThan(2);
    expect(creature.position.x).toBeGreaterThanOrEqual(1);
    expect(creature.position.x).toBeLessThanOrEqual(31);
  });
});

describe("real actions and learned choices", () => {
  it("walks to food, consumes one finite portion, and records the actual benefit", () => {
    const world = hatch();
    const creature = world.creatures[0]!;
    world.objects = [];
    satisfied(creature);
    creature.needs.food = 20;
    const apple = object(world, "apple", { x: 20, y: 12 }, 1)!;
    until(world, () => !!creature.rewards.eat, 12);
    expect(distance(creature.position, apple.position)).toBeLessThanOrEqual(0.96);
    expect(apple.amount).toBe(0);
    expect(creature.needs.food).toBeGreaterThan(50);
    expect(
      creature.memories.some(
        (memory) =>
          memory.kind === "experience" && memory.subjectId === apple.id && (memory.delta ?? 0) > 30,
      ),
    ).toBe(true);
    advance(world, 15);
    expect(creature.rewards.eat?.count).toBe(1);
    expect(world.objects.some((item) => item.kind === "apple")).toBe(false);
  });

  it("an experienced preference changes a later choice between equally accessible foods", () => {
    const world = hatch();
    const creature = world.creatures[0]!;
    world.objects = [];
    satisfied(creature);
    creature.needs.food = 50;
    object(world, "apple", home(world), 1);
    until(world, () => !!creature.rewards.eat, 5);
    expect(creature.preferences.apple).toBeGreaterThan(0);
    world.objects = [];
    const grove = object(world, "feeder", { x: 13, y: 12 }, 5, 10)!;
    const apple = object(world, "apple", { x: 19, y: 12 }, 1)!;
    creature.position = home(world);
    creature.previousPosition = home(world);
    satisfied(creature);
    creature.needs.food = 50;
    creature.beliefs = [];
    creature.lastPerceivedAt = -10;
    idle(world, creature);
    const inexperienced = structuredClone(world);
    const novice = inexperienced.creatures[0]!;
    novice.preferences = {};
    novice.rewards = {};
    novice.learningCount = 0;
    novice.memories = [];
    stepWorld(world, 0.1);
    stepWorld(inexperienced, 0.1);
    expect(creature.intention.targetId).toBe(apple.id);
    expect(novice.intention.targetId).toBe(grove.id);
    expect(creature.intention.reason).toContain("learned preference");
    expect(creature.intention.source).toBe("local");
  });

  it("single-place bathing capacity is respected and both users eventually finish", () => {
    const world = hatch();
    const first = world.creatures[0]!;
    const second = makeCreature(world, { x: 16.2, y: 12 });
    world.objects = [];
    object(world, "bath", { x: 16, y: 12 }, 1, 1);
    for (const creature of [first, second]) {
      satisfied(creature);
      creature.needs.clean = 10;
    }
    advance(world, 3.2);
    expect([first, second].filter((creature) => creature.needs.clean > 20)).toHaveLength(1);
    advance(world, 3.2);
    expect([first, second].filter((creature) => creature.needs.clean > 20)).toHaveLength(2);
  });

  it("plans with no materials, gathers and delivers them, builds once, and grows edible food", () => {
    const world = hatch();
    makeCreature(world, { x: 15.5, y: 12 });
    makeCreature(world, { x: 16.5, y: 12 });
    world.capacity = 3;
    world.objects = [];
    for (const creature of world.creatures) satisfied(creature);
    const tree = object(world, "tree", { x: 14, y: 10 }, 27)!;
    const rock = object(world, "rock", { x: 18, y: 10 }, 24)!;
    const result = applyCommand(world, {
      type: "build",
      kind: "feeder",
      position: { x: 16, y: 14.5 },
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("gather");
    expect(
      applyCommand(world, { type: "build", kind: "feeder", position: { x: 17, y: 15 } }).ok,
    ).toBe(false);
    const grove = world.objects.find((item) => item.kind === "feeder")!;
    expect(grove.built).toBe(false);
    expect(grove.amount).toBe(0);
    expect(grove.capacity).toBe(0);
    until(world, () => grove.built, 100);
    expect(grove.progress).toBe(1);
    expect(tree.amount).toBeLessThan(27);
    expect(rock.amount).toBeLessThan(24);
    expect(world.resources.wood).toBeGreaterThanOrEqual(0);
    expect(world.resources.stone).toBeGreaterThanOrEqual(0);
    expect(world.objects.filter((item) => item.kind === "feeder")).toHaveLength(1);
    expect(
      world.creatures.some((creature) =>
        creature.memories.some((memory) => memory.text.includes("delivered")),
      ),
    ).toBe(true);
    world.objects = world.objects.filter((item) => item.kind !== "apple");
    grove.amount = 0;
    for (const creature of world.creatures) satisfied(creature);
    advance(world, 5);
    expect(grove.amount).toBeGreaterThanOrEqual(1);
    expect(grove.amount).toBeLessThanOrEqual(grove.capacity);
    const eater = world.creatures[0]!;
    eater.needs.food = 20;
    eater.position = { ...grove.position };
    idle(world, eater);
    const previousMeals = eater.rewards.eat?.count ?? 0;
    until(world, () => (eater.rewards.eat?.count ?? 0) > previousMeals, 15);
    expect(eater.needs.food).toBeGreaterThan(45);
    expect(grove.amount).toBeGreaterThanOrEqual(0);
    expect(grove.lastUsedAt).toBeGreaterThan(0);
  });
});

describe("personal knowledge and communication", () => {
  it("keeps distant knowledge and personal memories out of another creature's context", () => {
    const world = hatch();
    const first = world.creatures[0]!;
    first.position = { x: 3, y: 3 };
    const distant = makeCreature(world, { x: 27, y: 20 });
    world.objects = [];
    const hidden = object(world, "apple", { x: 28, y: 20 }, 1)!;
    remember(world, distant, "experience", "private experience by the far shore");
    stepWorld(world, 0.1);
    const context = getMindContext(world, first.id)!;
    const otherContext = getMindContext(world, distant.id)!;
    expect(context.neighbors).toHaveLength(0);
    expect(context.beliefs.some((belief) => belief.objectId === hidden.id)).toBe(false);
    expect(context.memories.some((memory) => memory.text.includes("private experience"))).toBe(
      false,
    );
    expect(otherContext.beliefs.some((belief) => belief.objectId === hidden.id)).toBe(true);
    context.needs.food = 0;
    if (context.memories[0]) context.memories[0].text = "tampered";
    expect(first.needs.food).toBeGreaterThan(0);
    expect(first.memories.some((memory) => memory.text === "tampered")).toBe(false);
    expect(applyMindDecision(world, first.id, plan("eat", hidden.id))).toBe(false);
    applyCommand(world, { type: "message", text: "A public greeting" });
    expect(getMindContext(world, first.id)!.playerMessages).toContain("A public greeting");
  });

  it("knowledge propagates through two nearby meetings with immediate-source provenance", () => {
    const world = hatch();
    const first = world.creatures[0]!;
    first.position = { x: 6, y: 6 };
    const second = makeCreature(world, { x: 6.8, y: 6 });
    const third = makeCreature(world, { x: 27, y: 20 });
    world.objects = [];
    const apple = object(world, "apple", { x: 2, y: 2 }, 1)!;
    for (const creature of world.creatures) {
      satisfied(creature);
      creature.needs.social = 55;
    }
    stepWorld(world, 0.1);
    expect(first.beliefs.some((belief) => belief.objectId === apple.id)).toBe(true);
    expect(second.beliefs.some((belief) => belief.objectId === apple.id)).toBe(false);
    getMindContext(world, first.id);
    expect(applyMindDecision(world, first.id, plan("socialize", second.id))).toBe(true);
    until(world, () => second.beliefs.some((belief) => belief.objectId === apple.id), 12);
    const shared = second.beliefs.find((belief) => belief.objectId === apple.id)!;
    expect(shared.source).toBe("shared");
    expect(shared.sourceId).toBe(first.id);
    expect(shared.confidence).toBeLessThan(1);
    const sourceObservation = first.beliefs.find(
      (belief) => belief.objectId === apple.id,
    )!.observed;
    expect(shared.observed).toEqual(sourceObservation);
    expect(shared.observed).not.toBe(sourceObservation);
    expect(third.beliefs.some((belief) => belief.objectId === apple.id)).toBe(false);
    first.position = { x: 29, y: 3 };
    idle(world, first);
    third.position = { x: second.position.x + 0.7, y: second.position.y };
    idle(world, second);
    idle(world, third);
    getMindContext(world, third.id);
    expect(applyMindDecision(world, third.id, plan("rest"))).toBe(true);
    getMindContext(world, second.id);
    expect(applyMindDecision(world, second.id, plan("socialize", third.id))).toBe(true);
    until(world, () => third.beliefs.some((belief) => belief.objectId === apple.id), 12);
    expect(third.beliefs.find((belief) => belief.objectId === apple.id)?.sourceId).toBe(second.id);
    expect(
      third.memories.some(
        (memory) =>
          memory.sourceId === second.id &&
          memory.subjectId === apple.id &&
          memory.text.includes(first.id),
      ),
    ).toBe(true);
    expect(world.collective.sharedKnowledge).toBeGreaterThanOrEqual(2);
    expect(world.stats.conversations).toBeGreaterThanOrEqual(2);
  });
});

describe("external planner validation", () => {
  it("rejects unsupported actions, invented memories, wrong/hidden/depleted targets, and stale offers", () => {
    const world = hatch();
    const creature = world.creatures[0]!;
    stepWorld(world, 0.1);
    const apple = world.objects.find((item) => item.kind === "apple")!;
    const ball = world.objects.find((item) => item.kind === "ball")!;
    getMindContext(world, creature.id);
    expect(
      applyMindDecision(world, creature.id, {
        ...plan("eat", apple.id),
        action: "teleport",
      } as unknown as MindDecision),
    ).toBe(false);
    expect(applyMindDecision(world, creature.id, plan("eat", apple.id, ["invented-memory"]))).toBe(
      false,
    );
    expect(applyMindDecision(world, creature.id, plan("eat", ball.id))).toBe(false);
    const hidden = object(world, "apple", { x: 30, y: 22 }, 1)!;
    expect(applyMindDecision(world, creature.id, plan("eat", hidden.id))).toBe(false);
    apple.amount = 0;
    expect(applyMindDecision(world, creature.id, plan("eat", apple.id))).toBe(false);
    apple.amount = 1;
    world.time += 361;
    expect(applyMindDecision(world, creature.id, plan("eat", apple.id))).toBe(false);
  });

  it("accepts only memories in the offered slice, sanitizes bounded text, and consumes its offer", () => {
    const world = hatch();
    const creature = world.creatures[0]!;
    stepWorld(world, 0.1);
    for (let index = 0; index < 20; index++)
      remember(world, creature, "experience", `experience ${index}`);
    const context = getMindContext(world, creature.id)!;
    const old = creature.memories.find(
      (memory) => !context.memories.some((offered) => offered.id === memory.id),
    )!;
    expect(context.memories).toHaveLength(16);
    expect(applyMindDecision(world, creature.id, plan("rest", undefined, [old.id]))).toBe(false);
    const late = remember(world, creature, "experience", "created after the offer");
    expect(applyMindDecision(world, creature.id, plan("rest", undefined, [late.id]))).toBe(false);
    const memoryIds = context.memories.slice(-2).map((memory) => memory.id);
    expect(
      applyMindDecision(world, creature.id, {
        ...plan("rest", undefined, memoryIds),
        thought: "x\n".repeat(200),
        reason: "r".repeat(600),
        speech: "s".repeat(500),
      }),
    ).toBe(true);
    expect(creature.intention.source).toBe("model");
    expect(creature.intention.text.length).toBeLessThanOrEqual(140);
    expect(creature.intention.reason.length).toBeLessThanOrEqual(200);
    expect(creature.utterance!.text.length).toBeLessThanOrEqual(120);
    expect(creature.intention.text).not.toContain("\n");
    expect(creature.intention.memoryIds).toEqual(memoryIds);
    expect(applyMindDecision(world, creature.id, plan("rest"))).toBe(false);
  });

  it("protects urgent needs both when a model response arrives and during an accepted plan", () => {
    const world = hatch();
    const creature = world.creatures[0]!;
    stepWorld(world, 0.1);
    const apple = world.objects.find((item) => item.kind === "apple")!;
    creature.needs.food = 3;
    getMindContext(world, creature.id);
    expect(applyMindDecision(world, creature.id, plan("rest"))).toBe(false);
    expect(applyMindDecision(world, creature.id, plan("eat", apple.id))).toBe(true);
    creature.needs.food = 80;
    getMindContext(world, creature.id);
    expect(applyMindDecision(world, creature.id, plan("rest"))).toBe(true);
    creature.needs.food = 3;
    stepWorld(world, 0.1);
    expect(creature.intention.action).toBe("eat");
    expect(creature.intention.source).toBe("local");
    creature.alive = false;
    expect(getMindContext(world, creature.id)).toBeNull();
    expect(applyMindDecision(world, creature.id, plan("eat", apple.id))).toBe(false);
  });
});

describe("bounded population, collections, and command feedback", () => {
  it("stays at capacity 8 by default, can expand to 64, and caps its stored collections", () => {
    const world = hatch();
    const forceComfort = () => {
      for (const creature of world.creatures) {
        satisfied(creature);
        creature.contentmentTime = 110;
        creature.bornAt = world.time - 120;
        creature.lastReplicatedAt = world.time - 120;
      }
      stepWorld(world, 0.1);
    };
    for (let index = 0; index < 7; index++) forceComfort();
    expect(world.creatures.filter((creature) => creature.alive)).toHaveLength(8);
    for (const capacity of [16, 32, 64]) {
      expect(applyCommand(world, { type: "capacity" }).ok).toBe(true);
      expect(world.capacity).toBe(capacity);
      for (let index = 0; index < 7; index++) forceComfort();
    }
    expect(world.creatures.filter((creature) => creature.alive)).toHaveLength(64);
    expect(applyCommand(world, { type: "capacity" }).ok).toBe(false);
    for (let index = 0; index < 100; index++)
      applyCommand(world, { type: "message", text: `Public observation ${index}` });
    for (let index = 0; index < 200; index++)
      applyCommand(world, { type: "care", tool: "feed", position: { x: 16, y: 12 } });
    advance(world, 2);
    expect(world.events.length).toBeLessThanOrEqual(LIMITS.events);
    expect(world.collective.messages.length).toBeLessThanOrEqual(LIMITS.messages);
    expect(world.objects.length).toBeLessThanOrEqual(LIMITS.objects);
    expect(world.collective.lexicon.length).toBeLessThanOrEqual(LIMITS.lexicon);
    for (const creature of world.creatures) {
      expect(creature.memories.length).toBeLessThanOrEqual(LIMITS.memories);
      expect(creature.beliefs.length).toBeLessThanOrEqual(LIMITS.beliefs);
      expect(creature.relationships.length).toBeLessThanOrEqual(LIMITS.relationships);
      for (const value of Object.values(creature.needs)) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(100);
      }
    }
  });

  it("failed commands give useful feedback and do not silently create structures or resources", () => {
    const egg = createWorld();
    expect(
      applyCommand(egg, { type: "care", tool: "feed", position: { x: 16, y: 12 } }).message,
    ).toContain("Hatch");
    const world = hatch();
    const before = structuredClone(world.resources);
    const failed = [
      applyCommand(world, { type: "build", kind: "feeder", position: { x: 20, y: 10 } }),
      applyCommand(world, { type: "care", tool: "feed", position: { x: Number.NaN, y: 10 } }),
      applyCommand(world, { type: "care", tool: "wash", position: { x: 2, y: 2 } }),
      applyCommand(world, {
        type: "care",
        tool: "pet",
        position: { x: 16, y: 12 },
        creatureId: "missing",
      }),
      applyCommand(world, { type: "message", text: "   " }),
    ];
    for (const result of failed) {
      expect(result.ok).toBe(false);
      expect(result.message.length).toBeGreaterThan(10);
    }
    expect(world.objects.some((item) => item.kind === "feeder")).toBe(false);
    expect(world.resources).toEqual(before);
  });
});
