import { afterEach, describe, expect, it } from "vitest";
import {
  authorizationRequest,
  checkIssuer,
  clientFor,
  createMcpClient,
  discover,
  exchangeCode,
  LEGACY_REVISION,
  McpAuthError,
  McpError,
  MCP_REVISION,
  refreshTokens,
  type McpTool,
} from "../src/index.js";
import { startFakeMcp, type FakeMcp, type FakeMcpOptions } from "../src/testing/index.js";

/** Requirement 0004, *Connections* (CN1–CN4): the MCP client and the OAuth sign-in against a real HTTP service in process. */

let fakes: FakeMcp[] = [];
afterEach(async () => {
  await Promise.all(fakes.map((fake) => fake.close()));
  fakes = [];
});
const fake = async (options: FakeMcpOptions) => {
  const started = await startFakeMcp(options);
  fakes.push(started);
  return started;
};

const echo = { name: "echo", readOnly: true, inputSchema: { type: "object", properties: { id: { type: "string", "x-mcp-header": "Item" } } }, answer: (args: Record<string, unknown>) => ({ text: `echo ${String(args["id"])}` }) };
const tool = (name: string): Pick<McpTool, "name" | "inputSchema"> => ({ name, inputSchema: echo.inputSchema });
const mcpCalls = (service: FakeMcp) => service.requests.filter((r) => r.path === "/mcp");

describe("the MCP client (requirement 0004)", () => {
  it("CN1: the current revision first: no initialize, the revision, client and capabilities in _meta, the routing headers, JSON or an event stream", async () => {
    for (const sse of [false, true]) {
      const service = await fake({ tools: [echo], sse });
      const revisions: string[] = [];
      const client = createMcpClient({ url: service.url, onRevision: (r) => revisions.push(r) });
      expect(await client.listTools()).toEqual([expect.objectContaining({ name: "echo", readOnly: true })]);
      expect(await client.callTool(tool("echo"), { id: "42" })).toEqual({ kind: "result", result: { text: "echo 42", isError: false } });
      const [list, call] = mcpCalls(service);
      expect(list!.body.method).toBe("tools/list");
      expect(list!.body.params._meta).toMatchObject({ "io.modelcontextprotocol/protocolVersion": MCP_REVISION, "io.modelcontextprotocol/clientCapabilities": { extensions: { "io.modelcontextprotocol/tasks": {} } } });
      expect(call!.headers).toMatchObject({ "mcp-protocol-version": MCP_REVISION, "mcp-method": "tools/call", "mcp-name": "echo", "mcp-param-item": "42" });
      expect(service.requests.some((r) => r.body?.method === "initialize")).toBe(false);
      expect(revisions).toEqual([MCP_REVISION]);
    }
  });

  it("CN2: a service that speaks only the older revision is initialized and its session kept; a forgotten session is begun again; the revision is recorded", async () => {
    const service = await fake({ tools: [echo], mode: "legacy" });
    const revisions: string[] = [];
    const client = createMcpClient({ url: service.url, onRevision: (r) => revisions.push(r) });
    expect((await client.listTools()).map((t) => t.name)).toEqual(["echo"]);
    expect(client.revision()).toBe(LEGACY_REVISION);
    expect(revisions).toContain(LEGACY_REVISION);
    service.forgetSessions();
    expect((await client.callTool(tool("echo"), { id: "1" })).kind).toBe("result");
    expect(mcpCalls(service).filter((r) => r.body?.method === "initialize")).toHaveLength(2);
    // Known as legacy: the next client asks the current revision nothing.
    const known = createMcpClient({ url: service.url, revision: LEGACY_REVISION });
    const before = mcpCalls(service).length;
    await known.listTools();
    expect(mcpCalls(service).slice(before)[0]!.body.method).toBe("initialize");
  });

  it("CN3: a held call answers a task, polled with tasks/get to its result or its failure; a service's JSON-RPC error is its refusal; no token is 401 with the challenge", async () => {
    const service = await fake({ tools: [{ name: "send", answer: () => ({ task: { pollIntervalMs: 20_000 } }) }], auth: { token: "secret-token-of-the-service-0001" } });
    const refused = createMcpClient({ url: service.url });
    await expect(refused.listTools()).rejects.toBeInstanceOf(McpAuthError);
    const client = createMcpClient({ url: service.url, token: async () => "secret-token-of-the-service-0001" });
    const outcome = await client.callTool(tool("send"), {});
    expect(outcome).toEqual({ kind: "task", task: { taskId: expect.any(String), status: "working", pollIntervalMs: 20_000 } });
    const taskId = (outcome as { task: { taskId: string } }).task.taskId;
    expect((await client.getTask(taskId)).task.status).toBe("working");
    service.settle(taskId, { status: "completed", result: { text: "sent" } });
    expect(await client.getTask(taskId)).toMatchObject({ task: { status: "completed" }, result: { text: "sent" } });
    const second = (await client.callTool(tool("send"), {})) as { task: { taskId: string } };
    service.settle(second.task.taskId, { status: "failed", error: "Rejected: wrong recipient" });
    expect(await client.getTask(second.task.taskId)).toMatchObject({ error: "Rejected: wrong recipient" });
    await expect(client.callTool(tool("nope"), {})).rejects.toBeInstanceOf(McpError);
  });
});

