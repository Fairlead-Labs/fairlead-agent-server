import { randomUUID } from "node:crypto";
import { count, postJson } from "./http.js";
import { signSigV4, type AwsCredentials } from "./sigv4.js";
import {
  callsById,
  isJsonObject,
  ModelProtocolError,
  ownOrigin,
  wireCallId,
  type AssistantPart,
  type JsonObject,
  type JsonValue,
  type ModelClient,
  type ModelRequest,
  type ModelTurn,
  type StopReason,
  type ToolCallPart,
} from "./types.js";

/**
 * Where an Anthropic Messages request goes and how it signs in: the Claude
 * API with an API key, Vertex AI with a Google access token (the metadata
 * server's, or the team's own identity), Bedrock with SigV4 (the team's
 * role). `baseUrl` replaces the provider's address (the fakes).
 */
export type AnthropicRoute =
  | { readonly kind: "claude-api"; readonly apiKey: string; readonly baseUrl?: string }
  | { readonly kind: "vertex"; readonly project: string; readonly region: string; readonly accessToken: () => Promise<string>; readonly baseUrl?: string }
  | { readonly kind: "bedrock"; readonly region: string; readonly credentials: () => Promise<AwsCredentials>; readonly baseUrl?: string };

export interface AnthropicClientOptions {
  readonly route: AnthropicRoute;
  /** The Claude API's and Vertex AI's model id; Bedrock's model or inference profile id (`eu.anthropic.…`). */
  readonly model: string;
  /** The cache breakpoints' lifetime: 5 minutes (the default) or an hour where the profile pays for it. */
  readonly cacheTtl?: "5m" | "1h";
  /** The runner's call ids (default: a random UUID). */
  readonly mintCallId?: () => string;
  readonly now?: () => Date;
}

const FORMAT = "anthropic-messages";

/** Vertex AI's address for a region: `global`, a multi-region (`eu`, `us`) or a region. */
export function vertexHost(region: string): string {
  if (region === "global") return "https://aiplatform.googleapis.com";
  if (region === "eu" || region === "us") return `https://aiplatform.${region}.rep.googleapis.com`;
  return `https://${region}-aiplatform.googleapis.com`;
}

