import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MindContext, MindDecision, WorldState } from "../shared/types";
import { createCognition, readBrainConfig } from "../server/cognition";
import type { Cognition, CognitionClock } from "../server/cognition";
import {
  applyCommand,
  applyMindDecision,
  createWorld,
  getMindContext,
  stepWorld,
} from "../server/simulation";

interface PendingRequest {
  context: MindContext;
  signal: AbortSignal;
  resolve(value: unknown): void;
}

const instances: Cognition[] = [];
const clock: CognitionClock = {
  now: () => Date.now(),
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

// Explicitly settle the scheduler's promise chain; never sleep or poll real time.
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

function fixture() {
  const world = createWorld(42);
  expect(applyCommand(world, { type: "hatch" }).ok).toBe(true);
  stepWorld(world, 0.1); // Real perception and local action selection before a request.
  const creature = world.creatures[0]!;
  const requests: PendingRequest[] = [];
  const cognition = createCognition(
    readBrainConfig({
      THRONG_BRAIN: "openai",
      THRONG_MODEL: "offline-integration-fixture",
      OPENAI_API_KEY: "FAKE_INTEGRATION_KEY",
      THRONG_CALLS_PER_MINUTE: "1",
    }),
    {
      // These are the real exports, with no engine mocks or substituted contexts.
      engine: { getMindContext, applyMindDecision },
      client: {
        decide: (context, signal) =>
          new Promise((resolve) => requests.push({ context, signal, resolve })),
      },
      clock,
      budget: { attempts: [], inFlight: 0 },
    },
  );
  instances.push(cognition);
  return { world, creature, requests, cognition };
}

type Fixture = ReturnType<typeof fixture>;

async function dispatch(h: Fixture): Promise<PendingRequest> {
  h.cognition.tick(h.world);
  await flush();
  expect(h.requests).toHaveLength(1);
  expect(h.creature.modelPending).toBe(true);
  expect(h.cognition.status().pending).toBe(1);
  return h.requests[0]!;
}

function proposal(request: PendingRequest): MindDecision {
  expect(request.context.availableActions).toContain("rest");
  expect(request.context.memories.length).toBeGreaterThan(0);
  return {
    action: "rest",
    thought: "I will pause here for a short rest.",
    reason: "A rest will replenish my current rest need.",
    speech: "A little rest here.",
    memoryIds: [request.context.memories[0]!.id],
  };
}

function advanceSimulation(world: WorldState, cognition: Cognition, seconds: number): void {
  for (let i = 0; i < Math.round(seconds * 10); i += 1) {
    stepWorld(world, 0.1);
    cognition.tick(world);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Network is forbidden in cognition integration tests");
    }),
  );
});

