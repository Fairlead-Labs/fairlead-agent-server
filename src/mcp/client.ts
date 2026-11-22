import type { JsonObject } from "../model/index.js";

/**
 * The MCP client (requirement 0004, *Connections*; ADR 0004): over `fetch`,
 * no SDK. It speaks the stateless revision 2026-07-28 first (no
 * `initialize`; each request carries its revision, client and
 * capabilities in `_meta` and the routing headers), and an older revision
 * to a service that answers only that (`initialize`, then its session).
 * Tool calls may answer a task (the Tasks extension): the caller polls it
 * with `getTask`; the client never answers a task's `inputRequests`.
 */

export const MCP_REVISION = "2026-07-28";
/** The older revision spoken to a service that does not take the current one. */
export const LEGACY_REVISION = "2025-06-18";
const TASKS = "io.modelcontextprotocol/tasks";
const CLIENT_INFO = { name: "fairlead-agent-server", version: "0.1.0" };

export interface McpTool {
  name: string;
  description: string;
  inputSchema: JsonObject;
  /** `readOnlyHint: true`; any other tool is a write. */
  readOnly: boolean;
}

export type TaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ["completed", "failed", "cancelled"];

export interface McpTask {
  taskId: string;
  status: TaskStatus;
  statusMessage?: string;
  pollIntervalMs?: number;
}

export interface ToolResult {
  /** The answer's texts, envelopes and marks included. */
  text: string;
  isError: boolean;
  structured?: unknown;
}

export type CallOutcome = { kind: "result"; result: ToolResult } | { kind: "task"; task: McpTask };

/** A task as `tasks/get` answers it: a terminal one with its result or its error. */
export interface TaskState {
  task: McpTask;
  result?: ToolResult;
  error?: string;
}

/** 401 or 403 at the service: its `WWW-Authenticate` challenge, read. */
export class McpAuthError extends Error {
  constructor(
    readonly status: 401 | 403,
    readonly challenge: { resourceMetadata?: string; scope?: string; error?: string },
  ) {
    super(`The service refused the credential (${status}${challenge.error ? ` ${challenge.error}` : ""})`);
    this.name = "McpAuthError";
  }
}

/** No usable answer: the request may or may not have reached the service. */
export class McpUnavailableError extends Error {
  constructor(reason: string) {
    super(`The service did not answer: ${reason}`);
    this.name = "McpUnavailableError";
  }
}

/** The service answered with a JSON-RPC error: it reached the service and was refused there. */
export class McpError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "McpError";
  }
}

export interface McpClient {
  listTools(headers?: Record<string, string>): Promise<McpTool[]>;
  callTool(tool: Pick<McpTool, "name" | "inputSchema">, args: JsonObject, headers?: Record<string, string>): Promise<CallOutcome>;
  getTask(taskId: string, headers?: Record<string, string>): Promise<TaskState>;
  cancelTask(taskId: string, headers?: Record<string, string>): Promise<void>;
  /** The revision in use, once the service answered. */
  revision(): string | undefined;
}

export interface McpClientOptions {
  url: string;
  /** The bearer token for each request, if any. */
  token?: () => Promise<string | undefined>;
  /** The revision recorded for this service before, if any. */
  revision?: string | null;
  onRevision?: (revision: string) => void;
  fetch?: typeof fetch;
}

/** `key="value"` pairs of a `WWW-Authenticate: Bearer …` header. */
export function readChallenge(header: string | null): McpAuthError["challenge"] {
  const challenge: McpAuthError["challenge"] = {};
  for (const [, key, value] of (header ?? "").matchAll(/([a-z_]+)="([^"]*)"/g)) {
    if (key === "resource_metadata") challenge.resourceMetadata = value!;
    if (key === "scope") challenge.scope = value!;
    if (key === "error") challenge.error = value!;
  }
  return challenge;
}

/** The JSON-RPC answer to `id` in a JSON body or an event stream (comment lines ignored). */
function messageOf(body: string, contentType: string, id: number): Record<string, unknown> | undefined {
  const candidates: unknown[] = [];
  if (contentType.includes("text/event-stream")) {
    for (const event of body.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) candidates.push(JSON.parse(data));
    }
  } else candidates.push(JSON.parse(body));
  return candidates.flat().find((m): m is Record<string, unknown> => typeof m === "object" && m !== null && (m as { id?: unknown }).id === id);
}

