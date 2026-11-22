import { createHash } from "node:crypto";

/**
 * Requirement 0001 (RN14–RN17), ADR 0001 §4: the one interface the loop
 * calls. A conversation is provider-neutral and append-only; whatever a
 * provider needs back unchanged (Anthropic's thinking blocks, OpenAI's
 * reasoning items, a call's own id) travels as an `origin` the runner
 * stores and never reads. An origin is sent back only to the format and
 * model that made it; to any other it is dropped (reasoning) or rebuilt
 * from the neutral fields (text, tool calls).
 */
export type WireFormat = "anthropic-messages" | "openai-responses";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** What a provider answered, kept as it came: sent back unchanged, only to the model that made it. */
export interface Origin {
  readonly format: WireFormat;
  readonly model: string;
  readonly raw: JsonValue;
}

export interface TextPart {
  readonly type: "text";
  readonly text: string;
  readonly origin?: Origin;
}

/** A tool call. `id` is the runner's; the provider's own id lives in `origin`. */
export interface ToolCallPart {
  readonly type: "tool_call";
  readonly id: string;
  readonly name: string;
  readonly input: JsonObject;
  /** The arguments were not a JSON object (a cut-off answer): `input` is `{}`, and the call is not to be run. */
  readonly malformed?: true;
  readonly origin?: Origin;
}

/** Reasoning state: opaque, never shown, only round-tripped. */
export interface ReasoningPart {
  readonly type: "reasoning";
  readonly origin: Origin;
}

export type AssistantPart = TextPart | ToolCallPart | ReasoningPart;

export interface ToolResultPart {
  readonly type: "tool_result";
  /** The runner's id of the call it answers. */
  readonly callId: string;
  readonly content: string;
  readonly isError?: boolean;
}

export type UserPart = { readonly type: "text"; readonly text: string } | ToolResultPart;

export type Message = { readonly role: "user"; readonly content: readonly UserPart[] } | { readonly role: "assistant"; readonly parts: readonly AssistantPart[] };

/**
 * A function tool: a name, a description and a JSON schema, nothing else.
 * There is no field for a provider-hosted tool (web search, code execution,
 * a remote MCP connector), and the adapters copy only these three (RN16).
 */
export interface FunctionTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelRequest {
  /** The system prompt and the playbooks, in order; never compacted. */
  readonly system: readonly string[];
  readonly messages: readonly Message[];
  readonly tools: readonly FunctionTool[];
  /** `none` for the summary's call (the tools stay declared). A forced choice cannot be expressed (RN15). */
  readonly toolChoice?: "auto" | "none";
  readonly effort?: Effort;
  readonly maxOutputTokens: number;
  readonly signal?: AbortSignal;
}

/** `cut_off`: the output limit or the context window ended the answer. */
export type StopReason = "end" | "tool_calls" | "refusal" | "cut_off";

export interface Usage {
  /** Every input token of the request: uncached, read from the cache and written to it. */
  readonly input: number;
  readonly cachedRead: number;
  readonly cacheWrite: number;
  readonly output: number;
}

export interface ModelTurn {
  /** Append as `{ role: "assistant", parts }`, unchanged. */
  readonly parts: readonly AssistantPart[];
  readonly stop: StopReason;
  /** A refusal's category where the provider names one. */
  readonly refusalCategory?: string;
  readonly usage: Usage;
  /** How long the prompt cache this call paid for stays warm, in seconds from the answer (0: nothing cached). */
  readonly cacheWindowSeconds: number;
}

export interface ModelClient {
  readonly format: WireFormat;
  readonly model: string;
  complete(request: ModelRequest): Promise<ModelTurn>;
}

/** A provider's error answer. `message` names the status and the provider's error type only, never a body or a credential. */
export class ModelHttpError extends Error {
  constructor(
    readonly status: number,
    readonly providerType: string | undefined,
    /** From `Retry-After` (seconds or an HTTP date), on a 429 or 5xx. */
    readonly retryAfterSeconds: number | undefined,
    /** The provider's own error message, for the transcript only. */
    readonly detail: string | undefined,
  ) {
    super(`The model provider answered ${status}${providerType ? ` ${providerType}` : ""}`);
    this.name = "ModelHttpError";
  }
}

/** An answer the adapter cannot read, or a conversation it cannot send (a result for no call). */
export class ModelProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelProtocolError";
  }
}

/**
 * The runner's call id in a provider's id rules (`^[a-zA-Z0-9_-]+$`, at
 * most 64): letters, digits and `-` kept, every other code unit `_` and its
 * hex, so two ids never meet; past 64 a hash. Used for calls the provider
 * did not make (a call rebuilt for another model, a summary's parked call).
 */
export function wireCallId(prefix: string, id: string): string {
  const escaped = prefix + id.replace(/[^a-zA-Z0-9-]/g, (char) => `_${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return escaped.length <= 64 ? escaped : `${prefix}h${createHash("sha256").update(id).digest("hex").slice(0, 40)}`;
}

/** Each runner call id's call, for pairing results back; a result for no call is the runner's error, sent nowhere. */
export function callsById(messages: readonly Message[]): Map<string, ToolCallPart> {
  const calls = new Map<string, ToolCallPart>();
  for (const message of messages) if (message.role === "assistant") for (const part of message.parts) if (part.type === "tool_call") calls.set(part.id, part);
  for (const message of messages)
    if (message.role === "user")
      for (const part of message.content) if (part.type === "tool_result" && !calls.has(part.callId)) throw new ModelProtocolError("A tool result answers no call");
  return calls;
}

/** The origin, if this model made it. */
export const ownOrigin = (origin: Origin | undefined, format: WireFormat, model: string): origin is Origin =>
  origin !== undefined && origin.format === format && origin.model === model;

export const isJsonObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
