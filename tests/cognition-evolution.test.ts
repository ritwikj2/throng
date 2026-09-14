import { afterEach, describe, expect, it } from "vitest";
import { createCognition, readBrainConfig, type Cognition } from "../server/cognition";
import { createProviderClient, type MessageRequest } from "../server/cognition-providers";
import { projectMindContext, validateMindDecision } from "../server/cognition-protocol";
import { applyCommand, createWorld, getMindContext, stepWorld } from "../server/simulation";
import { makeCreature, remember } from "../server/simulation-core";
import { ColonyStore } from "../server/store";
import type { MindContext } from "../shared/types";

const instances: Cognition[] = [];
afterEach(() => {
  for (const instance of instances.splice(0)) instance.stop();
});
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const config = () =>
  readBrainConfig({
    THRONG_BRAIN: "anthropic",
    THRONG_MODEL: "claude-sonnet-5",
    ANTHROPIC_API_KEY: "FAKE_KEY_FOR_TEST_ONLY",
    THRONG_CALLS_PER_MINUTE: "60",
  });
function fixture() {
  const world = createWorld(41);
  world.cognitionMode = "model";
  applyCommand(world, { type: "hatch" });
  stepWorld(world, 0.1);
  world.time = 100;
  const creature = world.creatures[0]!;
  creature.needs = { food: 80, clean: 80, joy: 80, rest: 65, social: 80 };
  const evidence = remember(world, creature, "experience", "Eating a nearby apple restored food.", {
    importance: 90,
    need: "food",
    delta: 34,
    valence: 0.8,
  });
  return { world, creature, evidence };
}

describe("model decisions, retained experience, and communication", () => {
  it("persists a model goal/lesson, passes evidence to a neighbor, and includes the lesson after save/load", async () => {
    const { world, creature, evidence } = fixture();
    const neighbor = makeCreature(
      world,
      { x: creature.position.x + 1, y: creature.position.y },
      creature,
    );
    neighbor.lastModelAt = world.time;
    const contexts: MindContext[] = [];
    const cognition = createCognition(config(), {
      budget: { attempts: [], inFlight: 0 },
      client: {
        async decide(context) {
          contexts.push(context);
          return {
            action: "rest",
            thought: "Rest before visiting the apple again.",
            reason: "The meal helped; now I need rest.",
            memoryIds: [evidence.id],
            goal: "Return to familiar food after resting.",
            lesson: "The nearby apple restored food.",
            speech: "There is useful food near us.",
            share: { memoryId: evidence.id, recipientId: neighbor.id },
          };
        },
      },
    });
    instances.push(cognition);
    cognition.tick(world);
    await settle();
    expect(cognition.status()).toMatchObject({ accepted: 1, rejected: 0 });
    expect(creature.intention.source).toBe("model");
    expect(creature.cognition).toMatchObject({
      goal: "Return to familiar food after resting.",
      lesson: "The nearby apple restored food.",
      decisions: 1,
    });
    expect(
      neighbor.memories.some((m) => m.sourceId === creature.id && m.text.includes("apple")),
    ).toBe(true);
    expect(
      world.collective.messages.some((m) => m.source === "model" && m.text.includes("useful food")),
    ).toBe(true);
    const store = new ColonyStore(":memory:");
    try {
      store.save(world);
      const restored = store.load(world.id)!;
      const next = projectMindContext(getMindContext(restored, creature.id)!);
      expect(next.cognition?.lesson).toBe(creature.cognition?.lesson);
      expect(next.body?.position).toEqual(creature.position);
      expect(next.beliefs.some((belief) => belief.observed !== undefined)).toBe(true);
    } finally {
      store.close();
    }
    expect(contexts).toHaveLength(1);
  });
  it("rejects invented shared evidence, invisible recipients, and evidence-free lessons", () => {
    const { world, creature } = fixture();
    const context = projectMindContext(getMindContext(world, creature.id)!);
    const base = { action: "rest", thought: "Rest now.", reason: "Rest is lower.", memoryIds: [] };
    expect(() =>
      validateMindDecision({ ...base, lesson: "An invented event taught me something." }, context),
    ).toThrow();
    expect(() =>
      validateMindDecision(
        { ...base, share: { memoryId: "foreign", recipientId: "invisible" } },
        context,
      ),
    ).toThrow();
  });
  it("wakes a creature for a newly witnessed loss before its ordinary thinking interval", async () => {
    const { world, creature } = fixture();
    const contexts: MindContext[] = [];
    const cognition = createCognition(config(), {
      budget: { attempts: [], inFlight: 0 },
      client: {
        async decide(context) {
          contexts.push(context);
          return {
            action: "rest",
            thought: "Stay here for a moment.",
            reason: "I can pause before moving.",
            memoryIds: [],
          };
        },
      },
    });
    instances.push(cognition);
    cognition.tick(world);
    await settle();
    world.time += 1;
    remember(world, creature, "loss", "The player squashed a creature beside me.", {
      actor: "player",
      sourceId: "player",
      importance: 100,
      valence: -1,
    });
    cognition.tick(world);
    await settle();
    expect(contexts).toHaveLength(2);
    expect(contexts[1]!.memories.some((m) => m.kind === "loss")).toBe(true);
    expect(cognition.status().accepted).toBe(2);
  });
  it("uses supported adaptive thinking and low effort for the exact requested Sonnet 5 model", async () => {
    const { world, creature } = fixture();
    const context = projectMindContext(getMindContext(world, creature.id)!);
    let captured: MessageRequest | undefined;
    const provider = createProviderClient(config(), {
      anthropic: async (request) => {
        captured = request;
        return {
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              name: "submit_mind_decision",
              input: { action: "rest", thought: "Rest.", reason: "Rest is lower.", memoryIds: [] },
            },
          ],
        };
      },
    });
    await provider.decide(context, new AbortController().signal);
    expect(captured).toMatchObject({
      model: "claude-sonnet-5",
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      max_tokens: 1600,
    });
    expect(captured).not.toHaveProperty("temperature");
  });
});