const resultOf = (raw: Record<string, unknown>): ToolResult => {
  const content = (raw["content"] as { type?: string; text?: string }[] | undefined) ?? [];
  return {
    text: content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n"),
    isError: raw["isError"] === true,
    ...(raw["structuredContent"] !== undefined ? { structured: raw["structuredContent"] } : {}),
  };
};

const taskOf = (raw: Record<string, unknown>): McpTask => {
  const status = raw["status"];
  if (typeof raw["taskId"] !== "string" || !["working", "input_required", "completed", "failed", "cancelled"].includes(status as string)) throw new McpUnavailableError("a task without an id or status");
  return {
    taskId: raw["taskId"],
    status: status as TaskStatus,
    ...(typeof raw["statusMessage"] === "string" ? { statusMessage: raw["statusMessage"] } : {}),
    ...(typeof raw["pollIntervalMs"] === "number" ? { pollIntervalMs: raw["pollIntervalMs"] } : {}),
  };
};

/** Headers for a tool's arguments its schema marks `x-mcp-header`. */
function paramHeaders(schema: JsonObject, args: JsonObject): Record<string, string> {
  const headers: Record<string, string> = {};
  const properties = (schema["properties"] ?? {}) as Record<string, { "x-mcp-header"?: unknown }>;
  for (const [key, property] of Object.entries(properties)) {
    const name = property?.["x-mcp-header"];
    const value = args[key];
    // ponytail: printable ASCII values only; encode others when a service needs one.
    if (typeof name === "string" && /^[A-Za-z0-9-]{1,64}$/.test(name) && ["string", "number", "boolean"].includes(typeof value) && /^[\x20-\x7e]{0,1000}$/.test(String(value)))
      headers[`Mcp-Param-${name}`] = String(value);
  }
  return headers;
}

