import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MindContext } from "../shared/types";
import { readBrainConfig, type BrainConfig } from "../server/cognition";
import { createProviderClient, safeProviderError } from "../server/cognition-providers";
import type { MessageTransport } from "../server/cognition-providers";
import {
  decisionSchema,
  MAX_OUTPUT_TOKENS,
  projectMindContext,
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
const openaiResponse = (text = JSON.stringify(payload)) => ({
  status: "completed",
  output: [
    { type: "reasoning", summary: [{ text: "HIDDEN_REASONING" }] },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    },
  ],
});
type APIStyle = NonNullable<BrainConfig["apiStyle"]>;
const compatibleConfig = (apiStyle?: APIStyle): BrainConfig => ({
  ...openaiConfig(),
  provider: "compatible",
  openAIBaseURL: "http://127.0.0.1:1234/v1/",
  apiStyle,
});
const chatResponse = (content = JSON.stringify(payload)) => ({
  choices: [
    {
      index: 0,
      finish_reason: "stop",
      message: {
        role: "assistant",
        content,
        refusal: null,
        reasoning_content: "HIDDEN_REASONING",
      },
    },
  ],
});
const compatibleResponse = (style: APIStyle, text = JSON.stringify(payload)) =>
  style === "responses" ? openaiResponse(text) : chatResponse(text);
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
  it.each(["gpt-5.3-codex", "gpt-5.2-codex"])(
    "uses low reasoning for verified official OpenAI model %s",
    async (model) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(Response.json(openaiResponse()));
      await createProviderClient({ ...openaiConfig(), model }, { fetch }).decide(
        context(),
        new AbortController().signal,
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
      expect(body.model).toBe(model);
      expect(body.reasoning).toEqual({ effort: "low" });
      expect(body.max_output_tokens).toBe(MAX_OUTPUT_TOKENS);
      expect(body.store).toBe(false);
      expect(body.text.format.strict).toBe(true);
    },
  );

  it.each([
    "operator-selected-model",
    "gpt-4.1-mini",
    "gpt-5.3-codex-latest",
    "gpt-5.2-codex-custom",
    "GPT-5.3-CODEX",
  ])("omits reasoning options for other or inexact OpenAI model %s", async (model) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json(openaiResponse()));
    await createProviderClient({ ...openaiConfig(), model }, { fetch }).decide(
      context(),
      new AbortController().signal,
    );
    const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
    expect(body.model).toBe(model);
    expect(body).not.toHaveProperty("reasoning");
    expect(body.text.format.strict).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["chat-completions", "responses"] as const)(
    "never adds official Codex reasoning options to compatible %s",
    async (style) => {
      for (const model of ["gpt-5.3-codex", "gpt-5.2-codex"]) {
        const fetch = vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValue(Response.json(compatibleResponse(style)));
        await createProviderClient({ ...compatibleConfig(style), model }, { fetch }).decide(
          context(),
          new AbortController().signal,
        );
        const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
        expect(body.model).toBe(model);
        expect(body).not.toHaveProperty("reasoning");
        expect(body).not.toHaveProperty("text");
        expect(body).not.toHaveProperty("store");
        expect(fetch).toHaveBeenCalledTimes(1);
      }
    },
  );

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

