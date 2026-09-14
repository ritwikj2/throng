import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCognition, readBrainConfig } from "../server/cognition.ts";
import { applyCommand, createWorld, stepWorld } from "../server/simulation.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
try {
  process.loadEnvFile(resolve(root, ".env"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const config = readBrainConfig(process.env);
let cognition;
try {
  if (config.provider !== "anthropic" || config.model !== "claude-sonnet-5")
    throw new Error("Select THRONG_BRAIN=anthropic and THRONG_MODEL=claude-sonnet-5 first.");
  if (config.configurationError) throw new Error(config.configurationError);
  const world = createWorld(20260914, "Synthetic Claude connection check");
  world.cognitionMode = "model";
  applyCommand(world, { type: "hatch" });
  stepWorld(world, 0.1);
  cognition = createCognition(config);
  console.log("Checking one Claude Sonnet 5 decision in an isolated synthetic world.");
  cognition.tick(world); // Exactly one creature, one tick, at most one paid request.
  const deadline = Date.now() + config.timeoutMs + 1000;
  while (cognition.status().pending && Date.now() < deadline)
    await new Promise((done) => setTimeout(done, 50));
  const status = cognition.status();
  const creature = world.creatures[0];
  if (status.accepted !== 1 || creature?.intention.source !== "model")
    throw new Error(
      status.lastError ?? "The returned decision was not accepted by the simulation.",
    );
  console.log(
    JSON.stringify(
      {
        provider: status.provider,
        model: status.model,
        calls: status.calls,
        accepted: status.accepted,
        action: creature.intention.action,
        goal: creature.cognition?.goal ?? null,
        source: creature.intention.source,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(`Claude check failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  cognition?.stop();
}
