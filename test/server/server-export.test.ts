import { randomBytes, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createModelClient, localKeyWrapper } from "fairlead-agent-server";
import { createServer, hostTokenSender, migrateDatabase, SERVER_SCHEMA, type AgentServer } from "fairlead-agent-server/server";
import { startFakeAnthropic, startFakeOidcIssuer, type FakeAnthropic, type FakeOidcIssuer } from "fairlead-agent-server/testing";

/**
 * Requirement 0002, HK15: a host boots the server in its own tests through
 * the package export `./server`, the API and the runner wired as the entry
 * point wires them, with nothing read from the environment.
 */

const AUDIENCE = "https://agents.example.test";
const HOST_TOKEN = `host-token-${randomUUID()}`;
const UI = "https://ui.example.test";
let db: PGlite;
let issuer: FakeOidcIssuer;
let anthropic: FakeAnthropic;
let server: AgentServer;

beforeAll(async () => {
  db = new PGlite();
  issuer = await startFakeOidcIssuer();
  anthropic = await startFakeAnthropic();
  await migrateDatabase(db);
  await db.exec(`SET search_path TO ${SERVER_SCHEMA}`);
  server = createServer({
    db,
    keyWrapper: localKeyWrapper(randomBytes(32)),
    publicUrl: "http://127.0.0.1:9",
    oidc: { issuer: issuer.url, audience: AUDIENCE },
    teamCreation: "users",
    corsOrigins: [UI],
    senders: hostTokenSender(HOST_TOKEN),
    client: (choice, context) => createModelClient({ ...choice.target, baseUrl: anthropic.url } as typeof choice.target, context),
  });
});
afterAll(async () => {
  await anthropic.close();
  await issuer.close();
  await db.close();
});

const call = async (method: string, path: string, body?: unknown, token?: string) => {
  const response = await server.app.request(path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: (await response.json().catch(() => undefined)) as any };
};

describe("the ./server export (requirement 0002)", () => {
  it("HK15: answers health and CORS, signs people in, keeps agents, takes the host's trigger and works it to its end", async () => {
    expect((await call("GET", "/health")).body).toEqual({ status: "ok", service: "fairlead-agent-server" });
    const preflight = await server.app.request("/me", { method: "OPTIONS", headers: { Origin: UI, "Access-Control-Request-Method": "GET" } });
    expect(preflight.headers.get("access-control-allow-origin")).toBe(UI);

    const token = issuer.token({ sub: randomUUID(), aud: AUDIENCE, email: `${randomUUID()}@example.test`, email_verified: true, groups: [] });
    const teamId = (await call("POST", "/teams", { name: "Finance" }, token)).body.id as string;
    const profile = await call("POST", `/teams/${teamId}/profiles`, { name: "Claude", provider: "claude-api", model: "claude-sonnet-5-5", apiKey: anthropic.apiKey }, token);
    const agent = await call("POST", `/teams/${teamId}/agents`, { name: "Clerk", profileId: profile.body.id }, token);
    expect(agent).toMatchObject({ status: 201, body: { maxActiveSessions: 3 } });

    const trigger = await server.app.request("/triggers", {
      method: "POST",
      headers: { Authorization: `Bearer ${HOST_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ teamId, agentId: agent.body.id, event: "task.assigned", reference: "t-1", body: { title: "Book invoice 7" } }),
    });
    expect(trigger.status).toBe(202);
    const { sessionId } = (await trigger.json()) as { sessionId: string };
    const say = (text: string) => ({
      id: `msg_${randomUUID().slice(0, 8)}`,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5-5",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_details: null,
      usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 },
    });
    anthropic.script(say("Booked."), say("Invoice 7 booked."));
    await Promise.all(await server.scheduler.tick());
    expect((await call("GET", `/teams/${teamId}/sessions/${sessionId}`, undefined, token)).body).toMatchObject({ result: "Booked.", runs: [{ state: "completed" }] });

    // Negative: the host's credential signs nobody in to the API; no token is 401.
    expect((await call("GET", `/teams/${teamId}/agents`, undefined, HOST_TOKEN)).status).toBe(401);
    expect((await call("GET", `/teams/${teamId}/agents`)).status).toBe(401);
  });
});
