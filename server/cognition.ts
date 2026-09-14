import type {
  BrainProvider,
  BrainStatus,
  Creature,
  MindContext,
  MindDecision,
  WorldState,
} from "../shared/types";
import { getMindContext, applyMindDecision } from "./simulation";
import { projectMindContext, validateMindDecision } from "./cognition-protocol";
import {
  CognitionRequestError,
  createProviderClient,
  safeProviderError,
} from "./cognition-providers";
import type { CognitionClient, ProviderDependencies } from "./cognition-providers";

export interface BrainConfig {
  provider: BrainProvider;
  model: string | null;
  apiKey?: string; // Server-only; status() must never spread this object.
  awsRegion?: string;
  openAIBaseURL: string;
  callsPerMinute: number;
  timeoutMs: number;
  minSimulationInterval: number;
  configurationError: string | null;
}

export interface Cognition {
  status(): BrainStatus;
  tick(world: WorldState): void;
  stop(): void;
}

export interface CognitionEngine {
  getMindContext(world: WorldState, creatureId: string): MindContext | null;
  applyMindDecision(world: WorldState, creatureId: string, decision: MindDecision): boolean;
}

export interface CognitionClock {
  now(): number; // Monotonic wall time in milliseconds, never simulation time.
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface CognitionBudget {
  attempts: number[];
  inFlight: number;
}

export interface CognitionOptions extends ProviderDependencies {
  client?: CognitionClient;
  engine?: CognitionEngine;
  clock?: CognitionClock;
  budget?: CognitionBudget;
}

// Runtime replaces the scheduler on colony switches. Keep its rolling quota
// across those replacements; tests supply an isolated ledger and clock.
const processBudget: CognitionBudget = { attempts: [], inFlight: 0 };
const clock: CognitionClock = {
  now: () => performance.now(),
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
const providerLabels: Record<BrainProvider, string> = {
  local: "Local learned policy",
  openai: "OpenAI",
  anthropic: "Anthropic",
  bedrock: "Claude on Amazon Bedrock",
};

export function readBrainConfig(env: NodeJS.ProcessEnv): BrainConfig {
  const requested = env.THRONG_BRAIN?.trim().toLowerCase() || "local";
  const known = ["local", "openai", "anthropic", "bedrock"].includes(requested);
  const config: BrainConfig = {
    provider: known ? (requested as BrainProvider) : "local",
    model: null,
    openAIBaseURL: "https://api.openai.com/v1",
    callsPerMinute: 6,
    timeoutMs: 10_000,
    minSimulationInterval: 30,
    configurationError: known
      ? null
      : "THRONG_BRAIN must be local, openai, anthropic, or bedrock; using local policy.",
  };
  // Ambient keys/model/base URLs never opt a local game into remote requests.
  if (config.provider === "local") return config;
  const fail = (message: string): void => {
    config.configurationError ??= message;
  };
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    const number = Number(raw);
    if (
      !/^\d+$/.test(raw.trim()) ||
      !Number.isSafeInteger(number) ||
      number < min ||
      number > max
    ) {
      fail(`${name} must be an integer between ${min} and ${max}.`);
      return fallback;
    }
    return number;
  };
  config.callsPerMinute = integer("THRONG_CALLS_PER_MINUTE", 6, 1, 60);
  config.timeoutMs = integer("THRONG_BRAIN_TIMEOUT_MS", 10_000, 500, 30_000);
  config.minSimulationInterval = integer("THRONG_THINK_INTERVAL_SECONDS", 30, 4, 300);
  const model = env.THRONG_MODEL?.trim();
  if (!model || model.length > 200 || /[\u0000-\u0020\u007f]/.test(model))
    fail("Set THRONG_MODEL to a valid model ID for the selected provider.");
  else config.model = model;
  if (config.provider === "openai" || config.provider === "anthropic") {
    const name = config.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
    const key = env[name]?.trim();
    if (!key || /[\r\n]/.test(key)) fail(`Set ${name} in the server environment.`);
    else config.apiKey = key;
  }
  if (config.provider === "openai" && env.OPENAI_BASE_URL?.trim()) {
    try {
      const url = new URL(env.OPENAI_BASE_URL.trim());
      const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if (
        (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error("Invalid URL");
      config.openAIBaseURL = url.toString().replace(/\/+$/, "");
    } catch {
      fail(
        "OPENAI_BASE_URL must be an HTTPS base URL, or a loopback HTTP URL, without credentials, query, or fragment.",
      );
    }
  }
  if (config.provider === "bedrock") {
    const region = (env.AWS_REGION || env.AWS_DEFAULT_REGION)?.trim();
    if (!region || !/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region))
      fail("Set AWS_REGION to the Bedrock model region.");
    else config.awsRegion = region;
  }
  return config;
}

interface Job {
  world: WorldState;
  creature: Creature;
  context: MindContext;
  generation: number;
  controller: AbortController;
  timer?: unknown;
  discarded: boolean;
  timedOut: boolean;
  finished: boolean;
}

export function createCognition(config: BrainConfig, options: CognitionOptions = {}): Cognition {
  const engine = options.engine ?? { getMindContext, applyMindDecision };
  const time = options.clock ?? clock;
  const budget = options.budget ?? processBudget;
  let client = options.client;
  const active = new Map<string, Job>();
  const nextSimulationAttempt = new Map<string, number>();
  let currentWorld: WorldState | null = null;
  let currentWorldId: string | null = null;
  let generation = 0;
  let stopped = false;
  let cursor: string | null = null;
  let calls = 0;
  let failures = 0;
  let accepted = 0;
  let rejected = 0;
  let lastDecisionAt: number | null = null;
  let failureStreak = 0;
  let retryAfter = 0;
  let lastWallTime = -Infinity;
  let lastError = config.configurationError;

  const wallNow = (): number => {
    const value = time.now();
    if (!Number.isFinite(value)) throw new Error("Invalid cognition clock");
    lastWallTime = Math.max(lastWallTime, value);
    return lastWallTime;
  };
  const release = (job: Job): void => {
    if (job.finished) return;
    job.finished = true;
    if (job.timer !== undefined) time.clearTimeout(job.timer);
    budget.inFlight = Math.max(0, budget.inFlight - 1);
    if (active.get(job.creature.id) === job) {
      active.delete(job.creature.id);
      job.creature.modelPending = false;
    }
  };
  const discardAll = (): void => {
    generation += 1;
    for (const job of [...active.values()]) {
      job.discarded = true;
      job.controller.abort();
      release(job);
    }
  };
  const isCurrent = (job: Job): boolean =>
    !stopped &&
    !job.discarded &&
    !job.controller.signal.aborted &&
    active.get(job.creature.id) === job &&
    generation === job.generation &&
    currentWorld === job.world &&
    currentWorldId === job.world.id &&
    job.world.id === job.context.worldId &&
    !job.world.paused &&
    job.world.hatched &&
    job.creature.alive &&
    job.world.creatures.find((creature) => creature.id === job.creature.id) === job.creature &&
    job.world.time >= job.context.at &&
    job.world.time - job.context.at <= 360;

  async function run(job: Job): Promise<void> {
    const signal = job.controller.signal;
    let onAbort = (): void => {};
    const canceled = new Promise<never>((_, reject) => {
      onAbort = () => reject(new CognitionRequestError(job.timedOut ? "timeout" : "unavailable"));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    job.timer = time.setTimeout(() => {
      job.timedOut = true;
      job.controller.abort();
    }, config.timeoutMs);
    try {
      const work = Promise.resolve().then(() => {
        if (signal.aborted) throw new CognitionRequestError("unavailable");
        client ??= createProviderClient(config, options);
        return client.decide(job.context, signal);
      });
      const value = await Promise.race([work, canceled]);
      if (!isCurrent(job)) return;
      let decision: MindDecision;
      try {
        decision = validateMindDecision(value, job.context);
      } catch {
        throw new CognitionRequestError("invalid");
      }
      // The engine rechecks current target knowledge, action validity, evidence,
      // and urgent bodily needs. A refusal is not a provider transport failure.
      if (engine.applyMindDecision(job.world, job.creature.id, decision)) {
        accepted += 1;
        lastDecisionAt = job.world.time;
      } else {
        rejected += 1;
      }
      failureStreak = 0;
      lastError = null;
    } catch (error) {
      if (
        !stopped &&
        !job.discarded &&
        currentWorld === job.world &&
        generation === job.generation
      ) {
        failures += 1;
        failureStreak += 1;
        retryAfter = wallNow() + Math.min(60_000, 1_000 * 2 ** Math.min(failureStreak - 1, 6));
        lastError = safeProviderError(job.timedOut ? new CognitionRequestError("timeout") : error);
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      release(job);
    }
  }

  return {
    status(): BrainStatus {
      return {
        provider: config.provider,
        model: config.provider === "local" ? null : config.model,
        ready: !stopped && (config.provider === "local" || config.configurationError === null),
        label: stopped
          ? "Cognition stopped"
          : config.provider === "local"
            ? providerLabels.local
            : `${providerLabels[config.provider]}${config.model ? ` · ${config.model}` : ""}${config.configurationError ? " (local policy active)" : ""}`,
        calls,
        failures,
        accepted,
        rejected,
        lastDecisionAt,
        pending: active.size,
        budgetPerMinute: config.callsPerMinute,
        lastError,
      };
    },
    tick(world): void {
      if (stopped) return;
      if (currentWorld !== world || currentWorldId !== world.id) {
        discardAll();
        currentWorld = world;
        currentWorldId = world.id;
        // A save may contain a pending flag, but network jobs are never saved.
        for (const creature of world.creatures) creature.modelPending = false;
        nextSimulationAttempt.clear();
        cursor = null;
      }
      if (world.paused || !world.hatched) {
        if (active.size) discardAll();
        return;
      }
      // Do not leave dead/removed creatures holding scarce slots until timeout.
      for (const job of [...active.values()]) {
        if (!isCurrent(job)) {
          job.discarded = true;
          job.controller.abort();
          release(job);
        }
      }
      if (config.provider === "local" || config.configurationError) return;
      const now = wallNow();
      budget.attempts = budget.attempts.filter((attempt) => now - attempt < 60_000);
      if (
        now < retryAfter ||
        budget.attempts.length >= config.callsPerMinute ||
        budget.inFlight >= 2
      )
        return;
      const living = world.creatures.filter((creature) => creature.alive);
      const livingIds = new Set(living.map((creature) => creature.id));
      for (const id of nextSimulationAttempt.keys())
        if (!livingIds.has(id)) nextSimulationAttempt.delete(id);
      const start =
        cursor === null
          ? 0
          : (living.findIndex((creature) => creature.id === cursor) + 1) %
            Math.max(1, living.length);
      for (let offset = 0; offset < living.length; offset += 1) {
        if (budget.inFlight >= 2 || budget.attempts.length >= config.callsPerMinute) break;
        const creature = living[(start + offset) % living.length]!;
        const next =
          nextSimulationAttempt.get(creature.id) ??
          (creature.lastModelAt > 0
            ? creature.lastModelAt + config.minSimulationInterval
            : -Infinity);
        const importantEvent = creature.memories.some(
          (memory) =>
            memory.at > creature.lastModelAt &&
            (memory.kind === "loss" ||
              (memory.kind === "player" && memory.text.includes("shared message")) ||
              (memory.kind === "social" && memory.actor === "creature")),
        );
        if (
          active.has(creature.id) ||
          creature.modelPending ||
          (world.time < next && !importantEvent)
        )
          continue;
        let context: MindContext;
        try {
          const input = engine.getMindContext(world, creature.id);
          if (!input || input.worldId !== world.id || input.creatureId !== creature.id) continue;
          context = projectMindContext(input);
          if (!context.availableActions.length) continue;
        } catch {
          lastError = "Could not prepare a private mind context; local policy continues.";
          nextSimulationAttempt.set(creature.id, world.time + config.minSimulationInterval);
          continue;
        }
        const job: Job = {
          world,
          creature,
          context,
          generation,
          controller: new AbortController(),
          discarded: false,
          timedOut: false,
          finished: false,
        };
        // Reservations happen synchronously before invoking any client code.
        budget.attempts.push(now);
        budget.inFlight += 1;
        calls += 1;
        active.set(creature.id, job);
        creature.modelPending = true;
        creature.lastModelAt = world.time;
        nextSimulationAttempt.set(creature.id, world.time + config.minSimulationInterval);
        cursor = creature.id;
        void run(job);
      }
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      discardAll();
      nextSimulationAttempt.clear();
      currentWorld = null;
    },
  };
}
