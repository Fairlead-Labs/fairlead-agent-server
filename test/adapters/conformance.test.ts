import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { metadataAccessToken } from "../../src/google.js";
import {
  createAnthropicClient,
  createOpenAIClient,
  ModelHttpError,
  ModelProtocolError,
  retryAfterSeconds,
  type FunctionTool,
  type Message,
  type ModelClient,
  type ModelRequest,
  type WireFormat,
} from "../../src/index.js";
import { startFakeAnthropic, startFakeOpenAI, type FakeAnthropic, type FakeHttp, type FakeOpenAI, type RecordedRequest } from "../../src/testing/index.js";

/**
 * Requirement 0001, RN14–RN17 (ADR 0001 §4): one conformance suite over
 * every adapter and way in, against the fake provider servers in
 * `src/testing` (real HTTP on loopback). The fakes refuse
 * what the providers refuse (a forced tool choice, a result for no call,
 * thinking or reasoning not sent back unchanged to its model, anything
 * needing stored state), so a passing step is a request the wire accepts.
 */

let anthropic: FakeAnthropic;
let openai: FakeOpenAI;

beforeAll(async () => {
  anthropic = await startFakeAnthropic();
  openai = await startFakeOpenAI();
  anthropic.awsSecrets.set("ASIAFAKEBEDROCK", "bedrock-secret");
  openai.azureAdmits = (token) => token === "entra-token-for-azure";
});
afterEach(() => {
  anthropic.reset();
  openai.reset();
});
afterAll(async () => {
  await anthropic.close();
  await openai.close();
});

/** Runner ids with characters no provider takes, so mapping and pairing are exercised. */
const minter = () => {
  let next = 0;
  return () => `run-7:step-${(next += 1)}/call#${next}`;
};

interface Way {
  name: string;
  format: WireFormat;
  fake: () => FakeHttp;
  client: (model: string, mint: () => string) => ModelClient;
  /** The route this way's requests arrive on. */
  route: string;
}

const MODEL = { "anthropic-messages": "claude-opus-5-5", "openai-responses": "gpt-6.1" } as const;

const WAYS: Way[] = [
  {
    name: "Anthropic Messages, the Claude API (API key)",
    format: "anthropic-messages",
    fake: () => anthropic,
    route: "claude-api",
    client: (model, mintCallId) => createAnthropicClient({ model, mintCallId, route: { kind: "claude-api", apiKey: anthropic.apiKey, baseUrl: anthropic.url } }),
  },
  {
    name: "Anthropic Messages, Vertex AI (the metadata server's token)",
    format: "anthropic-messages",
    fake: () => anthropic,
    route: "vertex",
    client: (model, mintCallId) =>
      createAnthropicClient({
        model,
        mintCallId,
        route: { kind: "vertex", project: "team-project", region: "eu", baseUrl: anthropic.url, accessToken: metadataAccessToken({ baseUrl: anthropic.url }) },
      }),
  },
  {
    name: "Anthropic Messages, Bedrock (SigV4, temporary credentials)",
    format: "anthropic-messages",
    fake: () => anthropic,
    route: "bedrock",
    client: (model, mintCallId) =>
      createAnthropicClient({
        model: `eu.anthropic.${model}`,
        mintCallId,
        route: {
          kind: "bedrock",
          region: "eu-central-1",
          baseUrl: anthropic.url,
          credentials: async () => ({ accessKeyId: "ASIAFAKEBEDROCK", secretAccessKey: "bedrock-secret", sessionToken: "session-token" }),
        },
      }),
  },
  {
    name: "OpenAI Responses, OpenAI (API key)",
    format: "openai-responses",
    fake: () => openai,
    route: "openai",
    client: (model, mintCallId) => createOpenAIClient({ model, mintCallId, cacheKey: "run-7", route: { kind: "openai", apiKey: openai.apiKey, baseUrl: openai.url } }),
  },
  {
    name: "OpenAI Responses, Azure OpenAI (key)",
    format: "openai-responses",
    fake: () => openai,
    route: "azure",
    client: (model, mintCallId) => createOpenAIClient({ model, mintCallId, route: { kind: "azure", endpoint: `${openai.url}/`, auth: { apiKey: openai.azureKey } } }),
  },
  {
    name: "OpenAI Responses, Azure OpenAI (Entra ID)",
    format: "openai-responses",
    fake: () => openai,
    route: "azure",
    client: (model, mintCallId) =>
      createOpenAIClient({ model, mintCallId, route: { kind: "azure", endpoint: openai.url, auth: { accessToken: async () => "entra-token-for-azure" } } }),
  },
];

