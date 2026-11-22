import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * An MCP service over loopback HTTP, for tests: revision 2026-07-28 (no
 * `initialize`; the revision in `_meta` and the routing headers checked) or
 * only the older 2025-06-18 (`initialize`, then its session); tool calls
 * answering results or tasks (the Tasks extension); answers as JSON or an
 * event stream; and, with `auth: "oauth"`, its own authorization server:
 * protected resource metadata, server metadata, `/authorize` (the person
 * says yes at once and is sent back with a code), `/token` with PKCE and
 * `resource` checked, `/register`, scopes per tool.
 */

export interface FakeToolAnswer {
  text: string;
  isError?: boolean;
  structured?: unknown;
}
/** A held call: a task the test settles with `settle`. */
export interface FakeTask {
  task: { pollIntervalMs?: number };
}

export interface FakeTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  readOnly?: boolean;
  /** A scope the token must hold, else 403 `insufficient_scope`. */
  scope?: string;
  /** Throwing answers 502 with no body: the call cut off on its way back. */
  answer(args: Record<string, unknown>, request: FakeMcpRequest): FakeToolAnswer | FakeTask;
}

export interface FakeMcpRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: any;
}

export interface FakeMcpOptions {
  tools: FakeTool[];
  mode?: "current" | "legacy";
  /** `none`, a fixed bearer token, or OAuth through the fake's own authorization server. */
  auth?: "none" | { token: string } | "oauth";
  /** Answer as an event stream. */
  sse?: boolean;
  /** The authorization server: a client ID metadata document taken, dynamic registration offered, `iss` in its answers. */
  cimd?: boolean;
  registration?: boolean;
  iss?: boolean;
  /** Seconds an access token lives. */
  expiresIn?: number;
}

export interface FakeMcp {
  /** The MCP endpoint: `<origin>/mcp`. */
  readonly url: string;
  readonly origin: string;
  readonly requests: FakeMcpRequest[];
  /** The tasks made, by id, with their status. */
  readonly tasks: Map<string, { status: string; result?: FakeToolAnswer; error?: string; pollIntervalMs?: number; tool: string; args: Record<string, unknown> }>;
  settle(taskId: string, outcome: { status: "completed"; result: FakeToolAnswer } | { status: "failed"; error: string } | { status: "cancelled" } | { status: "input_required" }): void;
  /** Access tokens refused from now on; with `refreshTokens`, the refresh tokens too. */
  revoke(options?: { refreshTokens?: boolean }): void;
  /** Forget legacy sessions (a restarted service). */
  forgetSessions(): void;
  close(): Promise<void>;
}

const read = (request: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });

