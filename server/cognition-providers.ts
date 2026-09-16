import type { MindContext } from "../shared/types";
import type { BrainConfig } from "./cognition";
import {
  decisionSchema,
  MAX_OUTPUT_TOKENS,
  projectMindContext,
  SYSTEM_PROMPT,
  validateMindDecision,
} from "./cognition-protocol";

// Exact model cards documenting low reasoning effort:
// https://developers.openai.com/api/docs/models/gpt-5.3-codex
// https://developers.openai.com/api/docs/models/gpt-5.2-codex
const LOW_EFFORT_CODEX_MODELS = new Set(["gpt-5.3-codex", "gpt-5.2-codex"]);

export interface CognitionClient {
  decide(context: MindContext, signal: AbortSignal): Promise<unknown>;
}

export type MessageRequest = {
  model: string;
  max_tokens: number;
  system: string;
  messages: { role: "user"; content: string }[];
  tools: { name: string; description: string; input_schema: ReturnType<typeof decisionSchema> }[];
  tool_choice: { type: "auto"; disable_parallel_tool_use: boolean };
  thinking?: { type: "adaptive" };
  output_config?: { effort: "low" };
};
export type MessageTransport = (
  request: MessageRequest,
  options: { signal: AbortSignal },
) => Promise<unknown>;
export interface ProviderDependencies {
  fetch?: typeof globalThis.fetch;
  anthropic?: MessageTransport;
  bedrock?: MessageTransport;
}

export class CognitionRequestError extends Error {
  constructor(readonly category: "timeout" | "auth" | "rate" | "invalid" | "unavailable") {
    super(category);
  }
}

export function safeProviderError(error: unknown): string {
  if (error instanceof CognitionRequestError) {
    if (error.category === "timeout") return "Model request timed out; local policy continues.";
    if (error.category === "invalid")
      return "Model returned an invalid decision; local policy continues.";
    if (error.category === "auth")
      return "Provider authentication failed; check server credentials.";
    if (error.category === "rate") return "Provider rate limit reached; local policy continues.";
  }
  if (error && typeof error === "object" && "status" in error) {
    const status = error.status;
    if (status === 401 || status === 403)
      return "Provider authentication failed; check server credentials.";
    if (status === 429) return "Provider rate limit reached; local policy continues.";
  }
  return "Model provider unavailable; local policy continues.";
}

function restrictedFetch(
  baseURL: string,
  implementation: typeof globalThis.fetch,
): typeof globalThis.fetch {
  const origin = new URL(baseURL).origin;
  return (input, init) => {
    const address = input instanceof Request ? input.url : String(input);
    if (new URL(address).origin !== origin)
      return Promise.reject(new CognitionRequestError("unavailable"));
    return implementation(input, { ...init, redirect: "error" });
  };
}

