import { randomUUID } from "node:crypto";
import { count, postJson } from "./http.js";
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
 * Where an OpenAI Responses request goes: OpenAI with an API key (a
 * project's EU address in `baseUrl`), or an Azure OpenAI resource with its
 * key or an Entra ID token (the team's federated identity). Azure's `model`
 * is the deployment's name.
 */
export type OpenAIRoute =
  | { readonly kind: "openai"; readonly apiKey: string; readonly baseUrl?: string }
  | { readonly kind: "azure"; readonly endpoint: string; readonly auth: { readonly apiKey: string } | { readonly accessToken: () => Promise<string> } };

export interface OpenAIClientOptions {
  readonly route: OpenAIRoute;
  readonly model: string;
  /** The runner's cache key (`prompt_cache_key`), one per run so its steps meet the same cache. */
  readonly cacheKey?: string;
  readonly mintCallId?: () => string;
}

const FORMAT = "openai-responses";
/** OpenAI's levels end at `xhigh`. */
const EFFORT = { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "xhigh" } as const;
/** In-memory prompt caching keeps a prefix for at least 5 minutes of inactivity. */
const CACHE_WINDOW_SECONDS = 300;

export function createOpenAIClient({ route, model, cacheKey, mintCallId = randomUUID }: OpenAIClientOptions): ModelClient {
  const providerId = (call: ToolCallPart): string => {
    if (ownOrigin(call.origin, FORMAT, model) && isJsonObject(call.origin.raw) && typeof call.origin.raw["call_id"] === "string") return call.origin.raw["call_id"];
    return wireCallId("call_ag_", call.id);
  };

  function body(request: ModelRequest): JsonObject {
    const calls = callsById(request.messages);
    const input: JsonValue[] = [];
    for (const message of request.messages) {
      if (message.role === "user") {
        // The tool results first (each right after its calls), then the person's text.
        for (const part of message.content)
          if (part.type === "tool_result")
            input.push({ type: "function_call_output", call_id: providerId(calls.get(part.callId)!), output: part.isError ? `Error: ${part.content}` : part.content });
        const texts = message.content.flatMap((part) => (part.type === "text" ? [{ type: "input_text", text: part.text }] : []));
        if (texts.length > 0) input.push({ role: "user", content: texts });
        continue;
      }
      for (const part of message.parts) {
        // Reasoning items (with their encrypted content) back unchanged, only to the model that made them.
        if (part.type === "reasoning") {
          if (ownOrigin(part.origin, FORMAT, model)) input.push(part.origin.raw);
        } else if (ownOrigin(part.origin, FORMAT, model)) input.push(part.origin.raw);
        else if (part.type === "text") input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: part.text }] });
        else input.push({ type: "function_call", call_id: providerId(part), name: part.name, arguments: JSON.stringify(part.input) });
      }
    }
    return {
      model,
      ...(request.system.length > 0 ? { instructions: request.system.join("\n\n") } : {}),
      input,
      // Only the caller's function tools, each copied field by field.
      ...(request.tools.length > 0
        ? { tools: request.tools.map((tool): JsonObject => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false })) }
        : {}),
      ...(request.toolChoice === "none" ? { tool_choice: "none" } : {}),
      // Nothing kept at the provider: no stored response, no previous_response_id; the reasoning comes back encrypted.
      store: false,
      include: ["reasoning.encrypted_content"],
      max_output_tokens: request.maxOutputTokens,
      ...(request.effort ? { reasoning: { effort: EFFORT[request.effort] } } : {}),
      ...(cacheKey ? { prompt_cache_key: cacheKey } : {}),
    };
  }

  async function send(payload: string, signal: AbortSignal | undefined): Promise<JsonObject> {
    if (route.kind === "openai") return postJson(`${route.baseUrl ?? "https://api.openai.com"}/v1/responses`, { authorization: `Bearer ${route.apiKey}` }, payload, signal);
    const headers = "apiKey" in route.auth ? { "api-key": route.auth.apiKey } : { authorization: `Bearer ${await route.auth.accessToken()}` };
    return postJson(`${route.endpoint.replace(/\/+$/, "")}/openai/v1/responses`, headers, payload, signal);
  }

  return {
    format: FORMAT,
    model,
    async complete(request: ModelRequest): Promise<ModelTurn> {
      const answer = await send(JSON.stringify(body(request)), request.signal);
      const output = answer["output"];
      if (!Array.isArray(output)) throw new ModelProtocolError("The answer holds no output");
      let refused = false;
      const parts: AssistantPart[] = [];
      for (const item of output) {
        if (!isJsonObject(item)) throw new ModelProtocolError("An output item is not an object");
        const origin = { format: FORMAT, model, raw: item } as const;
        if (item["type"] === "function_call" && typeof item["call_id"] === "string" && typeof item["name"] === "string") {
          let input: unknown;
          try {
            input = JSON.parse(typeof item["arguments"] === "string" ? item["arguments"] : "");
          } catch {
            input = undefined;
          }
          parts.push(
            isJsonObject(input)
              ? { type: "tool_call", id: mintCallId(), name: item["name"], input, origin }
              : { type: "tool_call", id: mintCallId(), name: item["name"], input: {}, malformed: true, origin },
          );
        } else if (item["type"] === "message" && Array.isArray(item["content"])) {
          const text = item["content"]
            .flatMap((piece) => (isJsonObject(piece) && piece["type"] === "output_text" && typeof piece["text"] === "string" ? [piece["text"]] : []))
            .join("");
          if (item["content"].some((piece) => isJsonObject(piece) && piece["type"] === "refusal")) refused = true;
          parts.push({ type: "text", text, origin });
        } else parts.push({ type: "reasoning", origin });
      }
      const status = answer["status"];
      const reason = isJsonObject(answer["incomplete_details"]) ? answer["incomplete_details"]["reason"] : undefined;
      let stop: StopReason;
      if (refused || (status === "incomplete" && reason === "content_filter")) stop = "refusal";
      else if (status === "incomplete") stop = "cut_off";
      else if (status === "completed") stop = parts.some((part) => part.type === "tool_call") ? "tool_calls" : "end";
      else throw new ModelProtocolError("The answer's status is unknown");
      const usage = isJsonObject(answer["usage"]) ? answer["usage"] : {};
      const details = isJsonObject(usage["input_tokens_details"]) ? usage["input_tokens_details"] : {};
      return {
        parts,
        stop,
        usage: { input: count(usage["input_tokens"]), cachedRead: count(details["cached_tokens"]), cacheWrite: 0, output: count(usage["output_tokens"]) },
        cacheWindowSeconds: CACHE_WINDOW_SECONDS,
      };
    },
  };
}
