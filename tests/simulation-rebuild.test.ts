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
  makeCreature,
  object,
  remember,
  VISION,
} from "../server/simulation-core.js";
import { commandSchema } from "../server/validation.js";

function hatch(): WorldState {
  const world = createWorld(31415);
  expect(applyCommand(world, { type: "hatch" }).ok).toBe(true);
  return world;
}
function advance(world: WorldState, seconds: number): void {
  for (let tick = 0; tick < Math.round(seconds * 10); tick++) stepWorld(world, 0.1);
}
function calm(creature: Creature): void {
  creature.needs = { food: 90, clean: 90, joy: 90, rest: 90, social: 90 };
}
function decision(extra: Partial<MindDecision> = {}): MindDecision {
  return {
    action: "rest",
    thought: "Pause and consider what happened.",
    reason: "The body has no urgent need.",
    memoryIds: [],
    ...extra,
  };
}
function lossScene() {
  const world = hatch();
  world.objects = [];
  const witness = world.creatures[0]!;
  const victim = makeCreature(world, { x: 16.5, y: 12 });
  const distant = makeCreature(world, { x: 28, y: 21 });
  for (const creature of world.creatures) calm(creature);
  return { world, witness, victim, distant };
}

describe("individual squash actions and witnessed consequences", () => {
  it("validates only an individual care command, with no bulk kill shape", () => {
    expect(
      commandSchema.safeParse({ type: "care", tool: "kill", position: { x: 16, y: 12 } }).success,
    ).toBe(true);
    expect(commandSchema.safeParse({ type: "kill", all: true }).success).toBe(false);
    expect(
      commandSchema.safeParse({ type: "care", tool: "kill", position: { x: 16, y: 12 }, all: true })
        .success,
    ).toBe(false);
  });
  it("kills only the selected creature and gives nearby witnesses durable player responsibility", () => {
    const { world, witness, victim, distant } = lossScene();
    const remoteBefore = structuredClone(distant);
    const objectsBefore = structuredClone(world.objects);
    const resourcesBefore = structuredClone(world.resources);
    const trust = world.collective.trust;
    victim.carried = { kind: "wood", amount: 3 };
    victim.modelPending = true;
    getMindContext(world, victim.id);
    getMindContext(world, witness.id);
    const result = applyCommand(world, {
      type: "care",
      tool: "kill",
      position: witness.position,
      creatureId: victim.id,
    });
    expect(result).toMatchObject({ ok: true, creatureId: victim.id });
    expect(victim.alive).toBe(false);
    expect(victim.health).toBe(0);
    expect(victim.action).toBe("idle");
    expect(victim.modelPending).toBe(false);
    expect(victim.carried).toBeUndefined();
    expect(witness.alive).toBe(true);
    expect(world.stats.deaths).toBe(1);
    expect(world.stats.playerKills).toBe(1);
    expect(world.objects).toEqual(objectsBefore);
    expect(world.resources).toEqual(resourcesBefore);
    expect(distant).toEqual(remoteBefore);
    const memory = witness.memories.find((entry) => entry.kind === "loss")!;
    expect(memory).toMatchObject({
      actor: "player",
      sourceId: "player",
      subjectId: victim.id,
      importance: 100,
    });
    expect(memory.position).toEqual(victim.position);
    expect(memory.text).toContain(victim.name);
    expect(world.collective.trust).toBeLessThan(trust);
    expect(world.collective.fear).toBeGreaterThan(0);
    expect(world.collective.grief).toBeGreaterThan(0);
    expect(witness.needs.joy).toBeLessThan(90);
    expect(getMindContext(world, victim.id)).toBeNull();
    expect(applyMindDecision(world, victim.id, decision())).toBe(false);
    expect(applyMindDecision(world, witness.id, decision())).toBe(false);
    stepWorld(world, 0.1);
    expect(witness.intention.action).toBe("walk");
    expect(witness.intention.memoryIds).toContain(memory.id);
    expect(witness.intention.reason).toContain("witnessed");
  });
  it("uses the nearest living creature only and rejects misses, stale IDs, and distant selected targets", () => {
    const { world, witness, victim } = lossScene();
    const before = structuredClone(world);
    expect(applyCommand(world, { type: "care", tool: "kill", position: { x: 2, y: 2 } }).ok).toBe(
      false,
    );
    expect(
      applyCommand(world, {
        type: "care",
        tool: "kill",
        position: { x: 2, y: 2 },
        creatureId: victim.id,
      }).ok,
    ).toBe(false);
    expect(
      applyCommand(world, {
        type: "care",
        tool: "kill",
        position: home(world),
        creatureId: "missing",
      }).ok,
    ).toBe(false);
    expect(world).toEqual(before);
    const result = applyCommand(world, {
      type: "care",
      tool: "kill",
      position: { x: 16.45, y: 12 },
    });
    expect(result).toMatchObject({ ok: true, creatureId: victim.id });
    expect(witness.alive).toBe(true);
    const after = structuredClone(world);
    expect(
      applyCommand(world, {
        type: "care",
        tool: "kill",
        position: home(world),
        creatureId: victim.id,
      }).ok,
    ).toBe(false);
    expect(world).toEqual(after);
  });
  it("does not tell distant creatures or invent a collective witness when the kill was unseen", () => {
    const { world, witness, victim, distant } = lossScene();
    witness.position = { x: 2, y: 2 };
    distant.position = { x: 28, y: 21 };
    const witnessBefore = structuredClone(witness);
    const distantBefore = structuredClone(distant);
    const messages = world.collective.messages.length;
    expect(
      applyCommand(world, {
        type: "care",
        tool: "kill",
        position: victim.position,
        creatureId: victim.id,
      }).ok,
    ).toBe(true);
    expect(witness).toEqual(witnessBefore);
    expect(distant).toEqual(distantBefore);
    expect(world.collective.trust).toBe(50);
    expect(world.collective.fear).toBe(0);
    expect(world.collective.grief).toBe(0);
    expect(world.collective.messages).toHaveLength(messages);
    expect(world.stats.playerKills).toBe(1);
  });
  it("retains witnessed loss and model lessons through unrelated memories, serialization, and ordinary care", () => {
    const { world, witness, victim } = lossScene();
    world.cognitionMode = "model";
    applyCommand(world, {
      type: "care",
      tool: "kill",
      position: victim.position,
      creatureId: victim.id,
    });
    const loss = witness.memories.find((memory) => memory.kind === "loss")!;
    getMindContext(world, witness.id);
    expect(
      applyMindDecision(
        world,
        witness.id,
        decision({
          goal: "Keep some distance.",
          lesson: "The player caused the loss I witnessed.",
          memoryIds: [loss.id],
        }),
      ),
    ).toBe(true);
    const lesson = witness.memories.find((memory) => memory.text.startsWith("Model lesson:"))!;
    expect(lesson).toMatchObject({ kind: "reflection", actor: "creature", sourceId: witness.id });
    expect(lesson.text).toContain(loss.id);
    for (let index = 0; index < 100; index++)
      remember(world, witness, "experience", `Routine observation ${index}`, { importance: 35 });
    applyCommand(world, {
      type: "care",
      tool: "wash",
      position: witness.position,
      creatureId: witness.id,
    });
    applyCommand(world, {
      type: "care",
      tool: "pet",
      position: witness.position,
      creatureId: witness.id,
    });
    expect(witness.memories).toHaveLength(48);
    const restored = JSON.parse(JSON.stringify(world)) as WorldState;
    const context = getMindContext(restored, witness.id)!;
    expect(context.memories.some((memory) => memory.id === loss.id)).toBe(true);
    expect(context.memories.some((memory) => memory.id === lesson.id)).toBe(true);
    expect(context.cognition?.lesson).toBe("The player caused the loss I witnessed.");
    expect(restored.stats.playerKills).toBe(1);
    expect(restored.collective.trust).toBeLessThan(30);
    const before = restored.collective.fear!;
    advance(restored, 2);
    expect(restored.collective.fear).toBeLessThan(before);
    expect(restored.collective.fear).toBeGreaterThan(0);
  });
  it("distinguishes a sustained environmental death from a player squash", () => {
    const { world, witness, victim } = lossScene();
    victim.health = 0.001;
    victim.needs.food = 0;
    victim.needs.clean = 0;
    victim.needs.rest = 0;
    stepWorld(world, 0.1);
    expect(victim.alive).toBe(false);
    expect(world.stats.deaths).toBe(1);
    expect(world.stats.playerKills).toBe(0);
    expect(world.collective.trust).toBe(50);
    expect(world.collective.fear).toBe(0);
    expect(world.collective.grief).toBeGreaterThan(0);
    expect(witness.memories.find((memory) => memory.kind === "loss")).toMatchObject({
      actor: "environment",
      sourceId: "environment",
      subjectId: victim.id,
    });
  });
});