const TOOLS: FunctionTool[] = [
  { name: "list_tasks", description: "Lists tasks.", inputSchema: { type: "object", properties: { projectId: { type: "string" } }, required: ["projectId"] } },
  { name: "read_message", description: "Reads a message.", inputSchema: { type: "object", properties: { uid: { type: "integer" } } } },
  { name: "read_playbook", description: "Reads a playbook.", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
];

/** Provider-shaped answers, one builder per wire format. */
const WIRE = {
  "anthropic-messages": {
    calls: (model: string, calls: { id: string; name: string; input: unknown }[]) => ({
      id: "msg_01",
      type: "message",
      role: "assistant",
      model,
      content: [
        { type: "thinking", thinking: "", signature: `sig-${calls.map((call) => call.id).join("-")}` },
        { type: "text", text: "Looking at both." },
        ...calls.map((call) => ({ type: "tool_use", ...call })),
        { type: "redacted_thinking", data: "opaque-redacted" },
      ],
      stop_reason: "tool_use",
      stop_details: null,
      usage: { input_tokens: 120, cache_creation_input_tokens: 900, cache_read_input_tokens: 4000, output_tokens: 80 },
    }),
    text: (model: string, text: string, stop = "end_turn") => ({
      id: "msg_02",
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text }],
      stop_reason: stop,
      stop_details: stop === "refusal" ? { type: "refusal", category: "cyber", explanation: "declined" } : null,
      usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 },
    }),
  },
  "openai-responses": {
    calls: (model: string, calls: { id: string; name: string; input: unknown }[]) => ({
      id: "resp_01",
      object: "response",
      model,
      status: "completed",
      output: [
        { type: "reasoning", id: "rs_01", summary: [], encrypted_content: `gAAAA-${calls.map((call) => call.id).join("-")}` },
        { type: "message", id: "msg_01", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Looking at both.", annotations: [] }] },
        ...calls.map((call, index) => ({ type: "function_call", id: `fc_0${index}`, call_id: call.id, name: call.name, arguments: JSON.stringify(call.input), status: "completed" })),
      ],
      usage: { input_tokens: 5020, input_tokens_details: { cached_tokens: 4000 }, output_tokens: 80 },
    }),
    text: (model: string, text: string, stop = "end_turn") => ({
      id: "resp_02",
      object: "response",
      model,
      status: stop === "max_tokens" ? "incomplete" : "completed",
      ...(stop === "max_tokens" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
      output: [
        {
          type: "message",
          id: "msg_02",
          role: "assistant",
          status: "completed",
          content: [stop === "refusal" ? { type: "refusal", refusal: "I can't help with that." } : { type: "output_text", text, annotations: [] }],
        },
      ],
      usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5 },
    }),
  },
} as const;

const PROVIDER_IDS = { "anthropic-messages": ["toolu_01A", "toolu_01B"], "openai-responses": ["call_01A", "call_01B"] } as const;