describe("compatible JSON decision protocols", () => {
  it("defaults to chat completions with a projected context and a plain JSON schema prompt", async () => {
    const input = context();
    input.bounds = { width: 32, height: 24 };
    input.body = { position: { x: 12, y: 10 }, health: 90, age: 12, generation: 1 };
    input.beliefs = [
      {
        objectId: "apple-a",
        kind: "apple",
        position: { x: 14, y: 10 },
        confidence: 80,
        learnedAt: 8,
        source: "seen",
        observed: { amount: 1, capacity: 1, built: true, progress: 1, at: 8 },
      },
    ];
    Object.assign(input, { privateState: "UNPROJECTED_SECRET" });
    Object.assign(input.memories[0]!, { hidden: "UNPROJECTED_SECRET" });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(chatResponse()));
    const signal = new AbortController().signal;
    const result = await createProviderClient(compatibleConfig(), { fetch }).decide(input, signal);
    expect(result).toEqual(validateMindDecision(payload, input));
    expect(JSON.stringify(result)).not.toContain("HIDDEN_REASONING");
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:1234/v1/chat/completions");
    expect(init).toMatchObject({ method: "POST", signal, redirect: "error" });
    expect(new Headers(init!.headers).get("authorization")).toBe("Bearer FAKE_OPENAI_KEY");
    const body = JSON.parse(String(init!.body));
    expect(Object.keys(body).sort()).toEqual(["max_tokens", "messages", "model"]);
    expect(body.model).toBe("operator-selected-model");
    expect(body.max_tokens).toBe(MAX_OUTPUT_TOKENS);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain(SYSTEM_PROMPT);
    expect(body.messages[0].content).toContain("Do not use Markdown fences");
    expect(body.messages[0].content).toContain(
      JSON.stringify(decisionSchema(input.availableActions)),
    );
    expect(body.messages[1].role).toBe("user");
    const sentContext = JSON.parse(body.messages[1].content);
    expect(sentContext).toEqual(projectMindContext(input));
    expect(sentContext.bounds).toEqual({ width: 32, height: 24 });
    expect(sentContext.body.position).toEqual({ x: 12, y: 10 });
    expect(sentContext.beliefs[0].observed).toEqual(input.beliefs[0]!.observed);
    expect(String(init!.body)).not.toMatch(/UNPROJECTED_SECRET|FAKE_OPENAI_KEY/);
  });

  it("supports compatible Responses with a stateless prompt and no structured-output extensions", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json(openaiResponse()));
    const config = compatibleConfig("responses");
    config.openAIBaseURL = "https://operator.example/inference/v1/";
    const signal = new AbortController().signal;
    expect(await createProviderClient(config, { fetch }).decide(context(), signal)).toEqual(
      validateMindDecision(payload, context()),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://operator.example/inference/v1/responses");
    expect(init).toMatchObject({ method: "POST", signal, redirect: "error" });
    const body = JSON.parse(String(init!.body));
    expect(Object.keys(body).sort()).toEqual([
      "input",
      "instructions",
      "max_output_tokens",
      "model",
    ]);
    expect(body).not.toHaveProperty("store");
    expect(body.max_output_tokens).toBe(MAX_OUTPUT_TOKENS);
    expect(body.instructions).toContain(JSON.stringify(decisionSchema(context().availableActions)));
    expect(body.instructions).toContain("Return exactly one JSON object");
    expect(body.input).toEqual([
      { role: "user", content: JSON.stringify(projectMindContext(context())) },
    ]);
  });

  it("keeps official OpenAI on strict Responses even when apiStyle requests chat", async () => {
    const config: BrainConfig = { ...openaiConfig(), apiStyle: "chat-completions" };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json(openaiResponse()));
    await createProviderClient(config, { fetch }).decide(context(), new AbortController().signal);
    expect(fetch.mock.calls[0]![0]).toBe("https://api.openai.com/v1/responses");
    const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
    expect(body.text.format.strict).toBe(true);
    expect(body.instructions).toBe(SYSTEM_PROMPT);
  });

  it.each(["chat-completions", "responses"] as const)(
    "permits keyless loopback %s without borrowing ambient credentials",
    async (style) => {
      vi.stubEnv("OPENAI_API_KEY", "AMBIENT_SECRET");
      vi.stubEnv("OPENAI_BASE_URL", "https://unconfigured.example");
      for (const apiKey of [undefined, "", "   "]) {
        const config = { ...compatibleConfig(style), apiKey };
        const fetch = vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValue(Response.json(compatibleResponse(style)));
        await createProviderClient(config, { fetch }).decide(
          context(),
          new AbortController().signal,
        );
        const [url, init] = fetch.mock.calls[0]!;
        expect(String(url)).toMatch(/^http:\/\/127\.0\.0\.1:1234\/v1\//);
        expect([...new Headers(init!.headers)]).toEqual([["content-type", "application/json"]]);
        expect(String(init!.body)).not.toMatch(/AMBIENT_SECRET|Bearer undefined|unconfigured/);
        expect(fetch).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("requires an explicit official OpenAI key before making a request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      createProviderClient({ ...openaiConfig(), apiKey: undefined }, { fetch }).decide(
        context(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ category: "auth" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["chat-completions", "responses"] as const)(
    "binds %s endpoint and explicit credentials together for the client's lifetime",
    async (style) => {
      const config = compatibleConfig(style);
      config.apiKey = "  EXPLICIT_FIXTURE_KEY  ";
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(Response.json(compatibleResponse(style)));
      const client = createProviderClient(config, { fetch });
      config.openAIBaseURL = "https://unconfigured.example";
      config.apiKey = "DIFFERENT_ENDPOINT_KEY";
      await client.decide(context(), new AbortController().signal);
      const [url, init] = fetch.mock.calls[0]!;
      expect(new URL(String(url)).origin).toBe("http://127.0.0.1:1234");
      const headers = new Headers(init!.headers);
      expect(headers.get("authorization")).toBe("Bearer EXPLICIT_FIXTURE_KEY");
      expect([...headers.keys()].sort()).toEqual(["authorization", "content-type"]);
      expect(JSON.stringify(init)).not.toContain("DIFFERENT_ENDPOINT_KEY");
      expect(String(init!.body)).not.toContain("EXPLICIT_FIXTURE_KEY");
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["chat-completions", "responses"] as const)(
    "rejects %s redirects without following or retrying",
    async (style) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(Response.redirect("https://unconfigured.example/steal", 307));
      await expect(
        createProviderClient(compatibleConfig(style), { fetch }).decide(
          context(),
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ category: "unavailable" });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0]![1]!.redirect).toBe("error");
    },
  );

  it.each(["chat-completions", "responses"] as const)(
    "rejects malformed, fenced, invented, and ungrounded JSON from %s",
    async (style) => {
      const invalid = [
        '{"action":',
        "null",
        "[]",
        "",
        " ",
        `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``,
        `Here is my decision: ${JSON.stringify(payload)}`,
        `${JSON.stringify(payload)}${JSON.stringify(payload)}`,
        JSON.stringify({ ...payload, action: "kill" }),
        JSON.stringify({ ...payload, memoryIds: ["invented"] }),
        JSON.stringify({ ...payload, lesson: "An invented lesson", memoryIds: [] }),
        JSON.stringify({ ...payload, targetId: "unseen-apple" }),
        JSON.stringify({ ...payload, destination: { x: 12, y: 10 } }),
        JSON.stringify({ ...payload, shell: "not-an-allowed-field" }),
      ];
      for (const text of invalid) {
        const fetch = vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValue(Response.json(compatibleResponse(style, text)));
        await expect(
          createProviderClient(compatibleConfig(style), { fetch }).decide(
            context(),
            new AbortController().signal,
          ),
        ).rejects.toMatchObject({ category: "invalid" });
        expect(fetch).toHaveBeenCalledTimes(1);
      }
    },
  );

  it.each(["length", "content_filter", "tool_calls", "function_call", null, undefined])(
    "rejects chat finish_reason %s even with apparently valid JSON",
    async (finish_reason) => {
      const response = chatResponse();
      Object.assign(response.choices[0]!, { finish_reason });
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(response));
      await expect(
        createProviderClient(compatibleConfig(), { fetch }).decide(
          context(),
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ category: "invalid" });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { refusal: "I refuse." },
    { content: null },
    { content: [{ type: "text", text: JSON.stringify(payload) }] },
    { role: "user" },
    { tool_calls: [{ function: { name: "execute", arguments: "{}" } }] },
    { function_call: { name: "execute", arguments: "{}" } },
  ])("rejects refused or non-text assistant chat output", async (extra) => {
    const response = chatResponse();
    Object.assign(response.choices[0]!.message, extra);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(response));
    await expect(
      createProviderClient(compatibleConfig(), { fetch }).decide(
        context(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ category: "invalid" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { choices: [] },
    { choices: [chatResponse().choices[0], chatResponse().choices[0]] },
    { choices: [{ finish_reason: "stop" }] },
    { ...chatResponse(), error: { message: "SECRET_PROVIDER_BODY" } },
    null,
    [],
  ])("rejects malformed or ambiguous chat envelopes", async (response) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(response));
    await expect(
      createProviderClient(compatibleConfig(), { fetch }).decide(
        context(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ category: "invalid" });
  });

  it("accepts empty tool metadata without treating it as a tool request", async () => {
    const response = chatResponse();
    Object.assign(response.choices[0]!.message, { tool_calls: [], function_call: null });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(response));
    expect(
      await createProviderClient(compatibleConfig(), { fetch }).decide(
        context(),
        new AbortController().signal,
      ),
    ).toEqual(validateMindDecision(payload, context()));
  });

  it.each([
    { ...openaiResponse(), status: "incomplete" },
    { ...openaiResponse(), incomplete_details: { reason: "max_output_tokens" } },
    { ...openaiResponse(), error: { message: "SECRET_PROVIDER_BODY" } },
    {
      status: "completed",
      output: [{ type: "message", content: [{ type: "refusal", refusal: "No" }] }],
    },
    {
      status: "completed",
      output: [
        {
          type: "message",
          status: "incomplete",
          content: [{ type: "output_text", text: JSON.stringify(payload) }],
        },
      ],
    },
    {
      status: "completed",
      output: [
        ...openaiResponse().output,
        { type: "function_call", name: "execute", arguments: "{}" },
      ],
    },
    { status: "completed", output: [...openaiResponse().output, openaiResponse().output[1]] },
  ])(
    "rejects incomplete/refused/tool-bearing or ambiguous compatible Responses",
    async (response) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(response));
      await expect(
        createProviderClient(compatibleConfig("responses"), { fetch }).decide(
          context(),
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ category: "invalid" });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["chat-completions", "responses"] as const)(
    "bounds %s bodies and rejects non-JSON envelopes",
    async (style) => {
      for (const body of ["x".repeat(65_537), "<html>provider error</html>"]) {
        const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body));
        await expect(
          createProviderClient(compatibleConfig(style), { fetch }).decide(
            context(),
            new AbortController().signal,
          ),
        ).rejects.toMatchObject({ category: "invalid" });
        expect(fetch).toHaveBeenCalledTimes(1);
      }
    },
  );

  it.each(["chat-completions", "responses"] as const)(
    "maps %s HTTP failures to safe categories without retry or response-body disclosure",
    async (style) => {
      for (const [status, category] of [
        [401, "auth"],
        [403, "auth"],
        [429, "rate"],
        [500, "unavailable"],
      ] as const) {
        const fetch = vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValue(
            new Response("SECRET_BODY PRIVATE_MEMORY FAKE_OPENAI_KEY", { status }),
          );
        const failure = await createProviderClient(compatibleConfig(style), { fetch })
          .decide(context(), new AbortController().signal)
          .catch((error: unknown) => error);
        expect(failure).toMatchObject({ category });
        expect(safeProviderError(failure)).not.toMatch(
          /SECRET_BODY|PRIVATE_MEMORY|FAKE_OPENAI_KEY/,
        );
        expect(fetch).toHaveBeenCalledTimes(1);
      }
    },
  );

  it.each(["chat-completions", "responses"] as const)(
    "does not start aborted %s requests or accept a response arriving after cancellation",
    async (style) => {
      const controller = new AbortController();
      controller.abort();
      const fetch = vi.fn<typeof globalThis.fetch>();
      await expect(
        createProviderClient(compatibleConfig(style), { fetch }).decide(
          context(),
          controller.signal,
        ),
      ).rejects.toMatchObject({ category: "unavailable" });
      expect(fetch).not.toHaveBeenCalled();
      const pending = new AbortController();
      let resolve!: (value: Response) => void;
      fetch.mockImplementation(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      );
      const result = createProviderClient(compatibleConfig(style), { fetch }).decide(
        context(),
        pending.signal,
      );
      expect(fetch.mock.calls[0]![1]!.signal).toBe(pending.signal);
      pending.abort();
      resolve(Response.json(compatibleResponse(style)));
      await expect(result).rejects.toMatchObject({ category: "unavailable" });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
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

describe("SDK and endpoint boundary regressions", () => {
  it("rejects a foreign origin before fetch and forces no redirects for same-origin Requests", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ ok: true }));
    await createProviderClient(bedrockConfig(), { fetch }).decide(
      context(),
      new AbortController().signal,
    );
    const guarded = bedrockSDK.options[0]!.fetch as typeof globalThis.fetch;
    await expect(
      guarded("https://unconfigured.example/collect", {
        headers: { Authorization: "Bearer FIXTURE_TOKEN" },
      }),
    ).rejects.toMatchObject({ category: "unavailable" });
    expect(fetch).not.toHaveBeenCalled();
    const request = new Request("https://bedrock-runtime.us-east-1.amazonaws.com/model/test", {
      headers: { Authorization: "Bearer FIXTURE_TOKEN" },
      redirect: "follow",
    });
    await guarded(request);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe(request);
    expect(fetch.mock.calls[0]![1]!.redirect).toBe("error");
  });

  it.each(["operator-selected-claude", "custom-deployment-id", "claude-sonnet-5"])(
    "passes editable Anthropic model %s through with only its existing special options",
    async (model) => {
      const anthropic = vi.fn<MessageTransport>().mockResolvedValue(toolResponse());
      await createProviderClient({ ...anthropicConfig(), model }, { anthropic }).decide(
        context(),
        new AbortController().signal,
      );
      const request = anthropic.mock.calls[0]![0];
      expect(request.model).toBe(model);
      if (model === "claude-sonnet-5") {
        expect(request.thinking).toEqual({ type: "adaptive" });
        expect(request.output_config).toEqual({ effort: "low" });
      } else {
        expect(request).not.toHaveProperty("thinking");
        expect(request).not.toHaveProperty("output_config");
      }
      expect(anthropic).toHaveBeenCalledTimes(1);
    },
  );
});