describe("accepted model intent and truthful terminal behavior", () => {
  it("persists bounded goal and evidence-backed lesson, and publishes accepted model speech", () => {
    const world = hatch();
    world.cognitionMode = "model";
    const creature = world.creatures[0]!;
    calm(creature);
    const evidence = remember(world, creature, "experience", "Eating an apple improved my food.", {
      need: "food",
      delta: 30,
      actor: "creature",
      sourceId: creature.id,
    });
    getMindContext(world, creature.id);
    expect(
      applyMindDecision(
        world,
        creature.id,
        decision({
          goal: "g".repeat(300),
          lesson: "l".repeat(400),
          speech: "I remember the apple I ate.",
          memoryIds: [evidence.id],
        }),
      ),
    ).toBe(true);
    expect(creature.cognition).toMatchObject({
      goal: "g".repeat(180),
      lesson: "l".repeat(240),
      lastReasonedAt: world.time,
      decisions: 1,
    });
    expect(
      creature.memories.find((memory) => memory.text.startsWith("Model lesson:"))?.text,
    ).toContain(evidence.id);
    expect(world.collective.messages.at(-1)).toMatchObject({
      speaker: "throng",
      source: "model",
      text: `${creature.name}: I remember the apple I ate.`,
    });
    getMindContext(world, creature.id);
    expect(
      applyMindDecision(world, creature.id, decision({ goal: "Watch what happens next." })),
    ).toBe(true);
    expect(creature.cognition?.decisions).toBe(2);
    expect(creature.cognition?.lesson).toBe("l".repeat(240));
    expect(
      creature.memories.filter((memory) => memory.text.startsWith("Model lesson:")),
    ).toHaveLength(1);
  });
  it("rejects unsupported or uncited learned claims before mutating any state", () => {
    const world = hatch();
    const creature = world.creatures[0]!;
    calm(creature);
    getMindContext(world, creature.id);
    const before = structuredClone(world);
    const invalid: unknown[] = [
      decision({ lesson: "I learned something without citing it." }),
      decision({ lesson: "I learned something invented.", memoryIds: ["invented"] }),
      { ...decision(), goal: 7 },
      { ...decision(), lesson: null },
      decision({ goal: "  " }),
      { ...decision(), action: "kill", goal: "Attack." },
    ];
    for (const value of invalid) {
      expect(applyMindDecision(world, creature.id, value as MindDecision)).toBe(false);
      expect(world).toEqual(before);
    }
    expect(creature.cognition).toBeUndefined();
  });
  it("in model mode records player messages but emits no regex reply or fixed reflection", () => {
    const world = hatch();
    world.cognitionMode = "model";
    const creature = world.creatures[0]!;
    const before = world.collective.messages.length;
    expect(
      applyCommand(world, { type: "message", text: "Are you hungry? What did you learn?" }).ok,
    ).toBe(true);
    expect(world.collective.messages).toHaveLength(before + 1);
    expect(world.collective.messages.at(-1)).toMatchObject({ speaker: "player", source: "player" });
    advance(world, 40);
    expect(creature.learningCount).toBeGreaterThan(0);
    expect(creature.memories.some((memory) => memory.kind === "reflection")).toBe(false);
    expect(creature.cognition).toBeUndefined();
    expect(world.collective.messages.some((message) => message.source === "model")).toBe(false);
    const local = hatch();
    const count = local.collective.messages.length;
    applyCommand(local, { type: "message", text: "Are you hungry?" });
    expect(local.collective.messages).toHaveLength(count + 2);
    expect(local.collective.messages.at(-1)?.source).toBe("local");
    advance(local, 40);
    expect(local.creatures[0]!.memories.some((memory) => memory.kind === "reflection")).toBe(true);
  });
  it("lets a hungry model plan explore when no food is known, then locally responds to newly visible food", () => {
    const world = hatch();
    world.objects = [];
    const creature = world.creatures[0]!;
    calm(creature);
    creature.needs.food = 3;
    getMindContext(world, creature.id);
    expect(
      applyMindDecision(
        world,
        creature.id,
        decision({ action: "walk", goal: "Search the nearby grass for food." }),
      ),
    ).toBe(true);
    stepWorld(world, 0.1);
    expect(creature.intention.source).toBe("model");
    expect(creature.intention.action).toBe("walk");
    const apple = object(
      world,
      "apple",
      { x: creature.position.x + 0.5, y: creature.position.y },
      1,
    )!;
    stepWorld(world, 0.1);
    expect(creature.intention.action).toBe("eat");
    expect(creature.intention.targetId).toBe(apple.id);
    expect(creature.intention.source).toBe("local");
    getMindContext(world, creature.id);
    expect(applyMindDecision(world, creature.id, decision({ action: "walk" }))).toBe(false);
  });
});