/** What a request sent, read per wire format. */
const READ = {
  "anthropic-messages": {
    turns: (body: any): any[] => body.messages,
    reasoning: (body: any) => body.messages.flatMap((message: any) => (message.role === "assistant" ? message.content.filter((block: any) => /thinking/.test(block.type)) : [])),
    callIds: (body: any): string[] =>
      body.messages.flatMap((message: any) => (message.role === "assistant" ? message.content.filter((block: any) => block.type === "tool_use").map((block: any) => block.id) : [])),
    resultIds: (body: any): string[] =>
      body.messages.flatMap((message: any) => (Array.isArray(message.content) ? message.content.filter((block: any) => block.type === "tool_result").map((block: any) => block.tool_use_id) : [])),
  },
  "openai-responses": {
    turns: (body: any): any[] => body.input,
    reasoning: (body: any) => body.input.filter((item: any) => item.type === "reasoning"),
    callIds: (body: any): string[] => body.input.filter((item: any) => item.type === "function_call").map((item: any) => item.call_id),
    resultIds: (body: any): string[] => body.input.filter((item: any) => item.type === "function_call_output").map((item: any) => item.call_id),
  },
} as const;

const ask = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });
const request = (messages: Message[], extra: Partial<ModelRequest> = {}): ModelRequest => ({
  system: ["You are an agent, working for the team.", "Playbooks: Working a task."],
  messages,
  tools: TOOLS,
  effort: "high",
  maxOutputTokens: 16000,
  ...extra,
});