export function createAnthropicClient({ route, model, cacheTtl = "5m", mintCallId = randomUUID, now = () => new Date() }: AnthropicClientOptions): ModelClient {
  const cacheControl: JsonObject = cacheTtl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };

  const providerId = (call: ToolCallPart): string => {
    if (ownOrigin(call.origin, FORMAT, model) && isJsonObject(call.origin.raw) && typeof call.origin.raw["id"] === "string") return call.origin.raw["id"];
    return wireCallId("ag_", call.id);
  };

  function body(request: ModelRequest): JsonObject {
    const calls = callsById(request.messages);
    const messages: JsonObject[] = request.messages.map((message) => {
      if (message.role === "user") {
        // Tool results first, as the API requires, then the text.
        const ordered = [...message.content.filter((part) => part.type === "tool_result"), ...message.content.filter((part) => part.type === "text")];
        return {
          role: "user",
          content: ordered.map((part): JsonObject =>
            part.type === "text"
              ? { type: "text", text: part.text }
              : { type: "tool_result", tool_use_id: providerId(calls.get(part.callId)!), content: part.content, ...(part.isError ? { is_error: true } : {}) },
          ),
        };
      }
      const content: JsonValue[] = [];
      for (const part of message.parts) {
        if (part.type === "reasoning") {
          // Thinking blocks back unchanged and in order, only to the model that wrote them.
          if (ownOrigin(part.origin, FORMAT, model)) content.push(part.origin.raw);
        } else if (part.type === "text") content.push(ownOrigin(part.origin, FORMAT, model) ? part.origin.raw : { type: "text", text: part.text });
        else content.push(ownOrigin(part.origin, FORMAT, model) ? part.origin.raw : { type: "tool_use", id: providerId(part), name: part.name, input: part.input });
      }
      return { role: "assistant", content };
    });
    // Explicit breakpoints: the system's end (the tools and system before it), and the last two user
    // messages' ends, so each step reads the previous step's entry exactly and writes its own.
    const users = messages.flatMap((message, index) => (message["role"] === "user" ? [index] : [])).slice(-2);
    for (const index of users) {
      const content = messages[index]!["content"] as JsonObject[];
      const last = content.at(-1);
      if (last) content[content.length - 1] = { ...last, cache_control: cacheControl };
    }
    const system = request.system.map((text, index): JsonObject => ({ type: "text", text, ...(index === request.system.length - 1 ? { cache_control: cacheControl } : {}) }));
    return {
      ...(route.kind === "claude-api" ? { model } : { anthropic_version: route.kind === "vertex" ? "vertex-2023-10-16" : "bedrock-2023-05-31" }),
      max_tokens: request.maxOutputTokens,
      ...(system.length > 0 ? { system } : {}),
      messages,
      // Only the caller's function tools, each copied field by field: nothing else can reach the request.
      ...(request.tools.length > 0
        ? { tools: request.tools.map((tool): JsonObject => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })) }
        : {}),
      ...(request.toolChoice === "none" ? { tool_choice: { type: "none" } } : {}),
      ...(request.effort ? { output_config: { effort: request.effort } } : {}),
    };
  }

  async function send(payload: string, signal: AbortSignal | undefined): Promise<JsonObject> {
    if (route.kind === "claude-api") {
      return postJson(`${route.baseUrl ?? "https://api.anthropic.com"}/v1/messages`, { "x-api-key": route.apiKey, "anthropic-version": "2023-06-01" }, payload, signal);
    }
    if (route.kind === "vertex") {
      const base = route.baseUrl ?? vertexHost(route.region);
      const path = `/v1/projects/${encodeURIComponent(route.project)}/locations/${encodeURIComponent(route.region)}/publishers/anthropic/models/${encodeURIComponent(model)}:rawPredict`;
      return postJson(`${base}${path}`, { authorization: `Bearer ${await route.accessToken()}` }, payload, signal);
    }
    const url = new URL(`${route.baseUrl ?? `https://bedrock-runtime.${route.region}.amazonaws.com`}/model/${encodeURIComponent(model)}/invoke`);
    const headers = { "content-type": "application/json", accept: "application/json" };
    const signed = signSigV4({ method: "POST", url, headers, body: payload, region: route.region, service: "bedrock" }, await route.credentials(), now());
    return postJson(url.toString(), { ...headers, ...signed }, payload, signal);
  }

  return {
    format: FORMAT,
    model,
    async complete(request: ModelRequest): Promise<ModelTurn> {
      const answer = await send(JSON.stringify(body(request)), request.signal);
      const content = answer["content"];
      if (!Array.isArray(content)) throw new ModelProtocolError("The answer holds no content");
      const parts: AssistantPart[] = content.map((block): AssistantPart => {
        if (!isJsonObject(block)) throw new ModelProtocolError("A content block is not an object");
        const origin = { format: FORMAT, model, raw: block } as const;
        if (block["type"] === "text" && typeof block["text"] === "string") return { type: "text", text: block["text"], origin };
        if (block["type"] === "tool_use" && typeof block["id"] === "string" && typeof block["name"] === "string") {
          const input = block["input"];
          return isJsonObject(input)
            ? { type: "tool_call", id: mintCallId(), name: block["name"], input, origin }
            : { type: "tool_call", id: mintCallId(), name: block["name"], input: {}, malformed: true, origin };
        }
        // Thinking, redacted thinking and anything newer: opaque, round-tripped.
        return { type: "reasoning", origin };
      });
      const stopReason = answer["stop_reason"];
      const stop: StopReason | undefined =
        stopReason === "end_turn" || stopReason === "stop_sequence"
          ? "end"
          : stopReason === "tool_use"
            ? "tool_calls"
            : stopReason === "refusal"
              ? "refusal"
              : stopReason === "max_tokens" || stopReason === "model_context_window_exceeded"
                ? "cut_off"
                : undefined;
      if (!stop) throw new ModelProtocolError("The answer's stop reason is unknown");
      const usage = isJsonObject(answer["usage"]) ? answer["usage"] : {};
      const cachedRead = count(usage["cache_read_input_tokens"]);
      const cacheWrite = count(usage["cache_creation_input_tokens"]);
      const details = isJsonObject(answer["stop_details"]) ? answer["stop_details"] : undefined;
      const category = details && typeof details["category"] === "string" ? details["category"] : undefined;
      return {
        parts,
        stop,
        ...(stop === "refusal" && category ? { refusalCategory: category } : {}),
        usage: { input: count(usage["input_tokens"]) + cachedRead + cacheWrite, cachedRead, cacheWrite, output: count(usage["output_tokens"]) },
        cacheWindowSeconds: cachedRead + cacheWrite > 0 ? (cacheTtl === "1h" ? 3600 : 300) : 0,
      };
    },
  };
}
