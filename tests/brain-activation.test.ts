import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { request, type ClientRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import { createApp } from "../server/app";
import { connectionConfig, persistBrainConnection } from "../server/brain-connection";
import { ColonyStore } from "../server/store";
import type { BrainConnectionInput } from "../shared/types";

// Keep real files and production persistence; only pause individual operations.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: vi.fn(actual.writeFile),
    chmod: vi.fn(actual.chmod),
    rename: vi.fn(actual.rename),
  };
});
vi.mock("../server/brain-connection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/brain-connection")>();
  return { ...actual, persistBrainConnection: vi.fn(actual.persistBrainConnection) };
});

const realFS = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const oldInput: BrainConnectionInput = {
  provider: "openai",
  model: "fake-existing-model",
  apiKey: "FAKE_EXISTING_OPENAI_KEY",
};
const nextInput: BrainConnectionInput = {
  provider: "anthropic",
  model: "fake-replacement-model",
  apiKey: "FAKE_REPLACEMENT_ANTHROPIC_KEY",
};
const oldEnvironment = [
  "# Existing operator settings",
  "PORT=8800",
  "THRONG_BRAIN=openai",
  "THRONG_MODEL=fake-existing-model",
  "OPENAI_API_KEY=FAKE_EXISTING_OPENAI_KEY",
  "",
].join("\n");