export async function startFakeMcp(options: FakeMcpOptions): Promise<FakeMcp> {
  const mode = options.mode ?? "current";
  const auth = options.auth ?? "none";
  const requests: FakeMcpRequest[] = [];
  const tasks: FakeMcp["tasks"] = new Map();
  const sessions = new Set<string>();
  const codes = new Map<string, { challenge: string; clientId: string; redirectUri: string; resource: string; scope: string }>();
  const access = new Map<string, string>();
  const refresh = new Map<string, { clientId: string; scope: string; resource: string }>();
  const clients = new Set<string>();
  let counter = 0;
  let origin = "";

  const server = createServer((incoming, outgoing) => {
    void read(incoming).then((raw) => {
      const url = new URL(incoming.url ?? "/", origin);
      const headers = Object.fromEntries(Object.entries(incoming.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(", ") : (value ?? "")]));
      let body: any;
      try {
        body = raw === "" ? undefined : headers["content-type"]?.includes("x-www-form-urlencoded") ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw);
      } catch {
        body = undefined;
      }
      const request: FakeMcpRequest = { method: incoming.method ?? "", path: url.pathname, headers, body };
      requests.push(request);
      const send = (status: number, payload: unknown, extra: Record<string, string> = {}) => {
        outgoing.writeHead(status, { "content-type": "application/json", ...extra });
        outgoing.end(JSON.stringify(payload));
      };

      // ---- the authorization server
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        if (auth !== "oauth") return send(404, {});
        return send(200, { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["read"] });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        if (auth !== "oauth") return send(404, {});
        return send(200, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          ...(options.registration ? { registration_endpoint: `${origin}/register` } : {}),
          code_challenge_methods_supported: ["S256"],
          client_id_metadata_document_supported: options.cimd === true,
          authorization_response_iss_parameter_supported: options.iss !== false,
        });
      }
      if (url.pathname === "/register" && incoming.method === "POST") {
        const id = `client-${++counter}`;
        clients.add(id);
        return send(201, { client_id: id });
      }
      if (url.pathname === "/authorize") {
        const q = url.searchParams;
        const clientId = q.get("client_id") ?? "";
        if (q.get("code_challenge_method") !== "S256" || !q.get("code_challenge") || !q.get("state") || q.get("resource") !== `${origin}/mcp`) return send(400, { error: "invalid_request" });
        if (!clients.has(clientId) && !(options.cimd && clientId.startsWith("http"))) return send(400, { error: "invalid_client" });
        const code = `code-${++counter}`;
        codes.set(code, { challenge: q.get("code_challenge")!, clientId, redirectUri: q.get("redirect_uri")!, resource: q.get("resource")!, scope: q.get("scope") ?? "" });
        const back = new URL(q.get("redirect_uri")!);
        back.searchParams.set("code", code);
        back.searchParams.set("state", q.get("state")!);
        if (options.iss !== false) back.searchParams.set("iss", origin);
        outgoing.writeHead(302, { location: back.href });
        return outgoing.end();
      }
      if (url.pathname === "/token" && incoming.method === "POST") {
        const form = (body ?? {}) as Record<string, string>;
        const issue = (grant: { clientId: string; scope: string; resource: string }) => {
          const at = `at-${++counter}`;
          const rt = `rt-${++counter}`;
          access.set(at, grant.scope);
          refresh.set(rt, grant);
          return send(200, { access_token: at, refresh_token: rt, token_type: "Bearer", expires_in: options.expiresIn ?? 3600, scope: grant.scope });
        };
        if (form["grant_type"] === "authorization_code") {
          const code = codes.get(form["code"] ?? "");
          codes.delete(form["code"] ?? "");
          const verified = code && createHash("sha256").update(form["code_verifier"] ?? "").digest("base64url") === code.challenge;
          if (!code || !verified || form["client_id"] !== code.clientId || form["redirect_uri"] !== code.redirectUri || form["resource"] !== code.resource) return send(400, { error: "invalid_grant" });
          return issue(code);
        }
        if (form["grant_type"] === "refresh_token") {
          const grant = refresh.get(form["refresh_token"] ?? "");
          refresh.delete(form["refresh_token"] ?? "");
          if (!grant || form["client_id"] !== grant.clientId || form["resource"] !== grant.resource) return send(400, { error: "invalid_grant" });
          return issue(grant);
        }
        return send(400, { error: "unsupported_grant_type" });
      }

      // ---- the MCP endpoint
      if (url.pathname !== "/mcp") return send(404, {});
      if (incoming.method !== "POST") return send(405, {});
      const bearer = /^Bearer (.+)$/.exec(headers["authorization"] ?? "")?.[1];
      const scopes = auth === "oauth" ? access.get(bearer ?? "") : auth === "none" || bearer === auth.token ? "" : undefined;
      if (scopes === undefined) {
        outgoing.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` });
        return outgoing.end();
      }
      const message = body as { id?: number; method?: string; params?: Record<string, any> } | undefined;
      if (!message || typeof message.method !== "string") return send(400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
      const reply = (result: unknown, extra: Record<string, string> = {}) => {
        const payload = { jsonrpc: "2.0", id: message.id, result };
        if (!options.sse) return send(200, payload, extra);
        outgoing.writeHead(200, { "content-type": "text/event-stream", ...extra });
        outgoing.end(`: keep-alive\n\nevent: message\ndata: ${JSON.stringify(payload)}\n\n`);
      };
      const failure = (code: number, text: string, data?: unknown) => send(200, { jsonrpc: "2.0", id: message.id, error: { code, message: text, ...(data ? { data } : {}) } });

      if (mode === "legacy") {
        if (message.method === "initialize") {
          const id = randomUUID();
          sessions.add(id);
          return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } }, { "mcp-session-id": id });
        }
        if (message.id === undefined) return send(202, {});
        if (!sessions.has(headers["mcp-session-id"] ?? "")) return send(headers["mcp-session-id"] ? 404 : 400, {});
      } else {
        const meta = message.params?.["_meta"] ?? {};
        if (meta["io.modelcontextprotocol/protocolVersion"] !== "2026-07-28" || headers["mcp-protocol-version"] !== "2026-07-28")
          return failure(-32022, "Unsupported protocol version", { supported: ["2026-07-28"] });
        if (headers["mcp-method"] !== message.method) return failure(-32600, "Mcp-Method does not match the body");
      }

      if (message.method === "tools/list")
        return reply({
          tools: options.tools.map((tool) => ({
            name: tool.name,
            description: tool.description ?? "",
            inputSchema: tool.inputSchema ?? { type: "object" },
            ...(tool.readOnly ? { annotations: { readOnlyHint: true } } : {}),
          })),
        });
      if (message.method === "tools/call") {
        const tool = options.tools.find((t) => t.name === message.params?.["name"]);
        if (!tool) return failure(-32602, "Unknown tool");
        if (mode === "current" && headers["mcp-name"] !== tool.name) return failure(-32600, "Mcp-Name does not match the body");
        if (tool.scope && !(scopes ?? "").split(" ").includes(tool.scope)) {
          outgoing.writeHead(403, { "www-authenticate": `Bearer error="insufficient_scope", scope="${tool.scope}"` });
          return outgoing.end();
        }
        const args = (message.params?.["arguments"] ?? {}) as Record<string, unknown>;
        let answer: FakeToolAnswer | FakeTask;
        try {
          answer = tool.answer(args, request);
        } catch {
          outgoing.writeHead(502);
          return outgoing.end();
        }
        if ("task" in answer) {
          const taskId = `task-${++counter}`;
          tasks.set(taskId, { status: "working", tool: tool.name, args, ...(answer.task.pollIntervalMs !== undefined ? { pollIntervalMs: answer.task.pollIntervalMs } : {}) });
          return reply({ resultType: "task", taskId, status: "working", ...(answer.task.pollIntervalMs !== undefined ? { pollIntervalMs: answer.task.pollIntervalMs } : {}) });
        }
        return reply(resultOf(answer));
      }
      if (message.method === "tasks/get" || message.method === "tasks/cancel") {
        const task = tasks.get(message.params?.["taskId"]);
        if (!task) return failure(-32602, "Unknown task");
        if (message.method === "tasks/cancel" && task.status === "working") task.status = "cancelled";
        const taskId = message.params?.["taskId"];
        return reply({
          taskId,
          status: task.status,
          ...(task.pollIntervalMs !== undefined ? { pollIntervalMs: task.pollIntervalMs } : {}),
          ...(task.status === "completed" && task.result ? { result: resultOf(task.result) } : {}),
          ...(task.status === "failed" ? { error: { message: task.error } } : {}),
        });
      }
      return failure(-32601, "Method not found");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: `${origin}/mcp`,
    origin,
    requests,
    tasks,
    settle(taskId, outcome) {
      const task = tasks.get(taskId);
      if (!task) throw new Error(`No task ${taskId}`);
      task.status = outcome.status;
      if (outcome.status === "completed") task.result = outcome.result;
      if (outcome.status === "failed") task.error = outcome.error;
    },
    revoke({ refreshTokens = false } = {}) {
      access.clear();
      if (refreshTokens) refresh.clear();
    },
    forgetSessions: () => sessions.clear(),
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

const resultOf = (answer: FakeToolAnswer) => ({
  content: [{ type: "text", text: answer.text }],
  ...(answer.isError ? { isError: true } : {}),
  ...(answer.structured !== undefined ? { structuredContent: answer.structured } : {}),
});