describe("signing in at a service (requirement 0004)", () => {
  const redirectUri = "http://127.0.0.1:1/oauth/callback";
  const metadataUrl = "http://127.0.0.1:1/oauth/client-metadata.json";

  /** The person's side: open the address, follow the service's redirect back. */
  const signIn = async (url: string) => new URL((await fetch(url, { redirect: "manual" })).headers.get("location")!);

  it("CN4: discovery from the challenge, PKCE with S256, the resource on both requests, the answer's iss checked; a client ID metadata document where taken, else registration", async () => {
    for (const cimd of [true, false]) {
      const service = await fake({ tools: [echo], auth: "oauth", cimd, registration: !cimd });
      const challenge = await createMcpClient({ url: service.url })
        .listTools()
        .catch((error: McpAuthError) => error.challenge);
      const discovery = await discover(service.url, challenge as { resourceMetadata?: string });
      expect(discovery).toMatchObject({ resource: service.url, scope: "read", server: { issuer: service.origin, issParameter: true } });
      const client = await clientFor(discovery.server, { registered: null, metadataUrl, redirectUri });
      expect(client.clientId).toEqual(cimd ? metadataUrl : expect.stringMatching(/^client-/));
      const request = authorizationRequest(discovery, { clientId: client.clientId, redirectUri });
      const back = await signIn(request.url);
      expect(back.searchParams.get("state")).toBe(request.state);
      checkIssuer(discovery.server, back.searchParams.get("iss") ?? undefined);
      const tokens = await exchangeCode({ tokenEndpoint: discovery.server.tokenEndpoint, code: back.searchParams.get("code")!, verifier: request.verifier, ...client, redirectUri, resource: discovery.resource });
      expect(tokens).toMatchObject({ accessToken: expect.stringMatching(/^at-/), refreshToken: expect.stringMatching(/^rt-/), scope: "read" });
      const signedIn = createMcpClient({ url: service.url, token: async () => tokens.accessToken });
      expect((await signedIn.listTools()).map((t) => t.name)).toEqual(["echo"]);
      const renewed = await refreshTokens({ tokenEndpoint: discovery.server.tokenEndpoint, refreshToken: tokens.refreshToken!, ...client, resource: discovery.resource });
      expect(renewed.accessToken).not.toBe(tokens.accessToken);
    }
  });

  it("negative (CN4): a wrong verifier, another issuer's answer, a missing iss where promised, metadata for another resource and a service without metadata are refused", async () => {
    const service = await fake({ tools: [echo], auth: "oauth", cimd: true });
    const discovery = await discover(service.url);
    const request = authorizationRequest(discovery, { clientId: metadataUrl, redirectUri });
    const back = await signIn(request.url);
    await expect(
      exchangeCode({ tokenEndpoint: discovery.server.tokenEndpoint, code: back.searchParams.get("code")!, verifier: "x".repeat(43), clientId: metadataUrl, clientSecret: null, redirectUri, resource: discovery.resource }),
    ).rejects.toMatchObject({ name: "OAuthError" });
    expect(() => checkIssuer(discovery.server, "https://evil.example.test")).toThrow("another issuer");
    expect(() => checkIssuer(discovery.server, undefined)).toThrow("another issuer");
    await expect(discover(`${service.origin}/other`, { resourceMetadata: `${service.origin}/.well-known/oauth-protected-resource/mcp` })).rejects.toThrow("another resource");
    const plain = await fake({ tools: [echo] });
    await expect(discover(plain.url)).rejects.toThrow("no protected resource metadata");
    await expect(discover("http://example.test/mcp")).rejects.toMatchObject({ name: "OAuthError" });
  });
});