afterEach(async () => {
  for (const cognition of instances.splice(0)) cognition.stop();
  await flush();
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("cognition with the real simulation boundary", () => {
  it("changes the creature's actual action and records model provenance for an admitted proposal", async () => {
    const h = fixture();
    const priorAction = h.creature.action;
    expect(h.creature.intention.source).toBe("local");
    expect(priorAction).not.toBe("rest");
    const request = await dispatch(h);
    const decision = proposal(request);
    expect(h.creature.action).toBe(priorAction);

    request.resolve(decision);
    await flush();

    expect(h.creature.action).toBe("rest");
    expect(h.creature.intention).toMatchObject({
      action: "rest",
      source: "model",
      text: decision.thought,
      reason: decision.reason,
      memoryIds: decision.memoryIds,
    });
    expect(h.creature.utterance?.text).toBe(decision.speech);
    expect(h.creature.modelPending).toBe(false);
    expect(h.cognition.status()).toMatchObject({ calls: 1, failures: 0, pending: 0 });
  });

  it("accepts a proposal delayed 30 simulated seconds at 12x within the 60-second offer lifetime", async () => {
    const h = fixture();
    expect(applyCommand(h.world, { type: "speed", speed: 12 }).ok).toBe(true);
    const request = await dispatch(h);
    const needsBefore = { ...h.creature.needs };

    advanceSimulation(h.world, h.cognition, 30);
    vi.advanceTimersByTime(2_500); // Thirty simulation seconds at 12x, below the 10s deadline.
    await flush();
    expect(h.world.time - request.context.at).toBeCloseTo(30, 6);
    expect(h.creature.needs).not.toEqual(needsBefore);
    expect(h.creature.intention.source).toBe("local");
    expect(h.creature.modelPending).toBe(true);
    expect(request.signal.aborted).toBe(false);
    expect(h.requests).toHaveLength(1); // The original offer was never refreshed.

    const decision = proposal(request);
    request.resolve(decision);
    await flush();

    expect(h.creature.action).toBe("rest");
    expect(h.creature.intention).toMatchObject({
      source: "model",
      text: decision.thought,
      memoryIds: decision.memoryIds,
      since: h.world.time,
    });
    expect(h.creature.lastModelAt).toBe(h.world.time);
    expect(h.cognition.status()).toMatchObject({ calls: 1, failures: 0, pending: 0 });
  });

  it("keeps urgent local body care when a need becomes critical during a pending proposal", async () => {
    const h = fixture();
    const request = await dispatch(h);
    const decision = proposal(request);
    expect(request.context.needs.clean).toBeGreaterThan(18);

    h.creature.needs.clean = 5;
    stepWorld(h.world, 0.1);
    h.cognition.tick(h.world);
    expect(h.creature.action).toBe("wash");
    expect(h.creature.intention.source).toBe("local");
    expect(h.creature.needs.clean).toBeLessThan(18); // Still urgent until care completes.
    expect(h.creature.modelPending).toBe(true);
    const urgentPlan = structuredClone(h.creature.intention);
    const needsBeforeReply = { ...h.creature.needs };

    request.resolve(decision);
    await flush();

    expect(h.creature.action).toBe("wash");
    expect(h.creature.intention).toEqual(urgentPlan);
    expect(h.creature.needs).toEqual(needsBeforeReply);
    expect(h.creature.utterance?.text).not.toBe(decision.speech);
    expect(h.creature.modelPending).toBe(false);
    // A valid snapshot proposal refused by the live engine is not a transport error.
    expect(h.cognition.status()).toMatchObject({ calls: 1, failures: 0, pending: 0 });
  });

  it.each(["memory", "target"] as const)(
    "rejects another creature's private %s at both the engine and scheduler boundary",
    async (kind) => {
      const h = fixture();
      const hiddenApple = {
        ...h.world.objects.find((object) => object.kind === "apple")!,
        id: "foreign-known-apple",
        position: { x: 1, y: 1 },
      };
      h.world.objects.push(hiddenApple);
      const neighbor = structuredClone(h.creature);
      neighbor.id = "foreign-creature";
      neighbor.name = "Neighbor";
      neighbor.position = { x: h.creature.position.x + 1, y: h.creature.position.y };
      neighbor.memories = [
        {
          id: "foreign-memory",
          at: h.world.time,
          kind: "discovery",
          text: "PRIVATE_NEIGHBOR_EXPERIENCE: an apple in the far corner.",
          importance: 90,
          valence: 1,
          subjectId: hiddenApple.id,
        },
      ];
      neighbor.beliefs = [
        {
          objectId: hiddenApple.id,
          kind: hiddenApple.kind,
          position: { ...hiddenApple.position },
          confidence: 1,
          learnedAt: h.world.time,
          source: "seen",
        },
      ];
      h.world.creatures.push(neighbor);
      const request = await dispatch(h);
      expect(request.context.creatureId).toBe(h.creature.id);
      expect(request.context.neighbors.some((entry) => entry.id === neighbor.id)).toBe(true);
      expect(JSON.stringify(request.context)).not.toMatch(
        /foreign-memory|foreign-known-apple|PRIVATE_NEIGHBOR_EXPERIENCE/,
      );
      const decision = proposal(request);
      if (kind === "memory") decision.memoryIds = [neighbor.memories[0]!.id];
      else {
        expect(request.context.availableActions).toContain("eat");
        decision.action = "eat";
        decision.targetId = hiddenApple.id;
      }
      const before = structuredClone(h.creature);

      // Exercise the engine's own defense even if a caller bypassed provider validation.
      expect(applyMindDecision(h.world, h.creature.id, decision)).toBe(false);
      expect(h.creature).toEqual(before);
      request.resolve(decision);
      await flush();

      expect(h.creature.action).toBe(before.action);
      expect(h.creature.intention).toEqual(before.intention);
      expect(h.creature.memories).toEqual(before.memories);
      expect(h.creature.beliefs).toEqual(before.beliefs);
      expect(h.creature.utterance).toEqual(before.utterance);
      expect(h.creature.modelPending).toBe(false);
      expect(h.cognition.status()).toMatchObject({ calls: 1, failures: 1, pending: 0 });
    },
  );
});
