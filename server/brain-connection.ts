import { chmod, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { readBrainConfig, type BrainConfig } from "./cognition";

export const CLAUDE_MODEL = "claude-sonnet-5";
export const connectionSchema = z
  .object({
    apiKey: z
      .string()
      .trim()
      .min(12)
      .max(512)
      .refine((key) => !/[\r\n\u0000]/.test(key)),
    callsPerMinute: z.number().int().min(1).max(60).optional(),
  })
  .strict();
export type ConnectionInput = z.infer<typeof connectionSchema>;

export async function verifyClaudeAccess(
  input: ConnectionInput,
  fetcher: typeof fetch = fetch,
): Promise<BrainConfig> {
  const response = await fetcher(`https://api.anthropic.com/v1/models/${CLAUDE_MODEL}`, {
    headers: { "x-api-key": input.apiKey, "anthropic-version": "2023-06-01" },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new Error(
      response.status === 401 || response.status === 403 || response.status === 404
        ? "Claude access could not be verified. Check the key and Sonnet 5 access on your Anthropic account."
        : "Anthropic could not verify access right now. Try again shortly.",
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Anthropic returned an unreadable model response.");
  let bytes = 0;
  let body = "";
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 65_536) {
        void reader.cancel().catch(() => {});
        throw new Error("Model response was too large.");
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  let model: { id?: unknown };
  try {
    model = JSON.parse(body) as { id?: unknown };
  } catch {
    throw new Error("Anthropic returned an unreadable model response.");
  }
  if (!model || typeof model.id !== "string" || !model.id.startsWith(CLAUDE_MODEL))
    throw new Error("Claude Sonnet 5 was not available for this key.");
  return readBrainConfig({
    THRONG_BRAIN: "anthropic",
    THRONG_MODEL: CLAUDE_MODEL,
    ANTHROPIC_API_KEY: input.apiKey,
    THRONG_CALLS_PER_MINUTE: String(input.callsPerMinute ?? 24),
    THRONG_THINK_INTERVAL_SECONDS: "8",
    THRONG_BRAIN_TIMEOUT_MS: "25000",
  });
}

export async function persistClaudeConnection(path: string, input: ConnectionInput): Promise<void> {
  let current = "";
  try {
    current = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const values: Record<string, string> = {
    THRONG_BRAIN: "anthropic",
    THRONG_MODEL: CLAUDE_MODEL,
    ANTHROPIC_API_KEY: JSON.stringify(input.apiKey),
    THRONG_CALLS_PER_MINUTE: String(input.callsPerMinute ?? 24),
    THRONG_THINK_INTERVAL_SECONDS: "8",
    THRONG_BRAIN_TIMEOUT_MS: "25000",
  };
  const lines = current.split(/\r?\n/).filter((line) => {
    const key = /^\s*(?:export\s+)?([A-Z_]+)\s*=/.exec(line)?.[1];
    return !key || !Object.hasOwn(values, key);
  });
  const content = `${lines.join("\n").trimEnd()}\n${Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
