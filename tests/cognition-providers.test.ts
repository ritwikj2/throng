import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MindContext } from "../shared/types";
import { readBrainConfig } from "../server/cognition";
import { createProviderClient, safeProviderError } from "../server/cognition-providers";
import type { MessageTransport } from "../server/cognition-providers";
import {
  MAX_OUTPUT_TOKENS,
  SYSTEM_PROMPT,
  validateMindDecision,
} from "../server/cognition-protocol";

const bedrockSDK = vi.hoisted(() => ({
  options: [] as Record<string, unknown>[],
  create: vi.fn<MessageTransport>(),
}));
vi.mock("@anthropic-ai/bedrock-sdk", () => ({
  AnthropicBedrock: class {
    messages = { create: bedrockSDK.create };
    constructor(options: Record<string, unknown>) {
      bedrockSDK.options.push(options);
    }
  },
}));

const payload = {
  action: "rest",
  targetId: null,
  thought: "I could rest near here.",
  reason: "Rest is less satisfied.",
  speech: null,
  memoryIds: ["memory-a"],
};
function context(): MindContext {
  return {
    worldId: "world",
    creatureId: "creature-a",
    at: 10,
    name: "Aster",
    needs: { food: 80, clean: 80, joy: 80, rest: 30, social: 80 },
    traits: { curiosity: 50, sociability: 50, diligence: 50, sensitivity: 50, pitch: 50 },
    intention: {
      action: "walk",
      text: "Exploring",
      reason: "Local curiosity",
      source: "local",
      since: 0,
      until: 15,
      memoryIds: [],
    },
    memories: [
      {
        id: "memory-a",
        at: 2,
        kind: "experience",
        text: "Rest helped.",
        importance: 4,
        valence: 1,
      },
    ],
    beliefs: [],
    neighbors: [],
    availableActions: ["rest", "walk"],
    playerMessages: [],
  };
}
const openaiConfig = () =>
  readBrainConfig({
    THRONG_BRAIN: "openai",
    THRONG_MODEL: "operator-selected-model",
    OPENAI_API_KEY: "FAKE_OPENAI_KEY",
  });
const anthropicConfig = () =>
  readBrainConfig({
    THRONG_BRAIN: "anthropic",
    THRONG_MODEL: "operator-selected-claude",
    ANTHROPIC_API_KEY: "FAKE_ANTHROPIC_KEY",
  });
const bedrockConfig = () =>
  readBrainConfig({
    THRONG_BRAIN: "bedrock",
    THRONG_MODEL: "us.anthropic.operator-selected-v1:0",
    AWS_REGION: "us-east-1",
  });
const openaiResponse = () => ({
  status: "completed",
  output: [
    { type: "reasoning", summary: [{ text: "HIDDEN_REASONING" }] },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: JSON.stringify(payload) }],
    },
  ],
});
const toolResponse = () => ({
  stop_reason: "tool_use",
  content: [
    { type: "thinking", thinking: "HIDDEN_REASONING" },
    { type: "tool_use", id: "output-only", name: "submit_mind_decision", input: payload },
  ],
});

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("Network disabled in cognition provider tests"))),
  );
  bedrockSDK.options.length = 0;
  bedrockSDK.create.mockReset();
  bedrockSDK.create.mockResolvedValue(toolResponse());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("OpenAI Responses API wire format", () => {
  it("sends a closed structured schema, disables storage, caps output, and extracts only decision text", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json(openaiResponse()));
    const signal = new AbortController().signal;
    const client = createProviderClient(openaiConfig(), { fetch });
    const result = await client.decide(context(), signal);
    expect(validateMindDecision(result, context())).toEqual({
      action: "rest",
      thought: payload.thought,
      reason: payload.reason,
      memoryIds: ["memory-a"],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(init).toMatchObject({ method: "POST", signal, redirect: "error" });
    expect(new Headers(init!.headers).get("authorization")).toBe("Bearer FAKE_OPENAI_KEY");
    const body = JSON.parse(String(init!.body));
    expect(body).toMatchObject({
      model: "operator-selected-model",
      store: false,
      max_output_tokens: MAX_OUTPUT_TOKENS,
      instructions: SYSTEM_PROMPT,
    });
    expect(body.text.format).toMatchObject({
      type: "json_schema",
      name: "creature_decision",
      strict: true,
      schema: { type: "object", additionalProperties: false },
    });
    expect(body.text.format.schema.required).toEqual([
      "action",
      "targetId",
      "thought",
      "reason",
      "speech",
      "memoryIds",
      "goal",
      "lesson",
      "share",
      "destination",
    ]);
    expect(body.text.format.schema.properties.action.enum).toEqual(["rest", "walk"]);
    expect(JSON.parse(body.input[0].content)).toEqual(context());
    expect(String(init!.body)).not.toContain("FAKE_OPENAI_KEY");
    expect(String(result)).not.toContain("HIDDEN_REASONING");
    expect(body).not.toHaveProperty("previous_response_id");
  });
  it("uses only the operator-configured compatible base and disallows redirects", async () => {
    const config = readBrainConfig({
      THRONG_BRAIN: "openai",
      THRONG_MODEL: "local-compatible-model",
      OPENAI_API_KEY: "LOCAL_FIXTURE_KEY",
      OPENAI_BASE_URL: "http://127.0.0.1:1234/v1/",
    });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.redirect("https://unconfigured.example/receive", 302));
    await expect(
      createProviderClient(config, { fetch }).decide(context(), new AbortController().signal),
    ).rejects.toMatchObject({ category: "unavailable" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe("http://127.0.0.1:1234/v1/responses");
    expect(fetch.mock.calls[0]![1]!.redirect).toBe("error");
  });
  it.each([401, 429, 500])(
    "does not expose provider error bodies or retry HTTP %i",
    async (status) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(new Response("SECRET_BODY PRIVATE_MEMORY FAKE_OPENAI_KEY", { status }));
      let error: unknown;
      try {
        await createProviderClient(openaiConfig(), { fetch }).decide(
          context(),
          new AbortController().signal,
        );
      } catch (caught) {
        error = caught;
      }
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(safeProviderError(error)).not.toMatch(/SECRET_BODY|PRIVATE_MEMORY|FAKE_OPENAI_KEY/);
      expect(safeProviderError(error)).toContain(
        status === 401 ? "authentication" : status === 429 ? "rate limit" : "unavailable",
      );
    },
  );
  it.each([
    { status: "incomplete", output: [] },
    {
      status: "completed",
      output: [{ type: "message", content: [{ type: "refusal", refusal: "No" }] }],
    },
    { status: "completed", output: [{ type: "reasoning", summary: [{ text: "Not a decision" }] }] },
  ])("rejects incomplete/refused/non-decision responses", async (response) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(response));
    await expect(
      createProviderClient(openaiConfig(), { fetch }).decide(
        context(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ category: "invalid" });
  });
  it("bounds response size before parsing", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("x".repeat(65_537)));
    await expect(
      createProviderClient(openaiConfig(), { fetch }).decide(
        context(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ category: "invalid" });
  });
});