describe.each(WAYS)("$name", (way) => {
  const model = MODEL[way.format];
  const wire = WIRE[way.format];
  const read = READ[way.format];
  const fake = () => way.fake();
  /** The requests this test sent, each checked to have arrived on this way and been accepted. */
  const sent = (from: number) => {
    const requests = fake().requests.slice(from).filter((request: RecordedRequest) => request.route !== "metadata");
    for (const request of requests) {
      expect(request.route).toBe(way.route);
      expect(request.problem).toBeUndefined();
    }
    return requests.map((request) => request.body);
  };

  it("parallel tool calls: runner ids minted, reasoning round-tripped unchanged and in order, ids paired back, the whole conversation sent each step", async () => {
    const from = fake().requests.length;
    const client = way.client(model, minter());
    expect(client.format).toBe(way.format);
    const [first, second] = PROVIDER_IDS[way.format];
    fake().script(
      wire.calls(model, [
        { id: first, name: "list_tasks", input: { projectId: "p1" } },
        { id: second, name: "read_message", input: { uid: 42 } },
      ]),
      wire.text(model, "Both done."),
    );
    const conversation: Message[] = [ask("Work the task.")];
    const turn = await client.complete(request(conversation));
    expect(turn.stop).toBe("tool_calls");
    const calls = turn.parts.flatMap((part) => (part.type === "tool_call" ? [part] : []));
    expect(calls.map(({ id, name, input }) => ({ id, name, input }))).toEqual([
      { id: "run-7:step-1/call#1", name: "list_tasks", input: { projectId: "p1" } },
      { id: "run-7:step-2/call#2", name: "read_message", input: { uid: 42 } },
    ]);
    expect(turn.parts.some((part) => part.type === "reasoning")).toBe(true);
    expect(turn.usage).toEqual(way.format === "anthropic-messages" ? { input: 5020, cachedRead: 4000, cacheWrite: 900, output: 80 } : { input: 5020, cachedRead: 4000, cacheWrite: 0, output: 80 });
    expect(turn.cacheWindowSeconds).toBe(300);

    // Stored and read back as JSON, as a checkpoint would.
    conversation.push(JSON.parse(JSON.stringify({ role: "assistant", parts: turn.parts })) as Message);
    conversation.push({
      role: "user",
      content: [
        { type: "tool_result", callId: calls[1]!.id, content: "<untrusted-ab12>Subject: Invoice</untrusted-ab12>" },
        { type: "tool_result", callId: calls[0]!.id, content: "403 Access denied", isError: true },
      ],
    });
    const done = await client.complete(request(conversation));
    expect(done.stop).toBe("end");
    expect(done.parts).toMatchObject([{ type: "text", text: "Both done." }]);

    const [one, two] = sent(from);
    // RN17: each step sends the whole conversation, the earlier request's turns first and unchanged.
    expect(read.turns(two).slice(0, read.turns(one).length).map(withoutCacheControl)).toEqual(read.turns(one).map(withoutCacheControl));
    // The provider's own ids back, each result paired with its call.
    expect(read.callIds(two)).toEqual([first, second]);
    expect(read.resultIds(two).sort()).toEqual([first, second].sort());
    // Reasoning exactly as answered, in its place.
    const answered = way.format === "anthropic-messages" ? (WIRE["anthropic-messages"].calls(model, []).content as any[]).filter((block) => /thinking/.test(block.type)) : [];
    if (way.format === "anthropic-messages") {
      expect(read.reasoning(two)).toEqual([{ ...answered[0], signature: `sig-${first}-${second}` }, answered[1]]);
      const assistant = two.messages[1].content.map((block: any) => block.type);
      expect(assistant).toEqual(["thinking", "text", "tool_use", "tool_use", "redacted_thinking"]);
    } else {
      expect(read.reasoning(two)).toEqual([{ type: "reasoning", id: "rs_01", summary: [], encrypted_content: `gAAAA-${first}-${second}` }]);
      expect(two.input.map((item: any) => item.type ?? item.role)).toEqual(["user", "reasoning", "message", "function_call", "function_call", "function_call_output", "function_call_output"]);
    }
  });

  it("a refusal", async () => {
    fake().script(wire.text(model, "", "refusal"));
    const turn = await way.client(model, minter()).complete(request([ask("Something it declines.")]));
    expect(turn.stop).toBe("refusal");
    if (way.format === "anthropic-messages") expect(turn.refusalCategory).toBe("cyber");
  });

  it("a cut-off answer", async () => {
    fake().script(wire.text(model, "The first half of", "max_tokens"));
    const turn = await way.client(model, minter()).complete(request([ask("Write at length.")]));
    expect(turn.stop).toBe("cut_off");
    expect(turn.parts).toMatchObject([{ type: "text", text: "The first half of" }]);
  });

  it("reasoning goes only to the model that made it; another model's calls are rebuilt with mapped ids and paired back", async () => {
    const from = fake().requests.length;
    const other = way.format === "anthropic-messages" ? "openai-responses" : "anthropic-messages";
    const runnerIds = ["run-1:step-3/call#1", "run-1:step-3/call#2"];
    const conversation: Message[] = [
      ask("Work the task."),
      {
        role: "assistant",
        parts: [
          { type: "reasoning", origin: { format: other, model: "someone-else", raw: { type: "reasoning", id: "rs_x", encrypted_content: "foreign" } } },
          { type: "reasoning", origin: { format: way.format, model: `${model}-older`, raw: { type: "thinking", thinking: "", signature: "older-model" } } },
          { type: "text", text: "Checking.", origin: { format: other, model: "someone-else", raw: { type: "text", text: "Checking." } } },
          { type: "tool_call", id: runnerIds[0]!, name: "list_tasks", input: { projectId: "p1" }, origin: { format: other, model: "someone-else", raw: { id: "foreign-id" } } },
          { type: "tool_call", id: runnerIds[1]!, name: "read_message", input: { uid: 7 } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", callId: runnerIds[0]!, content: "[]" },
          { type: "tool_result", callId: runnerIds[1]!, content: "{}" },
        ],
      },
    ];
    fake().script(wire.text(model, "Resumed."));
    const turn = await way.client(model, minter()).complete(request(conversation));
    expect(turn.stop).toBe("end");
    const [body] = sent(from);
    expect(read.reasoning(body)).toEqual([]);
    expect(JSON.stringify(body)).not.toMatch(/foreign|older-model|someone-else/);
    const ids = read.callIds(body);
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(new Set(ids).size).toBe(2);
    expect(read.resultIds(body)).toEqual(ids);
  });

  it("a 429's Retry-After is surfaced, and no error names the credential", async () => {
    fake().script({ status: 429, headers: { "retry-after": "7" }, body: { type: "error", error: { type: "rate_limit_error", message: "slow down" } } });
    const error = await way
      .client(model, minter())
      .complete(request([ask("Hello.")]))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ModelHttpError);
    expect(error).toMatchObject({ status: 429, providerType: "rate_limit_error", retryAfterSeconds: 7 });
    for (const secret of [anthropic.apiKey, openai.apiKey, openai.azureKey, "bedrock-secret", "entra-token-for-azure", anthropic.metadataToken])
      expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(secret);
  });

  it("negative (RN15–RN17): no forced tool choice, only the caller's function tools, no hosted tool, no provider-side state", async () => {
    const from = fake().requests.length;
    const sneaky = [
      ...TOOLS,
      // What another layer might try to slip in: extra fields on a tool are never copied.
      { name: "web_search", description: "x", inputSchema: { type: "object" }, type: "web_search_20260209", server_url: "https://mcp.example", allowed_callers: ["code_execution_20260120"] } as FunctionTool,
    ];
    fake().script(wire.text(model, "ok"), wire.text(model, "summary"));
    const client = way.client(model, minter());
    await client.complete(request([ask("Hello.")], { tools: sneaky }));
    await client.complete(request([ask("Hello.")], { toolChoice: "none" }));
    const bodies = sent(from);
    for (const [index, body] of bodies.entries()) {
      const text = JSON.stringify(body);
      expect(text).not.toMatch(/web_search_|code_execution|mcp_servers|mcp_toolset|server_url|allowed_callers|previous_response_id|"conversation"|"background"|"container"/);
      const names = (body.tools as any[]).map((tool) => tool.name);
      expect(names).toEqual(index === 0 ? [...TOOLS.map((tool) => tool.name), "web_search"] : TOOLS.map((tool) => tool.name));
      if (way.format === "anthropic-messages") {
        for (const tool of body.tools) expect(Object.keys(tool).sort()).toEqual(["description", "input_schema", "name"]);
        // RN15: no forced tool choice; the summary's call says none, and nothing else is ever sent.
        expect(body.tool_choice).toEqual(index === 0 ? undefined : { type: "none" });
      } else {
        for (const tool of body.tools) expect(Object.keys(tool).sort()).toEqual(["description", "name", "parameters", "strict", "type"]);
        for (const tool of body.tools) expect(tool.type).toBe("function");
        expect(body.tool_choice).toEqual(index === 0 ? undefined : "none");
        expect(body.store).toBe(false);
        expect(body.include).toEqual(["reasoning.encrypted_content"]);
      }
    }
    // The types cannot express a hosted tool or a forced choice.
    // @ts-expect-error a provider-hosted tool has no place in a FunctionTool
    const hosted: FunctionTool = { name: "web_search", description: "", inputSchema: {}, type: "web_search_20260209" };
    // @ts-expect-error a forced tool choice cannot be asked for
    const forced: ModelRequest = { ...request([]), toolChoice: "any" };
    expect([hosted, forced]).toHaveLength(2);
  });

  it("negative: a result for no call is sent nowhere", async () => {
    const from = fake().requests.length;
    const error = await way
      .client(model, minter())
      .complete(request([ask("Hello."), { role: "assistant", parts: [{ type: "text", text: "Hm." }] }, { role: "user", content: [{ type: "tool_result", callId: "nobody", content: "x" }] }]))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ModelProtocolError);
    expect(fake().requests.length).toBe(from);
  });

  it("negative: a wrong credential is the provider's refusal", async () => {
    const wrong =
      way.route === "claude-api"
        ? createAnthropicClient({ model, route: { kind: "claude-api", apiKey: "sk-ant-wrong", baseUrl: anthropic.url } })
        : way.route === "vertex"
          ? createAnthropicClient({ model, route: { kind: "vertex", project: "p", region: "eu", baseUrl: anthropic.url, accessToken: async () => "ya29.wrong" } })
          : way.route === "bedrock"
            ? createAnthropicClient({ model, route: { kind: "bedrock", region: "eu-central-1", baseUrl: anthropic.url, credentials: async () => ({ accessKeyId: "ASIAFAKEBEDROCK", secretAccessKey: "wrong" }) } })
            : way.route === "openai"
              ? createOpenAIClient({ model, route: { kind: "openai", apiKey: "sk-wrong", baseUrl: openai.url } })
              : createOpenAIClient({ model, route: { kind: "azure", endpoint: openai.url, auth: { apiKey: "wrong" } } });
    const error = await wrong.complete(request([ask("Hello.")])).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ModelHttpError);
    expect([401, 403]).toContain((error as ModelHttpError).status);
  });
});