export function createMcpClient({ url, token, revision: known, onRevision, fetch: fetchImpl = fetch }: McpClientOptions): McpClient {
  let revision: string | undefined = known ?? undefined;
  let session: string | undefined;
  let counter = 0;

  /** The revision last told to `onRevision`. */
  let reported = revision;
  const settle = (value: string) => {
    revision = value;
    if (reported === value) return;
    reported = value;
    onRevision?.(value);
  };

  async function post(body: JsonObject, headers: Record<string, string>): Promise<Response> {
    const bearer = await token?.();
    try {
      return await fetchImpl(url, {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
          ...headers,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new McpUnavailableError(error instanceof Error ? error.name : "fetch failed");
    }
  }

  /** One exchange; answers the message, or `fallback` when the service does not speak the current revision. */
  async function exchange(method: string, params: JsonObject, headers: Record<string, string>, legacy: boolean): Promise<Record<string, unknown> | "fallback"> {
    const id = ++counter;
    const body = legacy
      ? { jsonrpc: "2.0", id, method, params }
      : {
          jsonrpc: "2.0",
          id,
          method,
          params: {
            ...params,
            _meta: { "io.modelcontextprotocol/protocolVersion": MCP_REVISION, "io.modelcontextprotocol/clientInfo": CLIENT_INFO, "io.modelcontextprotocol/clientCapabilities": { extensions: { [TASKS]: {} } } },
          },
        };
    const response = await post(body, {
      "MCP-Protocol-Version": legacy ? revision! : MCP_REVISION,
      ...(legacy ? (session ? { "Mcp-Session-Id": session } : {}) : { "Mcp-Method": method }),
      ...headers,
    });
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new McpAuthError(response.status, readChallenge(response.headers.get("WWW-Authenticate")));
    }
    const text = await response.text().catch(() => "");
    let message: Record<string, unknown> | undefined;
    try {
      message = text ? messageOf(text, response.headers.get("Content-Type") ?? "", id) : undefined;
    } catch {
      message = undefined;
    }
    const error = message?.["error"] as { code?: unknown; message?: unknown; data?: { supported?: unknown } } | undefined;
    if (!legacy && revision === undefined) {
      // An older service: a 400, 404 or 405 that is no current error, or a refused revision it does not list.
      const refused = error?.code === -32022 && !(Array.isArray(error.data?.supported) && error.data.supported.includes(MCP_REVISION));
      if (refused || ([400, 404, 405].includes(response.status) && typeof error?.code !== "number")) return "fallback";
    }
    if (legacy && response.status === 404 && session) return "fallback";
    if (typeof error?.code === "number") throw new McpError(error.code, typeof error.message === "string" ? error.message : "error");
    if (!response.ok || !message || typeof message["result"] !== "object" || message["result"] === null) throw new McpUnavailableError(`answered ${response.status}`);
    if (!legacy) settle(MCP_REVISION);
    const sessionId = response.headers.get("Mcp-Session-Id");
    if (legacy && sessionId) session = sessionId;
    return message["result"] as Record<string, unknown>;
  }

  async function initialize() {
    revision = LEGACY_REVISION;
    session = undefined;
    const result = await exchange("initialize", { protocolVersion: LEGACY_REVISION, capabilities: {}, clientInfo: CLIENT_INFO }, {}, true);
    if (result === "fallback") throw new McpUnavailableError("initialize refused");
    settle(typeof result["protocolVersion"] === "string" ? result["protocolVersion"] : LEGACY_REVISION);
    const done = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, { "MCP-Protocol-Version": revision!, ...(session ? { "Mcp-Session-Id": session } : {}) });
    await done.body?.cancel();
  }

  let ready: Promise<void> | undefined;
  async function request(method: string, params: JsonObject, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
    if (revision !== undefined && revision !== MCP_REVISION) {
      ready ??= (session ? Promise.resolve() : initialize()).catch((error: unknown) => {
        ready = undefined;
        throw error;
      });
      await ready;
      const answer = await exchange(method, params, headers, true);
      if (answer !== "fallback") return answer;
      // The service forgot the session: once more with a new one.
      ready = initialize();
      await ready;
      const again = await exchange(method, params, headers, true);
      if (again === "fallback") throw new McpUnavailableError("session refused");
      return again;
    }
    const answer = await exchange(method, params, headers, false);
    if (answer !== "fallback") return answer;
    revision = LEGACY_REVISION;
    return request(method, params, headers);
  }

  return {
    revision: () => revision,

    async listTools(headers) {
      const tools: McpTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page += 1) {
        const result = await request("tools/list", cursor ? { cursor } : {}, headers);
        for (const tool of (result["tools"] as Record<string, unknown>[] | undefined) ?? []) {
          if (typeof tool["name"] !== "string") continue;
          tools.push({
            name: tool["name"],
            description: typeof tool["description"] === "string" ? tool["description"] : "",
            inputSchema: (tool["inputSchema"] as JsonObject | undefined) ?? { type: "object" },
            readOnly: (tool["annotations"] as { readOnlyHint?: unknown } | undefined)?.readOnlyHint === true,
          });
        }
        cursor = typeof result["nextCursor"] === "string" ? result["nextCursor"] : undefined;
        if (!cursor) break;
      }
      return tools;
    },

    async callTool(tool, args, headers = {}) {
      const result = await request("tools/call", { name: tool.name, arguments: args }, { "Mcp-Name": tool.name, ...paramHeaders(tool.inputSchema, args), ...headers });
      if (result["resultType"] === "task") return { kind: "task", task: taskOf(result) };
      if (result["resultType"] === "input_required")
        return { kind: "result", result: { text: "The service asked for input only a person at the service can give; this call did not run.", isError: true } };
      return { kind: "result", result: resultOf(result) };
    },

    async getTask(taskId, headers) {
      const result = await request("tasks/get", { taskId }, headers);
      const task = taskOf(result);
      const inner = result["result"];
      const error = result["error"] as { message?: unknown } | undefined;
      return {
        task,
        ...(task.status === "completed" && typeof inner === "object" && inner !== null ? { result: resultOf(inner as Record<string, unknown>) } : {}),
        ...(task.status === "failed" ? { error: typeof error?.message === "string" ? error.message : "failed" } : {}),
      };
    },

    async cancelTask(taskId, headers) {
      await request("tasks/cancel", { taskId }, headers);
    },
  };
}
