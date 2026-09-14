import type { MindContext } from "../shared/types";
import type { BrainConfig } from "./cognition";
import { decisionSchema, MAX_OUTPUT_TOKENS, SYSTEM_PROMPT } from "./cognition-protocol";

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

function openAIOutput(value: unknown): unknown {
  const response = object(value);
  if (response.status !== "completed" || !Array.isArray(response.output))
    throw new CognitionRequestError("invalid");
  const texts: string[] = [];
  for (const item of response.output) {
    const entry = object(item);
    if (entry.type !== "message") continue; // Never expose reasoning items.
    if (!Array.isArray(entry.content)) throw new CognitionRequestError("invalid");
    for (const block of entry.content) {
      const part = object(block);
      if (part.type === "refusal") throw new CognitionRequestError("invalid");
      if (part.type === "output_text" && typeof part.text === "string") texts.push(part.text);
    }
  }
  if (texts.length !== 1) throw new CognitionRequestError("invalid");
  return texts[0];
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
  if (config.provider === "openai") {
    const fetch = restrictedFetch(config.openAIBaseURL, nativeFetch);
    return {
      async decide(context, signal) {
        const response = await fetch(`${config.openAIBaseURL}/responses`, {
          method: "POST",
          signal,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
          body: JSON.stringify({
            model: config.model,
            store: false,
            max_output_tokens: MAX_OUTPUT_TOKENS,
            instructions: SYSTEM_PROMPT,
            input: [{ role: "user", content: JSON.stringify(context) }],
            text: {
              format: {
                type: "json_schema",
                name: "creature_decision",
                strict: true,
                schema: decisionSchema(context.availableActions),
              },
            },
          }),
        });
        return openAIOutput(await readJSON(response));
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