describe("explicit memory sharing is private and attributable", () => {
  it("shares an owned offered loss with a visible peer without granting distant world knowledge", () => {
    const { world, witness, victim, distant } = lossScene();
    world.cognitionMode = "model";
    applyCommand(world, {
      type: "care",
      tool: "kill",
      position: victim.position,
      creatureId: victim.id,
    });
    expect(distant.memories.some((memory) => memory.kind === "loss")).toBe(false);
    const loss = witness.memories.find((memory) => memory.kind === "loss")!;
    distant.position = { x: 17, y: 12 };
    const beliefsBefore = structuredClone(distant.beliefs);
    const needsBefore = distant.needs.joy;
    getMindContext(world, witness.id);
    expect(
      applyMindDecision(
        world,
        witness.id,
        decision({
          goal: "Tell my neighbor what I witnessed.",
          share: { memoryId: loss.id, recipientId: distant.id },
        }),
      ),
    ).toBe(true);
    const received = distant.memories.find(
      (memory) => memory.sourceId === witness.id && memory.subjectId === victim.id,
    )!;
    expect(received).toMatchObject({
      kind: "social",
      actor: "player",
      sourceId: witness.id,
      subjectId: victim.id,
    });
    expect(received.text).toContain(loss.id);
    expect(received.position).toEqual(loss.position);
    expect(received.position).not.toBe(loss.position);
    expect(distant.beliefs).toEqual(beliefsBefore);
    expect(distant.needs.joy).toBeLessThan(needsBefore);
    expect(world.stats.playerKills).toBe(1);
    expect(world.collective.sharedKnowledge).toBe(1);
    getMindContext(world, witness.id);
    expect(
      applyMindDecision(
        world,
        witness.id,
        decision({ share: { memoryId: loss.id, recipientId: distant.id } }),
      ),
    ).toBe(true);
    expect(world.collective.sharedKnowledge).toBe(1);
  });
  it("rejects forged, unoffered, forgotten, distant, dead, or self recipient shares atomically", () => {
    const world = hatch();
    world.objects = [];
    const sender = world.creatures[0]!;
    calm(sender);
    const recipient = makeCreature(world, { x: 16.8, y: 12 });
    calm(recipient);
    const foreign = remember(world, recipient, "experience", "A private observation.");
    const own = remember(world, sender, "experience", "My observation.");
    for (let index = 0; index < 22; index++)
      remember(world, sender, "experience", `Other observation ${index}`, { importance: 25 });
    const context = getMindContext(world, sender.id)!;
    const offered = context.memories[0]!;
    const unoffered = sender.memories.find(
      (memory) => !context.memories.some((entry) => entry.id === memory.id),
    )!;
    const before = structuredClone(world);
    const invalid = [
      decision({ share: { memoryId: foreign.id, recipientId: recipient.id } }),
      decision({ share: { memoryId: unoffered.id, recipientId: recipient.id } }),
      decision({ share: { memoryId: "fabricated", recipientId: recipient.id } }),
      decision({ share: { memoryId: offered.id, recipientId: sender.id } }),
      { ...decision(), share: { memoryId: offered.id, recipientId: recipient.id, all: true } },
    ];
    for (const candidate of invalid) {
      expect(applyMindDecision(world, sender.id, candidate as MindDecision)).toBe(false);
      expect(world).toEqual(before);
    }
    recipient.position = { x: 30, y: 22 };
    const far = structuredClone(world);
    expect(
      applyMindDecision(
        world,
        sender.id,
        decision({ share: { memoryId: offered.id, recipientId: recipient.id } }),
      ),
    ).toBe(false);
    expect(world).toEqual(far);
    recipient.position = { x: 16.8, y: 12 };
    recipient.alive = false;
    const dead = structuredClone(world);
    expect(
      applyMindDecision(
        world,
        sender.id,
        decision({ share: { memoryId: offered.id, recipientId: recipient.id } }),
      ),
    ).toBe(false);
    expect(world).toEqual(dead);
    recipient.alive = true;
    getMindContext(world, sender.id);
    sender.memories = sender.memories.filter((memory) => memory.id !== own.id);
    const forgotten = structuredClone(world);
    expect(
      applyMindDecision(
        world,
        sender.id,
        decision({ share: { memoryId: own.id, recipientId: recipient.id } }),
      ),
    ).toBe(false);
    expect(world).toEqual(forgotten);
  });
});