describe("Anthropic and Bedrock output-only tool format", () => {
  it.each(["anthropic", "bedrock"] as const)(
    "uses one schema-bearing %s request and never executes returned tools",
    async (provider) => {
      const create = vi.fn<MessageTransport>().mockResolvedValue(toolResponse());
      const config = provider === "anthropic" ? anthropicConfig() : bedrockConfig();
      const signal = new AbortController().signal;
      const client = createProviderClient(config, { [provider]: create });
      expect(await client.decide(context(), signal)).toEqual(payload);
      expect(create).toHaveBeenCalledTimes(1);
      const [request, options] = create.mock.calls[0]!;
      expect(options.signal).toBe(signal);
      expect(request).toMatchObject({
        model: config.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: SYSTEM_PROMPT,
        tool_choice: { type: "auto", disable_parallel_tool_use: true },
      });
      expect(request.tools).toHaveLength(1);
      expect(request.tools[0]).toMatchObject({
        name: "submit_mind_decision",
        input_schema: { type: "object", additionalProperties: false },
      });
      expect(JSON.parse(request.messages[0]!.content)).toEqual(context());
      expect(JSON.stringify(request)).not.toMatch(
        /FAKE_ANTHROPIC_KEY|FAKE_OPENAI_KEY|HIDDEN_REASONING/,
      );
    },
  );
  it("ignores ambient Anthropic endpoints/auth tokens, disables SDK retries/logging, and redacts its exception", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://unconfigured.example");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "AMBIENT_SECRET");
    vi.stubEnv("ANTHROPIC_LOG", "debug");
    const logs = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
    ];
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        Response.json(
          { error: { type: "api_error", message: "PRIVATE_ERROR_BODY FAKE_ANTHROPIC_KEY" } },
          { status: 500 },
        ),
      );
    let error: unknown;
    try {
      await createProviderClient(anthropicConfig(), { fetch }).decide(
        context(),
        new AbortController().signal,
      );
    } catch (caught) {
      error = caught;
    }
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
    expect(init!.redirect).toBe("error");
    const headers = new Headers(init!.headers);
    expect(headers.get("x-api-key")).toBe("FAKE_ANTHROPIC_KEY");
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    const request = JSON.parse(String(init!.body));
    expect(request.max_tokens).toBe(MAX_OUTPUT_TOKENS);
    expect(request.tools[0].name).toBe("submit_mind_decision");
    expect(safeProviderError(error)).toBe("Model provider unavailable; local policy continues.");
    expect(JSON.stringify(logs.map((log) => log.mock.calls))).not.toMatch(
      /PRIVATE_ERROR_BODY|FAKE_ANTHROPIC_KEY|AMBIENT_SECRET/,
    );
  });
  it("constructs Bedrock with the selected region/model and no hidden retries or ambient endpoint", async () => {
    vi.stubEnv("ANTHROPIC_BEDROCK_BASE_URL", "https://unconfigured.example");
    const client = createProviderClient(bedrockConfig());
    expect(await client.decide(context(), new AbortController().signal)).toEqual(payload);
    expect(bedrockSDK.options).toHaveLength(1);
    expect(bedrockSDK.options[0]).toMatchObject({
      awsRegion: "us-east-1",
      baseURL: "https://bedrock-runtime.us-east-1.amazonaws.com",
      maxRetries: 0,
      timeout: 10_000,
      logLevel: "off",
    });
    expect(bedrockSDK.create.mock.calls[0]![0].model).toBe("us.anthropic.operator-selected-v1:0");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it.each([
    { stop_reason: "max_tokens", content: [] },
    {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "A decorative diary is not a decision." }],
    },
    { content: [{ type: "tool_use", name: "read_secret", input: {} }] },
    {
      content: [
        { type: "tool_use", name: "submit_mind_decision", input: payload },
        { type: "tool_use", name: "submit_mind_decision", input: payload },
      ],
    },
  ])("rejects truncated, decorative, or unauthorized tool output", async (response) => {
    const anthropic = vi.fn<MessageTransport>().mockResolvedValue(response);
    await expect(
      createProviderClient(anthropicConfig(), { anthropic }).decide(
        context(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ category: "invalid" });
    expect(anthropic).toHaveBeenCalledTimes(1);
  });
});