async function readJSON(response: Response): Promise<unknown> {
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new CognitionRequestError(
      response.status === 429
        ? "rate"
        : response.status === 401 || response.status === 403
          ? "auth"
          : "unavailable",
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new CognitionRequestError("invalid");
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 65_536) {
        void reader.cancel().catch(() => {});
        throw new CognitionRequestError("invalid");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch (error) {
    if (error instanceof CognitionRequestError) throw error;
    throw new CognitionRequestError("invalid");
  } finally {
    reader.releaseLock();
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CognitionRequestError("invalid");
  return value as Record<string, unknown>;
}

function openAIOutput(value: unknown): string {
  const response = object(value);
  if (
    response.status !== "completed" ||
    response.error != null ||
    response.incomplete_details != null ||
    !Array.isArray(response.output)
  )
    throw new CognitionRequestError("invalid");
  const texts: string[] = [];
  for (const item of response.output) {
    const entry = object(item);
    if (entry.type === "reasoning") continue; // Never expose reasoning items.
    if (
      entry.type !== "message" ||
      (entry.role !== undefined && entry.role !== "assistant") ||
      (entry.status !== undefined && entry.status !== "completed") ||
      !Array.isArray(entry.content)
    )
      throw new CognitionRequestError("invalid");
    for (const block of entry.content) {
      const part = object(block);
      if (part.type !== "output_text" || typeof part.text !== "string")
        throw new CognitionRequestError("invalid");
      texts.push(part.text);
    }
  }
  if (texts.length !== 1) throw new CognitionRequestError("invalid");
  return texts[0]!;
}

function chatOutput(value: unknown): string {
  const response = object(value);
  if (response.error != null || !Array.isArray(response.choices) || response.choices.length !== 1)
    throw new CognitionRequestError("invalid");
  const choice = object(response.choices[0]);
  if (choice.finish_reason !== "stop") throw new CognitionRequestError("invalid");
  const message = object(choice.message);
  if (
    message.role !== "assistant" ||
    typeof message.content !== "string" ||
    message.refusal != null ||
    message.function_call != null ||
    (message.tool_calls != null &&
      (!Array.isArray(message.tool_calls) || message.tool_calls.length > 0))
  )
    throw new CognitionRequestError("invalid");
  return message.content;
}

function jsonOnlyPrompt(context: MindContext): string {
  return `${SYSTEM_PROMPT}
Return exactly one JSON object matching the schema below. Do not use Markdown fences, commentary, or tool calls.
JSON schema:
${JSON.stringify(decisionSchema(context.availableActions))}`;
}

function toolOutput(value: unknown): unknown {
  const message = object(value);
  if (message.stop_reason === "max_tokens" || !Array.isArray(message.content))
    throw new CognitionRequestError("invalid");
  const tools = message.content.map(object).filter((block) => block.type === "tool_use");
  if (tools.length !== 1 || tools[0]?.name !== "submit_mind_decision")
    throw new CognitionRequestError("invalid");
  return tools[0].input; // An output schema, never an executable tool.
}

export function createProviderClient(
  config: BrainConfig,
  dependencies: ProviderDependencies = {},
): CognitionClient {
  const nativeFetch = dependencies.fetch ?? globalThis.fetch;
  if (config.provider === "openai" || config.provider === "compatible") {
    const official = config.provider === "openai";
    const chat = !official && (config.apiStyle ?? "chat-completions") === "chat-completions";
    // Bind endpoint and credentials together for this client's lifetime.
    const baseURL = config.openAIBaseURL.replace(/\/+$/, "");
    const model = config.model;
    const apiKey = config.apiKey?.trim();
    const fetch = restrictedFetch(baseURL, nativeFetch);
    return {
      async decide(context, signal) {
        if (signal.aborted) throw new CognitionRequestError("unavailable");
        if (official && !apiKey) throw new CognitionRequestError("auth");
        const projected = projectMindContext(context);
        const instructions = official ? SYSTEM_PROMPT : jsonOnlyPrompt(projected);
        const body = chat
          ? {
              model,
              max_tokens: MAX_OUTPUT_TOKENS,
              messages: [
                { role: "system", content: instructions },
                { role: "user", content: JSON.stringify(projected) },
              ],
            }
          : {
              model,
              max_output_tokens: MAX_OUTPUT_TOKENS,
              instructions,
              input: [{ role: "user", content: JSON.stringify(projected) }],
              ...(official
                ? {
                    store: false,
                    ...(LOW_EFFORT_CODEX_MODELS.has(model ?? "")
                      ? { reasoning: { effort: "low" } }
                      : {}),
                    text: {
                      format: {
                        type: "json_schema",
                        name: "creature_decision",
                        strict: true,
                        schema: decisionSchema(projected.availableActions),
                      },
                    },
                  }
                : {}),
            };
        const response = await fetch(`${baseURL}/${chat ? "chat/completions" : "responses"}`, {
          method: "POST",
          signal,
          headers: {
            "Content-Type": "application/json",
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify(body),
        });
        const data = await readJSON(response);
        if (signal.aborted) throw new CognitionRequestError("unavailable");
        const output = chat ? chatOutput(data) : openAIOutput(data);
        if (official) return output;
        // Compatible endpoints need no vendor-specific structured-output support.
        // A complete JSON decision must pass the same validator as scheduled plans.
        try {
          return validateMindDecision(output, projected);
        } catch {
          throw new CognitionRequestError("invalid");
        }
      },
    };
  }
  // Explicit endpoints override ambient SDK base-URL settings. SDK retries and
  // logging are disabled; scheduling and public diagnostics belong to the host.
  const bedrockURL = `https://bedrock-runtime.${config.awsRegion}.amazonaws.com${config.awsRegion?.startsWith("cn-") ? ".cn" : ""}`;
  let transport: Promise<MessageTransport> | undefined;
  async function getTransport(): Promise<MessageTransport> {
    if (config.provider === "anthropic") {
      if (dependencies.anthropic) return dependencies.anthropic;
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic({
        apiKey: config.apiKey,
        authToken: null,
        baseURL: "https://api.anthropic.com",
        maxRetries: 0,
        timeout: config.timeoutMs,
        logLevel: "off",
        fetch: restrictedFetch("https://api.anthropic.com", nativeFetch),
      });
      return (request, options) => client.messages.create(request, options);
    }
    if (config.provider === "bedrock") {
      if (dependencies.bedrock) return dependencies.bedrock;
      const { AnthropicBedrock } = await import("@anthropic-ai/bedrock-sdk");
      const client = new AnthropicBedrock({
        awsRegion: config.awsRegion,
        baseURL: bedrockURL,
        maxRetries: 0,
        timeout: config.timeoutMs,
        logLevel: "off",
        fetch: restrictedFetch(bedrockURL, nativeFetch),
      });
      return (request, options) => client.messages.create(request, options);
    }
    throw new CognitionRequestError("unavailable");
  }
  return {
    async decide(context, signal) {
      transport ??= getTransport().catch((error: unknown) => {
        transport = undefined;
        throw error;
      });
      const create = await transport;
      if (signal.aborted) throw new CognitionRequestError("unavailable");
      const response = await create(
        {
          model: config.model!,
          ...(config.model === "claude-sonnet-5"
            ? { thinking: { type: "adaptive" as const }, output_config: { effort: "low" as const } }
            : {}),
          max_tokens: MAX_OUTPUT_TOKENS,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: JSON.stringify(context) }],
          tools: [
            {
              name: "submit_mind_decision",
              description: "Submit one grounded intention for this simulated creature.",
              input_schema: decisionSchema(context.availableActions),
            },
          ],
          // Auto + one allowed tool works with models that prohibit forced tool_choice.
          tool_choice: { type: "auto", disable_parallel_tool_use: true },
        },
        { signal },
      );
      return toolOutput(response);
    },
  };
}