type App = Awaited<ReturnType<typeof createApp>>;
const directories: string[] = [];
const apps: App[] = [];
const requests: ClientRequest[] = [];
const releases: (() => void)[] = [];
const pending: Promise<unknown>[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function observe<T>(promise: Promise<T>) {
  const outcome = promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  pending.push(outcome);
  return outcome;
}

function barrier() {
  const entered = deferred<void>();
  const resume = deferred<void>();
  const release = () => resume.resolve();
  releases.push(release);
  return {
    entered: entered.promise,
    release,
    wait: async () => {
      entered.resolve();
      await resume.promise;
    },
  };
}

function pauseAfter(operation: "writeFile" | "chmod" | "rename") {
  const gate = barrier();
  if (operation === "writeFile") {
    vi.mocked(fs.writeFile).mockImplementationOnce(async (...args) => {
      await realFS.writeFile(...args);
      await gate.wait();
    });
  } else if (operation === "chmod") {
    vi.mocked(fs.chmod).mockImplementationOnce(async (...args) => {
      await realFS.chmod(...args);
      await gate.wait();
    });
  } else {
    vi.mocked(fs.rename).mockImplementationOnce(async (...args) => {
      await realFS.rename(...args);
      // The file is committed, but the caller has not received its acknowledgement.
      await gate.wait();
    });
  }
  return gate;
}

async function temporaryEnvironment() {
  const directory = await realFS.mkdtemp(join(tmpdir(), "throng-brain-activation-"));
  directories.push(directory);
  const path = join(directory, ".env");
  await realFS.writeFile(path, oldEnvironment, { mode: 0o600 });
  return path;
}

async function fixture() {
  const path = await temporaryEnvironment();
  const verify = vi.fn(async (input: BrainConnectionInput) => connectionConfig(input));
  const decide = vi.fn(async () => ({
    action: "rest",
    thought: "Rest before exploring.",
    reason: "A synthetic test decision.",
    memoryIds: [],
  }));
  const app = await createApp({
    port: 0,
    databasePath: ":memory:",
    autoTick: false,
    brain: connectionConfig(oldInput),
    brainEnvironmentPath: path,
    verifyBrainConnection: verify,
    cognitionOptions: { client: { decide }, budget: { attempts: [], inFlight: 0 } },
  });
  apps.push(app);
  return { app, path, verify, decide };
}

function startConnection(app: App) {
  const req = request(new URL("/api/brain/connect", app.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  // These requests deliberately lose their socket during cancellation/shutdown.
  req.on("error", () => {});
  req.on("response", (res) => res.resume());
  requests.push(req);
  req.end(JSON.stringify(nextInput));
  return req;
}

function observeServerAbort() {
  const aborted = deferred<AbortSignal>();
  const actual = AbortController.prototype.abort;
  vi.spyOn(AbortController.prototype, "abort").mockImplementation(function (
    this: AbortController,
    reason?: unknown,
  ) {
    actual.call(this, reason);
    aborted.resolve(this.signal);
  });
  // node:http request.destroy() does not use an AbortController of its own.
  return aborted.promise;
}

function currentPersistence() {
  const result = vi.mocked(persistBrainConnection).mock.results.at(-1);
  expect(result?.type).toBe("return");
  return observe(result!.value as Promise<void>);
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function expectOldSettings(app: App, path: string) {
  expect(app.scene().brain).toMatchObject({
    provider: oldInput.provider,
    model: oldInput.model,
    ready: true,
  });
  expect(await realFS.readFile(path, "utf8")).toBe(oldEnvironment);
  expect(await realFS.readdir(dirname(path))).toEqual([".env"]);
}

beforeEach(() => {
  vi.mocked(fs.writeFile).mockReset().mockImplementation(realFS.writeFile);
  vi.mocked(fs.chmod).mockReset().mockImplementation(realFS.chmod);
  vi.mocked(fs.rename).mockReset().mockImplementation(realFS.rename);
  vi.mocked(persistBrainConnection).mockClear();
});

afterEach(async () => {
  // Release barriers even when an assertion fails, before waiting for shutdown.
  for (const release of releases.splice(0)) release();
  for (const req of requests.splice(0)) req.destroy();
  await Promise.all(pending.splice(0));
  await Promise.all(apps.splice(0).map((app) => app.stop()));
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => realFS.rm(path, { recursive: true, force: true })),
  );
});

describe("brain activation commit boundary", () => {
  it("keeps the old provider and settings when the colony checkpoint fails", async () => {
    const { app, path, verify, decide } = await fixture();
    const originalWorld = app.state();
    vi.spyOn(ColonyStore.prototype, "save").mockImplementationOnce(() => {
      throw new Error("Synthetic SQLite write failure");
    });

    const response = await fetch(`${app.url}/api/brain/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(nextInput),
    });
    const body = await response.text();

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(body).not.toContain(nextInput.apiKey);
    await expectOldSettings(app, path);
    expect(app.state()).toBe(originalWorld);
    expect(persistBrainConnection).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
  });

  it("leaves the real settings file unchanged when already canceled", async () => {
    const path = await temporaryEnvironment();
    const controller = new AbortController();
    controller.abort();

    await expect(persistBrainConnection(path, nextInput, controller.signal)).rejects.toThrow();

    expect(await realFS.readFile(path, "utf8")).toBe(oldEnvironment);
    expect(await realFS.readdir(dirname(path))).toEqual([".env"]);
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(fs.rename).not.toHaveBeenCalled();
  });

  it.each(["writeFile", "chmod"] as const)(
    "cancels after temporary-file %s without committing or leaving credentials behind",
    async (operation) => {
      const path = await temporaryEnvironment();
      const controller = new AbortController();
      const gate = pauseAfter(operation);
      const result = observe(persistBrainConnection(path, nextInput, controller.signal));
      await gate.entered;
      controller.abort();
      gate.release();

      expect((await result).ok).toBe(false);
      expect(await realFS.readFile(path, "utf8")).toBe(oldEnvironment);
      expect(await realFS.readdir(dirname(path))).toEqual([".env"]);
      expect(fs.rename).not.toHaveBeenCalled();
    },
  );

  it("keeps a successful rename committed when cancellation arrives before its acknowledgement", async () => {
    const path = await temporaryEnvironment();
    const controller = new AbortController();
    const gate = pauseAfter("rename");
    const result = observe(persistBrainConnection(path, nextInput, controller.signal));
    await gate.entered;
    controller.abort();
    gate.release();

    expect((await result).ok).toBe(true);
    expect(parseEnv(await realFS.readFile(path, "utf8"))).toMatchObject({
      THRONG_BRAIN: nextInput.provider,
      THRONG_MODEL: nextInput.model,
      ANTHROPIC_API_KEY: nextInput.apiKey,
    });
    expect(await realFS.readdir(dirname(path))).toEqual([".env"]);
    if (process.platform !== "win32") expect((await realFS.stat(path)).mode & 0o777).toBe(0o600);
  });

  it.each([
    { operation: "writeFile", committed: false, expectedProvider: "openai" },
    { operation: "rename", committed: true, expectedProvider: "anthropic" },
  ] as const)(
    "honors HTTP disconnection at $operation with committed=$committed",
    async ({ operation, committed, expectedProvider }) => {
      const { app, path, decide } = await fixture();
      const aborted = observeServerAbort();
      const gate = pauseAfter(operation);
      const req = startConnection(app);
      await gate.entered;
      const persistence = currentPersistence();

      // The old scheduler stays live while the replacement is being prepared.
      expect(app.scene().brain).toMatchObject({ provider: "openai", ready: true });
      req.destroy();
      expect((await aborted).aborted).toBe(true);
      gate.release();
      expect((await persistence).ok).toBe(committed);
      await flush();

      expect(app.scene().brain).toMatchObject({ provider: expectedProvider, ready: true });
      if (committed) {
        expect(parseEnv(await realFS.readFile(path, "utf8")).THRONG_BRAIN).toBe("anthropic");
      } else {
        await expectOldSettings(app, path);
      }
      expect(await realFS.readdir(dirname(path))).toEqual([".env"]);
      expect(decide).not.toHaveBeenCalled();
    },
  );

  it("waits for an aborted connection to finish before closing SQLite", async () => {
    const { app, path, decide } = await fixture();
    const aborted = observeServerAbort();
    const gate = pauseAfter("writeFile");
    const close = vi.spyOn(ColonyStore.prototype, "close");
    const req = startConnection(app);
    await gate.entered;
    const persistence = currentPersistence();

    // Close the client first so shutdown is not kept open merely by its socket.
    req.destroy();
    await aborted;
    const stopping = observe(app.stop());
    await flush();
    expect(close).not.toHaveBeenCalled();

    gate.release();
    expect((await persistence).ok).toBe(false);
    expect((await stopping).ok).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(app.scene().brain).toMatchObject({ provider: "openai", ready: false });
    expect(await realFS.readFile(path, "utf8")).toBe(oldEnvironment);
    expect(await realFS.readdir(dirname(path))).toEqual([".env"]);
    expect(decide).not.toHaveBeenCalled();
  });
});