describe("new-world initialization and compatible bounded context", () => {
  it("starts a clean grass clearing with serial names and never rewrites a prior colony", () => {
    const existing = hatch();
    existing.creatures[0]!.name = "An existing name";
    const before = structuredClone(existing);
    const fresh = createWorld(8080);
    expect(fresh.id).not.toBe(existing.id);
    expect(fresh.cognitionMode).toBe("local");
    expect(fresh.stage).toBe("egg");
    expect(fresh.creatures).toHaveLength(0);
    expect(fresh.collective.fear).toBe(0);
    expect(fresh.collective.grief).toBe(0);
    for (const item of fresh.objects.filter((item) => item.kind === "tree" || item.kind === "rock"))
      expect(distance(item.position, home(fresh))).toBeGreaterThan(4);
    for (const item of fresh.objects.filter(
      (item) => item.kind === "apple" || item.kind === "ball",
    ))
      expect(distance(item.position, home(fresh))).toBeLessThan(2.2);
    applyCommand(fresh, { type: "hatch" });
    const second = makeCreature(fresh, { x: 17, y: 12 });
    expect(fresh.creatures[0]!.name).toBe("T-001");
    expect(second.name).toBe("T-002");
    expect(second.id).not.toBe(fresh.creatures[0]!.id);
    expect(existing).toEqual(before);
  });
  it("returns own bounded body, learning and relationships, ranked memories, and last three player messages", () => {
    const world = hatch();
    world.cognitionMode = "model";
    const creature = world.creatures[0]!;
    calm(creature);
    creature.preferences.apple = 14;
    creature.rewards.eat = { count: 2, mean: 0.4 };
    creature.carried = { kind: "wood", amount: 2 };
    creature.relationships = [
      { id: "known-friend", familiarity: 30, trust: 60, lastMet: 0, shared: 1 },
    ];
    for (let index = 0; index < 30; index++)
      remember(world, creature, "experience", `Observation ${index}`, { importance: 30 });
    const relevant = remember(world, creature, "experience", "Food from a place I know.", {
      need: "food",
      importance: 55,
    });
    creature.needs.food = 22;
    for (let index = 0; index < 5; index++)
      applyCommand(world, { type: "message", text: `Public message ${index}` });
    const context = getMindContext(world, creature.id)!;
    expect(context.memories).toHaveLength(16);
    expect(context.memories.some((memory) => memory.id === relevant.id)).toBe(true);
    expect(context.memories.map((memory) => memory.at)).toEqual(
      [...context.memories.map((memory) => memory.at)].sort((a, b) => a - b),
    );
    expect(context.body).toMatchObject({
      position: creature.position,
      health: 100,
      age: 0,
      generation: 0,
      carried: { kind: "wood", amount: 2 },
    });
    expect(context.preferences).toEqual({ apple: 14 });
    expect(context.rewards?.eat).toEqual({ count: 2, mean: 0.4 });
    expect(context.relationships).toEqual(creature.relationships);
    expect(context.playerMessages).toEqual([
      "Public message 2",
      "Public message 3",
      "Public message 4",
    ]);
    context.body!.position.x = 1;
    context.relationships![0]!.trust = 0;
    context.preferences!.apple = -100;
    expect(creature.position.x).toBe(16);
    expect(creature.relationships[0]!.trust).toBe(60);
    expect(creature.preferences.apple).toBe(14);
  });
  it("loads synthetic legacy state without new optional fields and preserves names and IDs", () => {
    const world = hatch();
    const other = makeCreature(world, { x: 16.6, y: 12 });
    const first = world.creatures[0]!;
    first.name = "Legacy name";
    const old = JSON.parse(JSON.stringify(world)) as WorldState;
    delete old.cognitionMode;
    delete old.collective.fear;
    delete old.collective.grief;
    delete old.stats.playerKills;
    for (const creature of old.creatures) {
      delete creature.cognition;
      for (const memory of creature.memories) delete memory.actor;
    }
    stepWorld(old, 0.1);
    expect(old.id).toBe(world.id);
    expect(old.version).toBe(1);
    expect(old.creatures[0]!.name).toBe("Legacy name");
    expect(old.creatures[0]!.id).toBe(first.id);
    expect(
      applyCommand(old, {
        type: "care",
        tool: "kill",
        position: other.position,
        creatureId: other.id,
      }).ok,
    ).toBe(true);
    expect(old.stats.playerKills).toBe(1);
    expect(
      getMindContext(old, first.id)!.memories.some(
        (memory) => memory.actor === "player" && memory.kind === "loss",
      ),
    ).toBe(true);
  });
});

