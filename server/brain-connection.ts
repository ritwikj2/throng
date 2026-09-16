import { chmod, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { parseEnv } from "node:util";
import { z } from "zod";
import type { BrainConnectionInput } from "../shared/types";
import { normalizeBrainURL, readBrainConfig, type BrainConfig } from "./cognition";
import {
  createProviderClient,
  safeProviderError,
  type CognitionClient,
  type ProviderDependencies,
} from "./cognition-providers";
import { projectMindContext, validateMindDecision } from "./cognition-protocol";
import {
  applyCommand,
  applyMindDecision,
  createWorld,
  getMindContext,
  stepWorld,
} from "./simulation";

export const CLAUDE_MODEL = "claude-sonnet-5";
const model = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !/[\u0000-\u0020\u007f]/.test(value));
const key = z
  .string()
  .trim()
  .max(4096)
  .refine((value) => !/[\u0000-\u0020\u007f]/.test(value));
const callsPerMinute = z.number().int().min(1).max(60).optional();
const baseURL = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    try {
      normalizeBrainURL(value);
      return true;
    } catch {
      return false;
    }
  });
const schema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("local"), callsPerMinute }).strict(),
  z
    .object({
      provider: z.literal("anthropic"),
      model,
      apiKey: key.refine((value) => value.length > 0),
      callsPerMinute,
    })
    .strict(),
  z
    .object({
      provider: z.literal("openai"),
      model,
      apiKey: key.refine((value) => value.length > 0),
      callsPerMinute,
    })
    .strict(),
  z
    .object({
      provider: z.literal("compatible"),
      model,
      baseURL,
      apiStyle: z.enum(["responses", "chat-completions"]).optional(),
      apiKey: key.optional(),
      callsPerMinute,
    })
    .strict(),
  z
    .object({
      provider: z.literal("bedrock"),
      model,
      awsRegion: z
        .string()
        .trim()
        .regex(/^[a-z]{2}(?:-[a-z]+)+-\d+$/),
      callsPerMinute,
    })
    .strict(),
]);
// Existing open Claude dialogs can finish during a frontend/server update.
export const connectionSchema = z.preprocess((input) => {
  if (
    input &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    !("provider" in input) &&
    "apiKey" in input
  )
    return { provider: "anthropic", model: CLAUDE_MODEL, ...input };
  return input;
}, schema);
export type ConnectionInput = BrainConnectionInput;

export class BrainConnectionError extends Error {}