const withoutCacheControl = (turn: any): any =>
  Array.isArray(turn?.content) ? { ...turn, content: turn.content.map(({ cache_control: _drop, ...block }: any) => block) } : turn;

describe("Anthropic Messages: explicit cache breakpoints", () => {
  it("on the system's end and on the last two user messages' ends; an hour where the profile pays for it", async () => {
    const from = anthropic.requests.length;
    const usage = { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 3000, output_tokens: 5 };
    anthropic.script({ ...WIRE["anthropic-messages"].text("claude-sonnet-5-5", "ok"), usage }, { ...WIRE["anthropic-messages"].text("claude-sonnet-5-5", "ok"), usage: { ...usage, cache_read_input_tokens: 0 } });
    const conversation: Message[] = [ask("Work the task."), { role: "assistant", parts: [{ type: "text", text: "Noted." }] }, ask("A comment arrived.")];
    const client = createAnthropicClient({ model: "claude-sonnet-5-5", cacheTtl: "1h", route: { kind: "claude-api", apiKey: anthropic.apiKey, baseUrl: anthropic.url } });
    const turn = await client.complete(request(conversation));
    expect(turn.cacheWindowSeconds).toBe(3600);
    const cold = await client.complete(request([ask("Short.")]));
    expect(cold.cacheWindowSeconds).toBe(0);
    const body = anthropic.requests[from]!.body;
    const hour = { type: "ephemeral", ttl: "1h" };
    expect(body.system.map((block: any) => block.cache_control)).toEqual([undefined, hour]);
    expect(body.messages.map((message: any) => message.content.at(-1).cache_control)).toEqual([hour, undefined, hour]);
    expect(body.output_config).toEqual({ effort: "high" });
    expect(body.thinking).toBeUndefined();
  });
});

describe("OpenAI Responses: effort", () => {
  it("max is OpenAI's xhigh; the run's cache key goes along", async () => {
    const from = openai.requests.length;
    openai.script(WIRE["openai-responses"].text("gpt-6.1", "ok"));
    await createOpenAIClient({ model: "gpt-6.1", cacheKey: "run-9", route: { kind: "openai", apiKey: openai.apiKey, baseUrl: openai.url } }).complete(request([ask("Hi.")], { effort: "max" }));
    expect(openai.requests[from]!.body).toMatchObject({ reasoning: { effort: "xhigh" }, prompt_cache_key: "run-9", max_output_tokens: 16000, instructions: "You are an agent, working for the team.\n\nPlaybooks: Working a task." });
  });
});

describe("Retry-After", () => {
  it("reads seconds and an HTTP date", () => {
    expect(retryAfterSeconds("12")).toBe(12);
    expect(retryAfterSeconds("Wed, 21 Oct 2026 07:28:30 GMT", Date.parse("Wed, 21 Oct 2026 07:28:00 GMT"))).toBe(30);
    expect(retryAfterSeconds(null)).toBeUndefined();
    expect(retryAfterSeconds("soon")).toBeUndefined();
  });
});