describe("model-chosen exploration destinations", () => {
  it("accepts an interior walk destination without teleporting or drawing a random alternative", () => {
    const world = hatch();
    const creature = world.creatures[0]!;
    calm(creature);
    const context = getMindContext(world, creature.id)!;
    expect(context.bounds).toEqual({ width: 32, height: 24 });
    const start = { ...creature.position };
    const rng = world.rng;
    const destination = { x: 24, y: 15 };
    expect(
      applyMindDecision(
        world,
        creature.id,
        decision({ action: "walk", destination, goal: "Explore the eastern grass." }),
      ),
    ).toBe(true);
    expect(creature.position).toEqual(start);
    expect(creature.intention.destination).toEqual(destination);
    expect(creature.intention.destination).not.toBe(destination);
    expect(world.rng).toBe(rng);
    stepWorld(world, 0.1);
    expect(distance(creature.position, start)).toBeGreaterThan(0);
    expect(distance(creature.position, start)).toBeLessThan(0.3);
    for (let tick = 0; tick < 100 && !creature.rewards.walk; tick++) stepWorld(world, 0.1);
    expect(creature.rewards.walk?.count).toBe(1);
    expect(distance(creature.position, destination)).toBeLessThanOrEqual(0.16);
    context.bounds!.width = 1000;
    expect(world.width).toBe(32);
  });
  it("rejects invalid or conflicting destinations before any mutation and retains the omitted-destination fallback", () => {
    const world = hatch();
    const creature = world.creatures[0]!;
    calm(creature);
    stepWorld(world, 0.1);
    const context = getMindContext(world, creature.id)!;
    const target = context.beliefs[0]!.objectId;
    const before = structuredClone(world);
    const invalid: unknown[] = [
      decision({ action: "rest", destination: { x: 10, y: 10 } }),
      decision({ action: "walk", targetId: target, destination: { x: 10, y: 10 } }),
      decision({ action: "walk", destination: { x: 0, y: 10 } }),
      decision({ action: "walk", destination: { x: 32, y: 10 } }),
      decision({ action: "walk", destination: { x: 10, y: 24 } }),
      decision({ action: "walk", destination: { x: NaN, y: 10 } }),
      decision({ action: "walk", destination: { x: 10, y: Infinity } }),
      { ...decision({ action: "walk" }), destination: null },
      { ...decision({ action: "walk" }), destination: { x: 10, y: 10, teleport: true } },
    ];
    for (const value of invalid) {
      expect(applyMindDecision(world, creature.id, value as MindDecision)).toBe(false);
      expect(world).toEqual(before);
    }
    expect(applyMindDecision(world, creature.id, decision({ action: "walk" }))).toBe(true);
    expect(creature.intention.destination).toBeDefined();
    expect(world.rng).not.toBe(before.rng);
  });
});

it("a witness at the field corner retreats along the boundary rather than finishing immobile walks", () => {
  const world = hatch();
  world.objects = [];
  const witness = world.creatures[0]!;
  witness.position = { x: 1, y: 1 };
  calm(witness);
  const victim = makeCreature(world, { x: 1.6, y: 1.6 });
  expect(
    applyCommand(world, {
      type: "care",
      tool: "kill",
      position: victim.position,
      creatureId: victim.id,
    }).ok,
  ).toBe(true);
  advance(world, 1);
  expect(distance(witness.position, { x: 1, y: 1 })).toBeGreaterThan(1);
  expect(witness.position.x).toBeGreaterThanOrEqual(1);
  expect(witness.position.y).toBeGreaterThanOrEqual(1);
  expect(witness.rewards.walk?.count ?? 0).toBeLessThan(2);
});
