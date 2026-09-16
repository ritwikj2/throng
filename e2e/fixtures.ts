import { test as base, expect } from "@playwright/test";
import { createApp } from "../server/app";
import { createWorld } from "../server/simulation";
import { connectionConfig } from "../server/brain-connection";
import type { MindDecision } from "../shared/types";

export const test = base.extend<{ app: Awaited<ReturnType<typeof createApp>> }>({
  app: async ({}, use) => {
    const app = await createApp({
      port: 0,
      databasePath: ":memory:",
      initialWorld: createWorld(2026, "Little beginning"),
      brainEnvironmentPath: false,
      verifyBrainConnection: async (input) => {
        if (input.apiKey && input.apiKey !== "FAKE_PROVIDER_BROWSER_TEST_KEY")
          throw new Error("Fixture key required.");
        return connectionConfig(input);
      },
      cognitionOptions: {
        budget: { attempts: [], inFlight: 0 },
        client: {
          async decide(context): Promise<MindDecision> {
            return {
              action: "walk",
              thought: "Explore the east side of the field.",
              reason: "There is space to explore beyond my current position.",
              goal: "Find a useful place on the east side.",
              memoryIds: [],
              ...(context.body && context.bounds
                ? { destination: { x: context.bounds.width - 3, y: context.body.position.y } }
                : {}),
              ...(context.playerMessages.length
                ? { speech: "I hear you. I will explore, then return to familiar food." }
                : {}),
            };
          },
        },
      },
    });
    try {
      await use(app);
    } finally {
      await app.stop();
    }
  },
});
export { expect };