// Node's dotenv parser does not unescape JSON string literals. Choose a literal
// representation that preserves the actual value, and reject before any model
// call if the parser cannot represent it without changing bytes.
function environmentValue(value: string): string {
  const candidates = [`"${value}"`, `'${value}'`];
  // An unmatched leading quote can consume a later line's closing quote.
  if (!/^["'`]/.test(value)) candidates.push(value);
  for (const candidate of candidates) {
    const parsed = parseEnv(`VALUE=${candidate}\nTHRONG_VALUE_END=ok\n`);
    if (parsed.VALUE === value && parsed.THRONG_VALUE_END === "ok") return candidate;
  }
  throw new BrainConnectionError(
    "These settings contain quote characters that cannot be saved in .env.",
  );
}

function connectionEnvironment(input: ConnectionInput): Record<string, string> {
  const result = connectionSchema.safeParse(input);
  if (!result.success)
    throw new BrainConnectionError(
      "Check the provider, model, credentials, endpoint, and request limit.",
    );
  const selected = result.data;
  const values: Record<string, string> = {
    THRONG_BRAIN: selected.provider,
    THRONG_MODEL: selected.provider === "local" ? "" : selected.model,
    THRONG_CALLS_PER_MINUTE: String(selected.callsPerMinute ?? 24),
    THRONG_THINK_INTERVAL_SECONDS: "8",
    THRONG_BRAIN_TIMEOUT_MS: "25000",
  };
  switch (selected.provider) {
    case "anthropic":
      values.ANTHROPIC_API_KEY = selected.apiKey;
      break;
    case "openai":
      values.OPENAI_API_KEY = selected.apiKey;
      // A key entered for OpenAI must not inherit an older custom endpoint.
      values.OPENAI_BASE_URL = "https://api.openai.com/v1";
      break;
    case "compatible":
      values.COMPATIBLE_API_KEY = selected.apiKey ?? "";
      values.COMPATIBLE_BASE_URL = normalizeBrainURL(selected.baseURL);
      values.COMPATIBLE_API_STYLE = selected.apiStyle ?? "chat-completions";
      break;
    case "bedrock":
      values.AWS_REGION = selected.awsRegion;
      break;
  }
  for (const value of Object.values(values)) environmentValue(value);
  return values;
}

export function connectionConfig(input: ConnectionInput): BrainConfig {
  const config = readBrainConfig(connectionEnvironment(input));
  if (config.configurationError) throw new BrainConnectionError(config.configurationError);
  return config;
}

export interface ConnectionCheckOptions extends ProviderDependencies {
  client?: CognitionClient;
  signal?: AbortSignal;
}

export async function verifyBrainAccess(
  input: ConnectionInput,
  options: ConnectionCheckOptions = {},
): Promise<BrainConfig> {
  const config = connectionConfig(input);
  if (config.provider === "local") return config;
  const timeout = AbortSignal.timeout(config.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  if (signal.aborted) throw new BrainConnectionError("The connection check was canceled.");
  // One isolated decision verifies the actual wire protocol and game contract.
  // It contains no user world, player messages, saved histories, or credentials.
  const world = createWorld(20260916, "Synthetic brain connection check");
  world.cognitionMode = "model";
  applyCommand(world, { type: "hatch" });
  stepWorld(world, 0.1);
  const creature = world.creatures[0]!;
  const context = projectMindContext(getMindContext(world, creature.id)!);
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () =>
      reject(
        new BrainConnectionError(
          timeout.aborted
            ? "The test decision timed out. Check the server and model, then try again."
            : "The connection check was canceled.",
        ),
      );
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const client = options.client ?? createProviderClient(config, options);
    const raw = await Promise.race([
      Promise.resolve().then(() => client.decide(context, signal)),
      aborted,
    ]);
    if (signal.aborted) throw new BrainConnectionError("The connection check was canceled.");
    let decision;
    try {
      decision = validateMindDecision(raw, context);
    } catch {
      throw new BrainConnectionError(
        "The model did not return a valid creature decision. Check its JSON support and the selected API protocol.",
      );
    }
    if (!applyMindDecision(world, creature.id, decision))
      throw new BrainConnectionError(
        "The test decision could not be applied. Choose a model that can follow the creature action schema and try again.",
      );
    return config;
  } catch (error) {
    if (error instanceof BrainConnectionError) throw error;
    throw new BrainConnectionError(safeProviderError(error));
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export async function persistBrainConnection(
  path: string,
  input: ConnectionInput,
  signal?: AbortSignal,
): Promise<void> {
  const checkCanceled = () => {
    if (signal?.aborted) throw new BrainConnectionError("The connection check was canceled.");
  };
  checkCanceled();
  const values = connectionEnvironment(input);
  let current = "";
  try {
    current = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  checkCanceled();
  const lines = current.split(/\r?\n/).filter((line) => {
    const name = /^\s*(?:export\s+)?([A-Z_]+)\s*=/.exec(line)?.[1];
    return !name || !Object.hasOwn(values, name);
  });
  const content = `${lines.join("\n").trimEnd()}\n${Object.entries(values)
    .map(([name, value]) => `${name}=${environmentValue(value)}`)
    .join("\n")}\n`;
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: "wx", signal });
    await chmod(temporary, 0o600);
    checkCanceled();
    // Rename commits the settings. Cancellation after this point cannot undo it;
    // the caller must complete activation and report the committed result.
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
