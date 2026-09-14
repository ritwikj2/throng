import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Creature, MindContext, MindDecision, WorldState } from "../shared/types";
import {
  createWorld,
  applyCommand,
  stepWorld,
  getMindContext,
  applyMindDecision,
} from "../server/simulation";
import { createCognition, readBrainConfig } from "../server/cognition";
import type {
  BrainConfig,
  Cognition,
  CognitionBudget,
  CognitionClock,
  CognitionEngine,
} from "../server/cognition";
import type { CognitionClient } from "../server/cognition-providers";
import { projectMindContext, validateMindDecision } from "../server/cognition-protocol";

const instances: Cognition[] = [];
const testClock: CognitionClock = {
  now: () => Date.now(),
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
const settle = async (): Promise<void> => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};
function world(count = 4, id = "world-a"): WorldState {
  const result = createWorld(42);
  applyCommand(result, { type: "hatch" });
  const original = result.creatures[0]!;
  result.id = id;
  result.creatures = Array.from({ length: count }, (_, i) => ({
    ...structuredClone(original),
    id: `creature-${i}`,
    name: `Creature ${i}`,
    lastModelAt: 0,
    modelPending: false,
  }));
  result.time = 100;
  return result;
}
function contextFor(w: WorldState, id: string): MindContext {
  const creature = w.creatures.find((candidate) => candidate.id === id)!;
  return {
    worldId: w.id,
    creatureId: id,
    at: w.time,
    name: creature.name,
    needs: { food: 70, clean: 70, joy: 70, rest: 40, social: 70 },
    traits: creature.traits,
    intention: creature.intention,
    memories: [
      {
        id: `${id}-memory`,
        at: 20,
        kind: "experience",
        text: "Rest helped before.",
        importance: 5,
        valence: 1,
      },
    ],
    beliefs: [
      {
        objectId: "known-apple",
        kind: "apple",
        position: { x: 4, y: 4 },
        confidence: 0.8,
        learnedAt: 15,
        source: "seen",
      },
    ],
    neighbors: [{ id: "known-friend", name: "Nearby", action: "rest", familiarity: 40 }],
    availableActions: ["rest", "walk", "eat", "socialize"],
    playerMessages: [],
  };
}
function decision(context: MindContext): MindDecision {
  return {
    action: "rest",
    thought: "A short rest would help.",
    reason: "Rest is my least satisfied need.",
    memoryIds: context.memories.slice(0, 1).map((memory) => memory.id),
  };
}
function config(overrides: Partial<BrainConfig> = {}): BrainConfig {
  return {
    ...readBrainConfig({
      THRONG_BRAIN: "openai",
      THRONG_MODEL: "fixture-model",
      OPENAI_API_KEY: "TEST_ONLY_SECRET",
    }),
    ...overrides,
  };
}
interface Request {
  context: MindContext;
  signal: AbortSignal;
  resolve(value: unknown): void;
  reject(reason: unknown): void;
}
function harness(
  options: {
    count?: number;
    config?: BrainConfig;
    budget?: CognitionBudget;
    engine?: CognitionEngine;
  } = {},
) {
  const requests: Request[] = [];
  const w = world(options.count);
  const engine = options.engine ?? {
    getMindContext: vi.fn(contextFor),
    applyMindDecision: vi.fn(() => true),
  };
  const client: CognitionClient = {
    decide: vi.fn(
      (context, signal) =>
        new Promise((resolve, reject) => requests.push({ context, signal, resolve, reject })),
    ),
  };
  const budget = options.budget ?? { attempts: [], inFlight: 0 };
  const cognition = createCognition(options.config ?? config(), {
    client,
    engine,
    budget,
    clock: testClock,
  });
  instances.push(cognition);
  return { w, cognition, client, engine, requests, budget };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("Network is disabled in cognition tests"))),
  );
});
afterEach(async () => {
  for (const cognition of instances.splice(0)) cognition.stop();
  await settle();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("server-only configuration", () => {
  it("defaults to local despite ambient keys, model, and custom endpoints", async () => {
    const value = readBrainConfig({
      OPENAI_API_KEY: "SECRET_A",
      ANTHROPIC_API_KEY: "SECRET_B",
      AWS_REGION: "us-east-1",
      THRONG_MODEL: "remote-model",
      OPENAI_BASE_URL: "https://unexpected.example/v1",
    });
    expect(value.provider).toBe("local");
    expect(value.model).toBeNull();
    expect(JSON.stringify(value)).not.toMatch(/SECRET_|unexpected/);
    const h = harness({ config: value });
    h.cognition.tick(h.w);
    await settle();
    expect(h.client.decide).not.toHaveBeenCalled();
    expect(h.cognition.status()).toMatchObject({
      provider: "local",
      label: "Local learned policy",
      pending: 0,
      ready: true,
      budgetPerMinute: 6,
    });
  });
  it("reads the agreed quota name and refuses invalid numeric/model/provider settings safely", async () => {
    expect(
      readBrainConfig({
        THRONG_BRAIN: "openai",
        OPENAI_API_KEY: "S",
        THRONG_MODEL: "fixture",
        THRONG_CALLS_PER_MINUTE: "9",
      }).callsPerMinute,
    ).toBe(9);
    const value = readBrainConfig({
      THRONG_BRAIN: "openai",
      OPENAI_API_KEY: "SECRET",
      THRONG_CALLS_PER_MINUTE: "Infinity_SECRET",
    });
    const h = harness({ config: value });
    h.cognition.tick(h.w);
    await settle();
    expect(h.requests).toHaveLength(0);
    expect(h.cognition.status().ready).toBe(false);
    expect(JSON.stringify(h.cognition.status())).not.toContain("SECRET");
    expect(readBrainConfig({ THRONG_BRAIN: "malformed_SECRET" }).configurationError).not.toContain(
      "SECRET",
    );
  });
  it("requires explicit model and region for Bedrock, not an API key", () => {
    expect(
      readBrainConfig({
        THRONG_BRAIN: "bedrock",
        THRONG_MODEL: "us.anthropic.fixture",
        AWS_REGION: "us-east-1",
      }),
    ).toMatchObject({ configurationError: null, provider: "bedrock", awsRegion: "us-east-1" });
    expect(
      readBrainConfig({ THRONG_BRAIN: "bedrock", THRONG_MODEL: "fixture" }).configurationError,
    ).toContain("AWS_REGION");
  });
  it.each([
    "https://user:SECRET@example.com/v1",
    "https://example.com/v1?token=SECRET",
    "http://remote.example/v1",
    "file:///SECRET",
  ])("rejects unsafe custom endpoints without echoing them: %s", (url) => {
    const value = readBrainConfig({
      THRONG_BRAIN: "openai",
      THRONG_MODEL: "fixture",
      OPENAI_API_KEY: "TEST",
      OPENAI_BASE_URL: url,
    });
    expect(value.configurationError).toContain("OPENAI_BASE_URL");
    expect(value.configurationError).not.toContain("SECRET");
  });
});

describe("private context and fixed decision contract", () => {
  it("makes a bounded independent allowlist projection without neighbor/private extras", () => {
    const w = world(1);
    const input = contextFor(w, w.creatures[0]!.id);
    Object.assign(input.neighbors[0]!, {
      memories: [{ text: "FOREIGN_PRIVATE_MEMORY" }],
      apiKey: "FAKE_SECRET",
    });
    Object.assign(input, { creatures: [{ memories: ["GLOBAL_SECRET"] }], apiKey: "TOP_SECRET" });
    input.memories = Array.from({ length: 48 }, (_, i) => ({
      ...input.memories[0]!,
      id: `m-${i}`,
      text: "x".repeat(800),
    }));
    const result = projectMindContext(input);
    expect(result.memories).toHaveLength(16);
    expect(result.memories[0]!.text.length).toBe(320);
    expect(JSON.stringify(result)).not.toMatch(
      /FOREIGN_PRIVATE_MEMORY|FAKE_SECRET|GLOBAL_SECRET|TOP_SECRET/,
    );
    input.needs.food = 0;
    input.memories[47]!.text = "Changed after dispatch";
    expect(result.needs.food).toBe(70);
    expect(result.memories[15]!.text).not.toContain("Changed");
  });
  it.each([
    { action: "execute_code" },
    { targetId: "hidden-object" },
    { memoryIds: ["foreign-memory"] },
    { tool: "read_secret" },
    { thought: "x".repeat(161) },
    { reason: "" },
    { speech: "x".repeat(161) },
    { memoryIds: "not-an-array" },
  ])("rejects malformed or unsupported output %j", (override) => {
    const w = world(1);
    const context = contextFor(w, w.creatures[0]!.id);
    expect(() => validateMindDecision({ ...decision(context), ...override }, context)).toThrow();
  });
  it("accepts nullable optional fields and only submitted evidence", () => {
    const w = world(1);
    const context = contextFor(w, w.creatures[0]!.id);
    const result = validateMindDecision(
      JSON.stringify({ ...decision(context), targetId: null, speech: null }),
      context,
    );
    expect(result).toEqual(decision(context));
  });
});

describe("bounded wall-clock scheduling", () => {
  it("holds at most two slots, rotates fairly, and does not overwrite local actions while waiting", async () => {
    const h = harness();
    const prior = h.w.creatures.map((creature) => ({
      action: creature.action,
      intention: structuredClone(creature.intention),
    }));
    h.cognition.tick(h.w);
    await settle();
    expect(h.requests.map((request) => request.context.creatureId)).toEqual([
      "creature-0",
      "creature-1",
    ]);
    expect(h.cognition.status().pending).toBe(2);
    h.cognition.tick(h.w);
    await settle();
    expect(h.requests).toHaveLength(2);
    expect(
      h.w.creatures.map((creature) => ({ action: creature.action, intention: creature.intention })),
    ).toEqual(prior);
    for (const request of h.requests) request.resolve(decision(request.context));
    await settle();
    h.cognition.tick(h.w);
    await settle();
    expect(h.requests.slice(2).map((request) => request.context.creatureId)).toEqual([
      "creature-2",
      "creature-3",
    ]);
    expect(h.budget.inFlight).toBe(2);
    expect(h.engine.applyMindDecision).toHaveBeenCalledTimes(2);
  });
  it("applies the per-creature simulation interval even when quota is available", async () => {
    const h = harness({ count: 1 });
    h.cognition.tick(h.w);
    await settle();
    h.requests[0]!.resolve(decision(h.requests[0]!.context));
    await settle();
    h.w.time += 29;
    h.cognition.tick(h.w);
    await settle();
    expect(h.requests).toHaveLength(1);
    h.w.time += 1;
    h.cognition.tick(h.w);
    await settle();
    expect(h.requests).toHaveLength(2);
  });
  it("does not refill the rolling quota when simulation accelerates", async () => {
    const h = harness({ count: 12, config: config({ callsPerMinute: 3 }) });
    h.cognition.tick(h.w);
    await settle();
    for (const request of h.requests) request.resolve(decision(request.context));
    await settle();
    h.cognition.tick(h.w);
    await settle();
    h.requests[2]!.resolve(decision(h.requests[2]!.context));
    await settle();
    expect(h.cognition.status().calls).toBe(3);
    h.w.time += 10_000;
    h.w.speed = 12;
    h.cognition.tick(h.w);
    await settle();
    expect(h.cognition.status().calls).toBe(3);
    await vi.advanceTimersByTimeAsync(59_999);
    h.cognition.tick(h.w);
    await settle();
    expect(h.cognition.status().calls).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    h.cognition.tick(h.w);
    await settle();
    expect(h.cognition.status().calls).toBe(5);
    expect(h.requests.slice(3).map((request) => request.context.creatureId)).toEqual([
      "creature-3",
      "creature-4",
    ]);
  });
  it("shares quota and concurrency across runtime scheduler replacements", async () => {
    const budget = { attempts: [], inFlight: 0 };
    const a = harness({ budget, config: config({ callsPerMinute: 2 }) });
    a.cognition.tick(a.w);
    await settle();
    a.cognition.stop();
    const b = harness({ budget, config: config({ callsPerMinute: 2 }) });
    b.w.id = "world-b";
    b.cognition.tick(b.w);
    await settle();
    expect(b.requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60_000);
    b.cognition.tick(b.w);
    await settle();
    expect(b.requests).toHaveLength(2);
    expect(budget.inFlight).toBe(2);
  });
  it("times out even an abort-ignoring client, charges quota, and backs off without hidden retries", async () => {
    const h = harness({ count: 4 });
    h.cognition.tick(h.w);
    await settle();
    await vi.advanceTimersByTimeAsync(10_000);
    await settle();
    expect(h.requests.every((request) => request.signal.aborted)).toBe(true);
    expect(h.cognition.status()).toMatchObject({ calls: 2, failures: 2, pending: 0 });
    expect(h.cognition.status().lastError).toContain("timed out");
    h.cognition.tick(h.w);
    await settle();
    expect(h.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2_000);
    h.cognition.tick(h.w);
    await settle();
    expect(h.requests).toHaveLength(4);
    h.requests[0]!.resolve(decision(h.requests[0]!.context));
    await settle();
    expect(h.engine.applyMindDecision).not.toHaveBeenCalled();
  });
  it("redacts provider exceptions and treats malformed responses as fallback", async () => {
    const h = harness();
    h.cognition.tick(h.w);
    await settle();
    h.requests[0]!.reject(
      Object.assign(new Error("API_KEY=TEST_ONLY_SECRET and PRIVATE_PROMPT"), { status: 401 }),
    );
    h.requests[1]!.resolve("not JSON: TEST_ONLY_SECRET");
    await settle();
    expect(h.cognition.status()).toMatchObject({ failures: 2, pending: 0 });
    expect(JSON.stringify(h.cognition.status())).not.toMatch(
      /TEST_ONLY_SECRET|PRIVATE_PROMPT|API_KEY/,
    );
    expect(h.engine.applyMindDecision).not.toHaveBeenCalled();
    expect(h.w.creatures.every((creature) => !creature.modelPending)).toBe(true);
  });
});

describe("world and request lifecycle", () => {
  it.each(["stop", "pause", "death", "removed", "same-id-reload", "rewind", "stale"])(
    "discards results after %s",
    async (change) => {
      const h = harness({ count: 1 });
      h.cognition.tick(h.w);
      await settle();
      const request = h.requests[0]!;
      if (change === "stop") h.cognition.stop();
      if (change === "pause") h.w.paused = true;
      if (change === "death") h.w.creatures[0]!.alive = false;
      if (change === "removed") h.w.creatures = [];
      if (change === "same-id-reload") {
        h.w = structuredClone(h.w);
        h.cognition.tick(h.w);
      }
      if (change === "rewind") h.w.time = 50;
      if (change === "stale") h.w.time += 361;
      request.resolve(decision(request.context));
      await settle();
      expect(h.engine.applyMindDecision).not.toHaveBeenCalled();
      expect(h.cognition.status().pending).toBe(0);
      if (change === "stop") {
        h.cognition.tick(h.w);
        await settle();
        expect(h.requests).toHaveLength(1);
        expect(request.signal.aborted).toBe(true);
      }
    },
  );
  it("aborts pending plans on a paused tick and never revives them after resume", async () => {
    const h = harness({ count: 1 });
    h.cognition.tick(h.w);
    await settle();
    const request = h.requests[0]!;
    h.w.paused = true;
    h.cognition.tick(h.w);
    expect(request.signal.aborted).toBe(true);
    expect(h.cognition.status().pending).toBe(0);
    expect(h.w.creatures[0]!.modelPending).toBe(false);
    h.w.paused = false;
    h.cognition.tick(h.w);
    request.resolve(decision(request.context));
    await settle();
    expect(h.engine.applyMindDecision).not.toHaveBeenCalled();
    expect(h.requests).toHaveLength(1);
    expect(h.cognition.status().failures).toBe(0);
  });
  it("clears persisted pending flags because a save cannot contain a live request", () => {
    const h = harness({ count: 1, config: readBrainConfig({}) });
    h.w.creatures[0]!.modelPending = true;
    h.cognition.tick(h.w);
    expect(h.w.creatures[0]!.modelPending).toBe(false);
  });
  it("accepts a still-current decision after ordinary progress exactly once", async () => {
    const h = harness({ count: 1 });
    h.cognition.tick(h.w);
    await settle();
    h.w.time += 1;
    const request = h.requests[0]!;
    request.resolve(decision(request.context));
    request.resolve(decision(request.context));
    await settle();
    expect(h.engine.applyMindDecision).toHaveBeenCalledTimes(1);
    expect(h.cognition.status()).toMatchObject({ calls: 1, failures: 0, pending: 0 });
  });
  it("lets the real engine run body care while waiting and admits grounded model intentions", async () => {
    const w = createWorld(12);
    applyCommand(w, { type: "hatch" });
    const requests: Request[] = [];
    const cognition = createCognition(config(), {
      clock: testClock,
      budget: { attempts: [], inFlight: 0 },
      engine: { getMindContext, applyMindDecision },
      client: {
        decide: (context, signal) =>
          new Promise((resolve, reject) => requests.push({ context, signal, resolve, reject })),
      },
    });
    instances.push(cognition);
    cognition.tick(w);
    await settle();
    const creature: Creature = w.creatures[0]!;
    const before = { ...creature.needs };
    for (let i = 0; i < 10; i += 1) stepWorld(w, 0.1);
    expect(w.time).toBeGreaterThan(0);
    expect(creature.needs).not.toEqual(before);
    expect(creature.modelPending).toBe(true);
    requests[0]!.resolve({
      action: "rest",
      thought: "I could use a brief rest.",
      reason: "Rest supports my current needs.",
      memoryIds: [],
    });
    await settle();
    expect(creature.intention.source).toBe("model");
    expect(creature.modelPending).toBe(false);
  });
});
