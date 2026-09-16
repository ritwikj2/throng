import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import {
  BrainConnectionError,
  connectionConfig,
  connectionSchema,
  persistBrainConnection,
  verifyBrainAccess,
} from "../server/brain-connection";
import { createApp } from "../server/app";
import { readBrainConfig } from "../server/cognition";
import type { BrainConnectionInput, MindContext } from "../shared/types";

const directories: string[] = [];
const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.stop()));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const key = "FAKE_PROVIDER_KEY_FOR_TEST_ONLY";
const anthropic: BrainConnectionInput = {
  provider: "anthropic",
  model: "claude-model-of-choice",
  apiKey: key,
};
const validDecision = () => ({
  action: "rest",
  thought: "Rest before exploring.",
  reason: "A short rest is possible here.",
  goal: "Explore after resting.",
  memoryIds: [],
});

async function temporaryEnvironment(content: string) {
  const dir = await mkdtemp(join(tmpdir(), "throng-connection-"));
  directories.push(dir);
  const path = join(dir, ".env");
  await writeFile(path, content, { mode: 0o644 });
  return path;
}

describe("provider-independent brain connection", () => {
  it.each<BrainConnectionInput>([
    anthropic,
    { provider: "openai", model: "coding-model-from-my-account", apiKey: key },
    { provider: "compatible", model: "local-model:small", baseURL: "http://127.0.0.1:11434/v1" },
    {
      provider: "compatible",
      model: "hosted/model",
      baseURL: "https://models.example/v1/",
      apiStyle: "responses",
      apiKey: key,
    },
    { provider: "bedrock", model: "us.anthropic.example", awsRegion: "us-east-1" },
  ])("tests one real engine decision for $provider with an arbitrary model ID", async (input) => {
    const contexts: MindContext[] = [];
    const decide = vi.fn(async (context: MindContext) => {
      contexts.push(context);
      return validDecision();
    });
    const config = await verifyBrainAccess(input, { client: { decide } });
    expect(config).toMatchObject({
      provider: input.provider,
      model: input.model,
      configurationError: null,
      callsPerMinute: 24,
    });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(contexts[0]!.playerMessages).toEqual([]);
    expect(contexts[0]!.availableActions).toContain("rest");
    expect(JSON.stringify(contexts)).not.toContain(key);
  });
  it("selects offline simulation without making a provider request", async () => {
    const decide = vi.fn();
    const config = await verifyBrainAccess({ provider: "local" }, { client: { decide } });
    expect(config).toMatchObject({ provider: "local", model: null });
    expect(decide).not.toHaveBeenCalled();
  });
  it("uses only the selected provider credentials and explicit custom endpoint", () => {
    const compatible = readBrainConfig({
      THRONG_BRAIN: "compatible",
      THRONG_MODEL: "local-model",
      COMPATIBLE_BASE_URL: "http://localhost:11434/v1/",
      OPENAI_API_KEY: "UNRELATED_OPENAI_SECRET",
      ANTHROPIC_API_KEY: "UNRELATED_ANTHROPIC_SECRET",
    });
    expect(compatible).toMatchObject({
      provider: "compatible",
      openAIBaseURL: "http://localhost:11434/v1",
      apiStyle: "chat-completions",
      configurationError: null,
    });
    expect(compatible.apiKey).toBeUndefined();
    expect(JSON.stringify(compatible)).not.toContain("UNRELATED");
    expect(
      connectionConfig({ provider: "openai", model: "api-model", apiKey: key }).openAIBaseURL,
    ).toBe("https://api.openai.com/v1");
  });
  it.each([
    { provider: "compatible", model: "test", baseURL: "http://remote.example/v1" },
    { provider: "compatible", model: "test", baseURL: "https://user:secret@example.com/v1" },
    { provider: "compatible", model: "test", baseURL: "https://example.com/v1?key=secret" },
    { provider: "compatible", model: "test", baseURL: "file:///private" },
    {
      provider: "compatible",
      model: "test",
      baseURL: "https://example.com/v1",
      apiStyle: "unknown",
    },
    { provider: "openai", model: "test", apiKey: key, baseURL: "https://unexpected.example/v1" },
    { provider: "anthropic", model: "bad model", apiKey: key },
    { provider: "anthropic", model: "test", apiKey: `${key}\nINJECTED` },
    { provider: "anthropic", model: "test", apiKey: key, callsPerMinute: 61 },
    { provider: "bedrock", model: "test" },
    { provider: "local", apiKey: key },
  ])("rejects unsafe or incomplete configuration before connecting", (input) => {
    expect(connectionSchema.safeParse(input).success).toBe(false);
  });
  it("keeps older open Claude dialogs compatible with the new endpoint", () => {
    expect(connectionSchema.parse({ apiKey: key })).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-5",
      apiKey: key,
    });
  });
  it("rejects unusable model decisions and redacts provider failures", async () => {
    await expect(
      verifyBrainAccess(anthropic, {
        client: { decide: async () => ({ ...validDecision(), targetId: "invisible" }) },
      }),
    ).rejects.toThrow("valid creature decision");
    const raw = new Error(`Provider failure containing ${key}`);
    await expect(
      verifyBrainAccess(anthropic, {
        client: {
          decide: async () => {
            throw raw;
          },
        },
      }),
    ).rejects.not.toThrow(key);
    await expect(
      verifyBrainAccess(anthropic, {
        client: {
          decide: async () => {
            throw raw;
          },
        },
      }),
    ).rejects.toBeInstanceOf(BrainConnectionError);
  });
  it("cancels a slow test without waiting for an uncooperative client", async () => {
    const controller = new AbortController();
    const decide = vi.fn(() => new Promise<never>(() => {}));
    const check = verifyBrainAccess(anthropic, { client: { decide }, signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(check).rejects.toThrow("canceled");
    expect(decide).toHaveBeenCalledTimes(1);
  });
  it("atomically stores the selected settings and resets an old custom OpenAI URL", async () => {
    const path = await temporaryEnvironment(
      "PORT=8800\nTHRONG_BRAIN=anthropic\nANTHROPIC_API_KEY=OLD_ANTHROPIC_KEY\nOPENAI_BASE_URL=https://previous.example/v1\n# preserved\n",
    );
    await persistBrainConnection(path, {
      provider: "openai",
      model: "selected-model",
      apiKey: key,
      callsPerMinute: 12,
    });
    const contents = await readFile(path, "utf8");
    const values = parseEnv(contents);
    expect(values).toMatchObject({
      PORT: "8800",
      THRONG_BRAIN: "openai",
      THRONG_MODEL: "selected-model",
      OPENAI_API_KEY: key,
      OPENAI_BASE_URL: "https://api.openai.com/v1",
      ANTHROPIC_API_KEY: "OLD_ANTHROPIC_KEY",
      THRONG_CALLS_PER_MINUTE: "12",
    });
    expect(contents).toContain("# preserved");
    expect(contents.match(/OPENAI_API_KEY=/g)).toHaveLength(1);
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
  it("does not reuse a saved compatible-provider key when switching endpoints without a key", async () => {
    const path = await temporaryEnvironment(
      "COMPATIBLE_API_KEY=OLD_SERVER_SECRET\nCOMPATIBLE_BASE_URL=https://old.example/v1\n",
    );
    await persistBrainConnection(path, {
      provider: "compatible",
      model: "local-model",
      baseURL: "http://127.0.0.1:11434/v1",
    });
    const restored = readBrainConfig(parseEnv(await readFile(path, "utf8")));
    expect(restored.apiKey).toBeUndefined();
    expect(restored.openAIBaseURL).toBe("http://127.0.0.1:11434/v1");
    expect(await readFile(path, "utf8")).not.toContain("OLD_SERVER_SECRET");
  });
  it("changes providers without replacing the world or returning the key, and can disconnect to local", async () => {
    const verify = vi.fn(async (input: BrainConnectionInput) => connectionConfig(input));
    const app = await createApp({
      port: 0,
      databasePath: ":memory:",
      autoTick: false,
      brainEnvironmentPath: false,
      verifyBrainConnection: verify,
    });
    apps.push(app);
    const worldId = app.state().id;
    const denied = await fetch(`${app.url}/api/brain/connect`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://untrusted.example" },
      body: JSON.stringify(anthropic),
    });
    expect(denied.status).toBe(403);
    expect(verify).not.toHaveBeenCalled();
    for (const input of [
      anthropic,
      { provider: "openai", model: "selected-model", apiKey: key },
      { provider: "local" },
    ] as BrainConnectionInput[]) {
      const response = await fetch(`${app.url}/api/brain/connect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).not.toContain(key);
      expect(JSON.parse(body)).toMatchObject({
        verification: input.provider === "local" ? "offline" : "decision-tested",
        brain: { provider: input.provider, ready: true, accepted: 0 },
      });
      expect(app.state().id).toBe(worldId);
      expect(app.state().cognitionMode).toBe(input.provider === "local" ? "local" : "model");
    }
  });
  it("keeps the old brain and environment when the test fails", async () => {
    const path = await temporaryEnvironment("THRONG_BRAIN=local\n# untouched\n");
    const app = await createApp({
      port: 0,
      databasePath: ":memory:",
      autoTick: false,
      brainEnvironmentPath: path,
      verifyBrainConnection: async () => {
        throw new Error(key);
      },
    });
    apps.push(app);
    const response = await fetch(`${app.url}/api/brain/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(anthropic),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(key);
    expect(app.scene().brain.provider).toBe("local");
    expect(await readFile(path, "utf8")).toBe("THRONG_BRAIN=local\n# untouched\n");
  });
});
