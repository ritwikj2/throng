import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connectionSchema,
  persistClaudeConnection,
  verifyClaudeAccess,
} from "../server/brain-connection";
import { createApp } from "../server/app";
import { readBrainConfig } from "../server/cognition";

const directories: string[] = [];
const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.stop()));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const key = "FAKE_CLAUDE_KEY_FOR_TEST_ONLY";
const config = () =>
  readBrainConfig({
    THRONG_BRAIN: "anthropic",
    THRONG_MODEL: "claude-sonnet-5",
    ANTHROPIC_API_KEY: key,
  });

describe("private Claude connection", () => {
  it("checks the exact Sonnet model without issuing an inference request", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ id: "claude-sonnet-5" }));
    const result = await verifyClaudeAccess({ apiKey: key, callsPerMinute: 24 }, fetcher);
    expect(result).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-5",
      callsPerMinute: 24,
      minSimulationInterval: 8,
      timeoutMs: 25000,
      configurationError: null,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.anthropic.com/v1/models/claude-sonnet-5");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      redirect: "error",
      headers: { "x-api-key": key },
    });
  });
  it("does not echo provider response bodies or allow a different model", async () => {
    const denied = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ error: key }, { status: 401 }));
    await expect(verifyClaudeAccess({ apiKey: key }, denied)).rejects.not.toThrow(key);
    const other = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: "another-model" }));
    await expect(verifyClaudeAccess({ apiKey: key }, other)).rejects.toThrow("Sonnet 5");
    expect(connectionSchema.safeParse({ apiKey: `${key}\nSECRET` }).success).toBe(false);
    expect(connectionSchema.safeParse({ apiKey: key, callsPerMinute: 61 }).success).toBe(false);
  });
  it("atomically saves only server configuration, preserving unrelated options with private permissions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "throng-connection-"));
    directories.push(dir);
    const path = join(dir, ".env");
    await writeFile(path, "HOST=127.0.0.1\nPORT=8800\nTHRONG_BRAIN=local\n# preserved comment\n", {
      mode: 0o644,
    });
    await persistClaudeConnection(path, { apiKey: key, callsPerMinute: 24 });
    const contents = await readFile(path, "utf8");
    expect(contents).toContain("PORT=8800");
    expect(contents).toContain("# preserved comment");
    expect(contents).not.toContain("THRONG_BRAIN=local");
    expect(contents).toContain("THRONG_MODEL=claude-sonnet-5");
    expect(contents.match(/ANTHROPIC_API_KEY=/g)).toHaveLength(1);
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
  it("activates the verified connection without returning the key and rejects cross-origin setup", async () => {
    const verify = vi.fn().mockResolvedValue(config());
    const app = await createApp({
      port: 0,
      databasePath: ":memory:",
      autoTick: false,
      brainEnvironmentPath: false,
      verifyBrainConnection: verify,
    });
    apps.push(app);
    const rejected = await fetch(`${app.url}/api/brain/connect`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://untrusted.example" },
      body: JSON.stringify({ apiKey: key }),
    });
    expect(rejected.status).toBe(403);
    expect(verify).not.toHaveBeenCalled();
    const response = await fetch(`${app.url}/api/brain/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: key }),
    });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).not.toContain(key);
    expect(JSON.parse(body).brain).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-5",
      ready: true,
      accepted: 0,
    });
    expect(app.state().cognitionMode).toBe("model");
  });
  it("leaves the existing brain untouched if verification fails", async () => {
    const verify = vi.fn().mockRejectedValue(new Error(key));
    const app = await createApp({
      port: 0,
      databasePath: ":memory:",
      autoTick: false,
      brainEnvironmentPath: false,
      verifyBrainConnection: verify,
    });
    apps.push(app);
    const response = await fetch(`${app.url}/api/brain/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: key }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(key);
    expect(app.scene().brain.provider).toBe("local");
  });
});
