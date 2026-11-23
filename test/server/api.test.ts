import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApiApp } from "../../src/server/api.js";
import { createDirectoryApp } from "../../src/server/directory-api.js";
import { createOidcVerifier } from "../../src/server/oidc.js";
import { hostIdentitySender, hostTokenSender, type TriggerSenders } from "../../src/server/senders.js";
import { startFakeMcp, startFakeOidcIssuer, type FakeMcp, type FakeOidcIssuer } from "../../src/testing/index.js";
import { call as toolCall, HOST_TOKEN, say, startWorld, type World } from "../support/world.js";

/**
 * The server's API as the entry point mounts it (requirement 0004,
 * AS1–AS7, AS11; requirement 0002, HK5): a real loopback OIDC issuer,
 * PGlite, the runner over a fake Anthropic API, and fake MCP services with
 * their own authorization servers.
 */

const AUDIENCE = "https://agents.example.test";
const PUBLIC_URL = "http://127.0.0.1:9";
const CANARY = `canary-${randomUUID()}`;
let w: World;
let issuer: FakeOidcIssuer;
let app: Hono;
let services: FakeMcp[] = [];

const appWith = (senders: TriggerSenders, corsOrigins?: string[]) => {
  const verify = createOidcVerifier({ issuer: issuer.url, audience: AUDIENCE, rolesClaim: "groups", adminRole: "agent-server-admin" });
  const composed = new Hono();
  composed.route("/", createApiApp({ directory: w.directory, verify, store: w.store, agents: w.agents, connections: w.connections, sealer: w.sealer, work: w.work, senders, publicUrl: PUBLIC_URL, now: () => w.at, ...(corsOrigins ? { corsOrigins } : {}) }));
  composed.route("/", createDirectoryApp({ directory: w.directory, verify, teamCreation: "users" }));
  return composed;
};

beforeAll(async () => {
  w = await startWorld();
  issuer = await startFakeOidcIssuer();
  app = appWith(hostTokenSender(HOST_TOKEN));
});
afterAll(async () => {
  await Promise.all(services.map((s) => s.close()));
  await issuer.close();
  await w.close();
});
beforeEach(async () => {
  for (const { id } of await w.directory.allTeams())
    for (const run of await w.store.forTeam(id).listRuns({ states: ["queued", "working", "input_required", "auth_required"] })) await w.work.stopRun(id, run.id);
  w.anthropic.reset();
  w.anthropic.requests.splice(0);
});

interface Person {
  token: string;
  id: string;
}
const responses: string[] = [];
async function request(who: Person | string | undefined, method: string, path: string, body?: unknown, on = app) {
  const token = typeof who === "string" ? who : who?.token;
  const response = await on.request(path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  responses.push(text);
  let parsed: any = text;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    // a text answer
  }
  return { status: response.status, body: parsed };
}
async function person(claims: Record<string, unknown> = {}): Promise<Person> {
  const token = issuer.token({ sub: randomUUID(), aud: AUDIENCE, email: `${randomUUID()}@example.test`, email_verified: true, groups: [], ...claims });
  return { token, id: (await request(token, "GET", "/me")).body.user.id };
}
/** A team with an admin and a member, made through the API. */
async function team() {
  const [admin, member, outsider] = [await person(), await person(), await person()];
  const teamId = (await request(admin, "POST", "/teams", { name: "Finance" })).body.id as string;
  expect((await request(admin, "POST", `/teams/${teamId}/members`, { userId: member.id, role: "member" })).status).toBe(204);
  return { teamId, admin, member, outsider };
}
const claudeProfile = (extra: Record<string, unknown> = {}) => ({ name: "Claude", provider: "claude-api", model: "claude-sonnet-5-5", apiKey: w.anthropic.apiKey, ...extra });
async function service(options: Parameters<typeof startFakeMcp>[0]) {
  const started = await startFakeMcp(options);
  services.push(started);
  return started;
}

describe("managing agents, profiles and connections (requirement 0004)", () => {
  it("AS1: a team's admins keep its agents, profiles and connections; a member reads the agents and connections; secrets are write-only", async () => {
    const { teamId, admin, member, outsider } = await team();
    const profile = await request(admin, "POST", `/teams/${teamId}/profiles`, claudeProfile({ apiKey: `sk-${CANARY}` }));
    expect(profile).toMatchObject({ status: 201, body: { name: "Claude", personal: false, hasApiKey: true } });
    const agent = await request(admin, "POST", `/teams/${teamId}/agents`, { name: "Clerk", profileId: profile.body.id, limits: { steps: 50, inputTokens: null }, timeZone: "Europe/Berlin", language: "de" });
    expect(agent).toMatchObject({ status: 201, body: { name: "Clerk", personal: false, limits: { steps: 50, inputTokens: null, runsPerTrigger: 10 }, timeZone: "Europe/Berlin", language: "de" } });
    const connection = await request(admin, "POST", `/teams/${teamId}/connections`, { name: "crm", url: "https://crm.example.test/mcp", auth: "oauth", oauthClient: { clientId: "agents", clientSecret: `cs-${CANARY}` } });
    expect(connection).toMatchObject({ status: 201, body: { name: "crm", oauthClientId: "agents" } });
    expect((await request(member, "GET", `/teams/${teamId}/agents`)).body.agents.map((a: { id: string }) => a.id)).toEqual([agent.body.id]);
    expect((await request(member, "GET", `/teams/${teamId}/connections`)).status).toBe(200);
    expect((await request(member, "GET", `/teams/${teamId}/profiles`)).body.profiles).toEqual([]);
    const changed = await request(admin, "PATCH", `/teams/${teamId}/agents/${agent.body.id}`, { version: 1, playbook: "Book to cost centre 4711." });
    expect(changed).toMatchObject({ status: 200, body: { version: 2, playbook: "Book to cost centre 4711." } });
    expect((await request(admin, "PATCH", `/teams/${teamId}/agents/${agent.body.id}`, { version: 1, name: "Stale" })).status).toBe(409);
    expect((await request(admin, "DELETE", `/teams/${teamId}/profiles/${profile.body.id}`)).status).toBe(409);
    expect(responses.join("\n")).not.toContain(CANARY);

    // Negative: a member writes nothing of the team's; a non-member sees nothing.
    expect((await request(member, "POST", `/teams/${teamId}/agents`, { name: "Mine?" })).status).toBe(403);
    expect((await request(member, "PATCH", `/teams/${teamId}/agents/${agent.body.id}`, { version: 2, name: "X" })).status).toBe(403);
    expect((await request(member, "POST", `/teams/${teamId}/profiles`, claudeProfile())).status).toBe(403);
    expect((await request(member, "POST", `/teams/${teamId}/connections`, { name: "x", url: "https://x.example.test/mcp", auth: "key" })).status).toBe(403);
    expect((await request(member, "GET", `/teams/${teamId}/usage`)).status).toBe(403);
    for (const [method, path] of [
      ["GET", `/teams/${teamId}/agents`],
      ["GET", `/teams/${teamId}/agents/${agent.body.id}`],
      ["GET", `/teams/${teamId}/profiles`],
      ["GET", `/teams/${teamId}/connections`],
      ["GET", `/teams/${teamId}/sessions`],
      ["GET", `/teams/${teamId}/questions`],
      ["POST", `/teams/${teamId}/agents/${agent.body.id}/pause`],
      ["POST", `/teams/${teamId}/agents/${agent.body.id}/sessions`],
    ] as const)
      expect((await request(outsider, method, path, method === "POST" ? { message: "hi" } : undefined)).status, `${method} ${path}`).toBe(404);
    expect((await request(undefined, "GET", `/teams/${teamId}/agents`)).status).toBe(401);
  });

  it("negative (AS1): invalid settings are 400: a limit out of range, an unknown time zone, a connection name or address that is not one, another team's profile", async () => {
    const { teamId, admin } = await team();
    const other = await team();
    const foreign = await request(other.admin, "POST", `/teams/${other.teamId}/profiles`, claudeProfile());
    for (const body of [
      { name: "A", limits: { steps: 0 } },
      { name: "A", limits: { inputTokens: 1e12 } },
      { name: "A", timeZone: "Mars/Olympus" },
      { name: "" },
      { name: "A", defaultOwnerUserIds: [other.admin.id] },
    ])
      expect((await request(admin, "POST", `/teams/${teamId}/agents`, body)).status, JSON.stringify(body)).toBe(400);
    expect((await request(admin, "POST", `/teams/${teamId}/agents`, { name: "A", profileId: foreign.body.id })).body).toEqual({ error: "Unknown profile" });
    for (const body of [
      { name: "Bad Name", url: "https://x.example.test/mcp", auth: "key" },
      { name: "ask_person", url: "http://x.example.test/mcp", auth: "key" },
      { name: "crm", url: "https://x.example.test/mcp#frag", auth: "key" },
      { name: "crm", url: "https://x.example.test/mcp", auth: "password" },
    ])
      expect((await request(admin, "POST", `/teams/${teamId}/connections`, body)).status, JSON.stringify(body)).toBe(400);
    expect((await request(admin, "POST", `/teams/${teamId}/profiles`, claudeProfile({ provider: "gemini" }))).status).toBe(400);
  });

  it("AS2: a member keeps their own personal agent and profiles; the team's admins neither see its profile nor edit it, but pause and remove it; a personal agent never uses the team's profile", async () => {
    const { teamId, admin, member } = await team();
    const teamProfile = await request(admin, "POST", `/teams/${teamId}/profiles`, claudeProfile());
    const own = await request(member, "POST", `/teams/${teamId}/profiles`, claudeProfile({ personal: true, name: "Mine" }));
    expect(own).toMatchObject({ status: 201, body: { personal: true, ownerUserId: member.id } });
    expect((await request(member, "POST", `/teams/${teamId}/agents`, { name: "Helper", personal: true, profileId: teamProfile.body.id })).body).toEqual({ error: "Unknown profile" });
    const agent = await request(member, "POST", `/teams/${teamId}/agents`, { name: "Helper", personal: true, profileId: own.body.id });
    expect(agent).toMatchObject({ status: 201, body: { personal: true, ownerUserId: member.id } });
    expect((await request(admin, "POST", `/teams/${teamId}/agents`, { name: "Team", profileId: own.body.id })).body).toEqual({ error: "Unknown profile" });
    expect((await request(admin, "GET", `/teams/${teamId}/profiles`)).body.profiles.map((p: { id: string }) => p.id)).toEqual([teamProfile.body.id]);
    expect((await request(member, "GET", `/teams/${teamId}/profiles`)).body.profiles.map((p: { id: string }) => p.id)).toEqual([own.body.id]);
    expect((await request(admin, "PATCH", `/teams/${teamId}/profiles/${own.body.id}`, { version: 1, model: "x" })).status).toBe(404);
    expect((await request(admin, "PATCH", `/teams/${teamId}/agents/${agent.body.id}`, { version: 1, playbook: "Be terse." })).body).toEqual({ error: "Only its owner changes a personal agent" });
    expect((await request(admin, "GET", `/teams/${teamId}/agents/${agent.body.id}/credentials`)).status).toBe(403);
    expect((await request(admin, "POST", `/teams/${teamId}/agents/${agent.body.id}/pause`)).body).toMatchObject({ paused: true });
    expect((await request(member, "POST", `/teams/${teamId}/agents/${agent.body.id}/resume`)).body).toMatchObject({ paused: false });
    expect((await request(admin, "DELETE", `/teams/${teamId}/agents/${agent.body.id}`)).status).toBe(204);
    expect((await request(member, "GET", `/teams/${teamId}/agents/${agent.body.id}`)).status).toBe(404);
  });

  it("AS2: a personal space is a user's own: their agents there, nobody else's; nobody joins it", async () => {
    const [ada, bob] = [await person(), await person()];
    const space = await request(ada, "POST", "/me/personal-space");
    expect(space.body).toMatchObject({ kind: "personal" });
    expect((await request(ada, "POST", "/me/personal-space")).body.id).toBe(space.body.id);
    const agent = await request(ada, "POST", `/teams/${space.body.id}/agents`, { name: "Mine", personal: true });
    expect(agent.status).toBe(201);
    expect((await request(bob, "GET", `/teams/${space.body.id}/agents`)).status).toBe(404);
    expect((await request(ada, "POST", `/teams/${space.body.id}/members`, { userId: bob.id, role: "member" })).status).toBe(400);
    expect((await request(ada, "POST", `/teams/${space.body.id}/join-codes`, {})).status).toBe(400);
  });
});

describe("an agent's cap of active sessions (requirement 0004)", () => {
  it("AS13: a new agent may hold 3 active sessions; a team agent's cap is changed by a team admin, a personal agent's by its owner", async () => {
    const { teamId, admin, member } = await team();
    const agent = await request(admin, "POST", `/teams/${teamId}/agents`, { name: "Clerk" });
    expect(agent.body).toMatchObject({ maxActiveSessions: 3 });
    expect(await request(admin, "PATCH", `/teams/${teamId}/agents/${agent.body.id}`, { version: 1, maxActiveSessions: 5 })).toMatchObject({ status: 200, body: { maxActiveSessions: 5, version: 2 } });
    expect((await request(member, "GET", `/teams/${teamId}/agents/${agent.body.id}`)).body).toMatchObject({ maxActiveSessions: 5 });
    expect((await request(admin, "POST", `/teams/${teamId}/agents`, { name: "Second", maxActiveSessions: 1 })).body).toMatchObject({ maxActiveSessions: 1 });
    const own = await request(member, "POST", `/teams/${teamId}/agents`, { name: "Helper", personal: true });
    expect(await request(member, "PATCH", `/teams/${teamId}/agents/${own.body.id}`, { version: 1, maxActiveSessions: 2 })).toMatchObject({ status: 200, body: { maxActiveSessions: 2 } });
  });

  it("negative (AS13): a member who is neither a team admin nor the personal agent's owner is 403; a cap below 1, above 100 or not an integer is 400", async () => {
    const { teamId, admin, member } = await team();
    const other = await person();
    expect((await request(admin, "POST", `/teams/${teamId}/members`, { userId: other.id, role: "member" })).status).toBe(204);
    const agent = await request(admin, "POST", `/teams/${teamId}/agents`, { name: "Clerk" });
    const own = await request(member, "POST", `/teams/${teamId}/agents`, { name: "Helper", personal: true });
    expect((await request(member, "PATCH", `/teams/${teamId}/agents/${agent.body.id}`, { version: 1, maxActiveSessions: 5 })).status).toBe(403);
    expect((await request(other, "PATCH", `/teams/${teamId}/agents/${own.body.id}`, { version: 1, maxActiveSessions: 5 })).status).toBe(403);
    for (const value of [0, -1, 101, 2.5, "3", null, true])
      expect((await request(admin, "PATCH", `/teams/${teamId}/agents/${agent.body.id}`, { version: 1, maxActiveSessions: value })).status, JSON.stringify(value)).toBe(400);
    expect((await request(admin, "POST", `/teams/${teamId}/agents`, { name: "A", maxActiveSessions: 0 })).status).toBe(400);
    expect((await request(admin, "GET", `/teams/${teamId}/agents/${agent.body.id}`)).body).toMatchObject({ maxActiveSessions: 3, version: 1 });
    expect((await request(member, "GET", `/teams/${teamId}/agents/${own.body.id}`)).body).toMatchObject({ maxActiveSessions: 3, version: 1 });
  });
});

describe("a browser on another origin (requirement 0002)", () => {
  const UI = "https://ui.example.test";
  const preflight = (on: Hono, path: string, origin: string) =>
    on.request(path, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "PATCH", "Access-Control-Request-Headers": "authorization,content-type" } });
  const corsHeaders = (response: Response) => [...response.headers.keys()].filter((name) => name.startsWith("access-control-"));

  it("HK13: a configured origin's preflight is answered, for the agents' API and the directory's alike, and its calls carry the origin", async () => {
    const withCors = appWith(hostTokenSender(HOST_TOKEN), [UI, "https://other-ui.example.test"]);
    for (const path of ["/teams/x/agents/y", "/me"]) {
      const answer = await preflight(withCors, path, UI);
      expect(answer.status, path).toBe(204);
      expect(answer.headers.get("access-control-allow-origin")).toBe(UI);
      expect(answer.headers.get("access-control-allow-methods")).toContain("PATCH");
      expect(answer.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("authorization");
    }
    const ada = await person();
    const read = await withCors.request("/me", { headers: { Origin: UI, Authorization: `Bearer ${ada.token}` } });
    expect(read.status).toBe(200);
    expect(read.headers.get("access-control-allow-origin")).toBe(UI);
  });

  it("negative (HK13): another origin, or any origin while none is configured, gets no CORS header at all", async () => {
    const withCors = appWith(hostTokenSender(HOST_TOKEN), [UI]);
    const ada = await person();
    for (const [on, origin] of [
      [withCors, "https://evil.example.test"],
      [withCors, "http://ui.example.test"],
      [withCors, `${UI}.evil.example.test`],
      [app, UI],
    ] as const) {
      const answer = await preflight(on, "/teams/x/agents/y", origin);
      expect(answer.status, origin).not.toBe(204);
      expect(corsHeaders(answer), origin).toEqual([]);
      const read = await on.request("/me", { headers: { Origin: origin, Authorization: `Bearer ${ada.token}` } });
      expect(read.status).toBe(200);
      expect(corsHeaders(read), origin).toEqual([]);
    }
  });
});

describe("sessions through the API (requirement 0004)", () => {
  it("AS5: a member starts work, reads its progress and result, continues it; the owners change owners; an owner closes it", async () => {
    const { teamId, admin, member } = await team();
    const profile = await request(admin, "POST", `/teams/${teamId}/profiles`, claudeProfile());
    const agent = (await request(admin, "POST", `/teams/${teamId}/agents`, { name: "Clerk", profileId: profile.body.id })).body;
    const started = await request(member, "POST", `/teams/${teamId}/agents/${agent.id}/sessions`, { message: "Book invoice 7." });
    expect(started.status).toBe(201);
    const path = `/teams/${teamId}/sessions/${started.body.sessionId}`;
    expect((await request(admin, "GET", path)).body).toMatchObject({ ownerUserIds: [member.id], startedByUserId: member.id, runs: [{ state: "queued", cause: "trigger" }] });
    w.anthropic.script(say("Booked."), say("Invoice 7 booked."));
    await w.tick();
    const read = await request(admin, "GET", path);
    expect(read.body).toMatchObject({ result: "Booked.", summary: "Invoice 7 booked.", runs: [{ state: "completed" }], question: null });
    expect((await request(member, "POST", `${path}/messages`, { message: "And invoice 8." })).status).toBe(202);
    expect((await request(admin, "GET", path)).body.runs.map((r: { state: string }) => r.state)).toEqual(["completed", "queued"]);
    const outsiderOwner = await request(admin, "PATCH", path, { version: read.body.version, ownerUserIds: [admin.id, member.id] });
    expect(outsiderOwner).toMatchObject({ status: 200, body: { ownerUserIds: [admin.id, member.id] } });
    expect((await request(member, "PATCH", path, { version: 1, ownerUserIds: [] })).status).toBe(409);
    expect((await request(member, "POST", `${path}/close`)).body).toMatchObject({ state: "closed" });
    expect((await request(admin, "GET", path)).body.runs.map((r: { state: string }) => r.state)).toEqual(["completed", "cancelled"]);
    expect((await request(member, "POST", `${path}/messages`, { message: "More." })).status).toBe(409);
    expect((await request(admin, "GET", `/teams/${teamId}/usage`)).body.usage).toEqual([expect.objectContaining({ userId: member.id, sessions: 1, runs: 1 })]);
  });

  it("negative (AS5): a member who owns none of a session neither changes its owners, closes it nor answers its question; another team's sessions are 404", async () => {
    const { teamId, admin, member } = await team();
    const other = await person();
    await request(admin, "POST", `/teams/${teamId}/members`, { userId: other.id, role: "member" });
    const profile = await request(admin, "POST", `/teams/${teamId}/profiles`, claudeProfile());
    const agent = (await request(admin, "POST", `/teams/${teamId}/agents`, { name: "Clerk", profileId: profile.body.id })).body;
    const { sessionId } = (await request(member, "POST", `/teams/${teamId}/agents/${agent.id}/sessions`, { message: "Go." })).body;
    w.anthropic.script(toolCall("ask_person", { question: "Which one?" }));
    await w.tick();
    const path = `/teams/${teamId}/sessions/${sessionId}`;
    const { question } = (await request(member, "GET", path)).body;
    expect(question).toMatchObject({ text: "Which one?", kind: "agent" });
    expect((await request(other, "GET", `/teams/${teamId}/questions`)).body.questions).toEqual([]);
    expect((await request(member, "GET", `/teams/${teamId}/questions`)).body.questions).toEqual([expect.objectContaining({ id: question.id })]);
    expect((await request(other, "POST", `/teams/${teamId}/questions/${question.id}/answer`, { answer: "This one." })).status).toBe(403);
    expect((await request(other, "PATCH", path, { version: 1, ownerUserIds: [other.id] })).status).toBe(403);
    expect((await request(other, "POST", `${path}/close`)).status).toBe(403);
    const run = (await request(member, "GET", path)).body.runs[0];
    expect((await request(other, "POST", `/teams/${teamId}/runs/${run.id}/stop`)).status).toBe(403);
    const elsewhere = await team();
    expect((await request(elsewhere.admin, "GET", `/teams/${elsewhere.teamId}/sessions/${sessionId}`)).status).toBe(404);
    expect((await request(member, "POST", `/teams/${teamId}/questions/${question.id}/answer`, { answer: "This one." })).body).toMatchObject({ state: "answered" });
    // A team admin stops any run (AS3).
    expect((await request(admin, "POST", `/teams/${teamId}/runs/${run.id}/stop`)).body).toMatchObject({ state: "cancelled" });
  });

  it("AS11: usage per team for its admins; an installation admin sees each team's totals, never its sessions", async () => {
    const { teamId, admin } = await team();
    const root = await person({ groups: ["agent-server-admin"] });
    const all = await request(root, "GET", "/usage");
    expect(all.body.teams).toEqual(expect.arrayContaining([expect.objectContaining({ teamId, sessions: expect.any(Number) })]));
    expect((await request(admin, "GET", "/usage")).status).toBe(403);
    expect((await request(root, "GET", `/teams/${teamId}/sessions`)).status).toBe(404);
    expect((await request(admin, "GET", `/teams/${teamId}/usage?from=2026-11-30&to=2026-11-01`)).status).toBe(400);
  });
});

describe("the host's triggers (requirement 0002)", () => {
  it("HK5: the host's credential admits a trigger for any team: 202, the same reference 200; nothing else is admitted", async () => {
    const { teamId, admin } = await team();
    const agent = (await request(admin, "POST", `/teams/${teamId}/agents`, { name: "Clerk" })).body;
    const trigger = { teamId, agentId: agent.id, event: "task.assigned", reference: `task-${randomUUID()}`, body: { taskId: "t1" } };
    const first = await request(HOST_TOKEN, "POST", "/triggers", trigger);
    expect(first).toMatchObject({ status: 202, body: { duplicate: false } });
    expect(await request(HOST_TOKEN, "POST", "/triggers", trigger)).toMatchObject({ status: 200, body: { sessionId: first.body.sessionId, duplicate: true } });
    for (const authorization of ["x".repeat(HOST_TOKEN.length), `Basic ${HOST_TOKEN}`, admin.token, ""]) {
      const response = await app.request("/triggers", { method: "POST", headers: { "Content-Type": "application/json", ...(authorization ? { Authorization: authorization.includes(" ") ? authorization : `Bearer ${authorization}` } : {}) }, body: JSON.stringify({ ...trigger, reference: randomUUID() }) });
      expect(response.status).toBe(401);
    }
    expect((await request(HOST_TOKEN, "POST", "/triggers", { ...trigger, event: "two words" })).status).toBe(400);
    expect((await request(HOST_TOKEN, "POST", "/triggers", { ...trigger, reference: randomUUID(), teamId: randomUUID() })).status).toBe(404);
    expect((await request(HOST_TOKEN, "POST", "/triggers", { ...trigger, reference: randomUUID(), agentId: randomUUID() })).status).toBe(404);
    expect((await w.store.forTeam(teamId).listSessions()).map((s) => s.id)).toEqual([first.body.sessionId]);
  });

  it("AS14, AS15: a trigger's answer says whether it waits for a free session; `close` is a boolean closing its session after the run. Negative: never refused for the cap; another agent's session 404, a closed one 409", async () => {
    const { teamId, admin } = await team();
    const agent = (await request(admin, "POST", `/teams/${teamId}/agents`, { name: "Clerk", maxActiveSessions: 1 })).body;
    const other = (await request(admin, "POST", `/teams/${teamId}/agents`, { name: "Other" })).body;
    const trigger = () => ({ teamId, agentId: agent.id, event: "task.assigned", reference: randomUUID() });
    const first = await request(HOST_TOKEN, "POST", "/triggers", trigger());
    expect(first).toMatchObject({ status: 202, body: { duplicate: false, queued: false } });
    const [run] = await w.store.forTeam(teamId).listRuns({ sessionId: first.body.sessionId });
    await w.store.forTeam(teamId).claim(run!.id, w.at);
    const second = await request(HOST_TOKEN, "POST", "/triggers", trigger());
    expect(second).toMatchObject({ status: 202, body: { duplicate: false, queued: true } });
    expect((await request(admin, "GET", `/teams/${teamId}/sessions/${second.body.sessionId}`)).body).toMatchObject({ closeAfterRun: false, runs: [{ state: "queued" }] });

    const closing = await request(HOST_TOKEN, "POST", "/triggers", { ...trigger(), sessionId: first.body.sessionId, close: true });
    expect(closing).toMatchObject({ status: 202, body: { sessionId: first.body.sessionId, queued: false } });
    expect((await request(admin, "GET", `/teams/${teamId}/sessions/${first.body.sessionId}`)).body).toMatchObject({ state: "open", closeAfterRun: true });
    for (const close of ["yes", 1, null]) expect((await request(HOST_TOKEN, "POST", "/triggers", { ...trigger(), sessionId: first.body.sessionId, close })).status, JSON.stringify(close)).toBe(400);
    expect((await request(HOST_TOKEN, "POST", "/triggers", { ...trigger(), agentId: other.id, sessionId: first.body.sessionId, close: true })).status).toBe(404);
    await w.work.closeSession(teamId, second.body.sessionId);
    expect((await request(HOST_TOKEN, "POST", "/triggers", { ...trigger(), sessionId: second.body.sessionId, close: true })).status).toBe(409);
  });

  it("HK5: by identity, a token of the configured issuer for the audience naming the host's subject; another subject or audience is 401", async () => {
    const byIdentity = appWith(hostIdentitySender({ issuer: issuer.url, audience: AUDIENCE, subject: "host@example.test" }));
    const { teamId, admin } = await team();
    const agent = (await request(admin, "POST", `/teams/${teamId}/agents`, { name: "Clerk" })).body;
    const trigger = () => ({ teamId, agentId: agent.id, event: "e", reference: randomUUID() });
    const ok = issuer.token({ sub: "host@example.test", aud: AUDIENCE });
    expect((await request(ok, "POST", "/triggers", trigger(), byIdentity)).status).toBe(202);
    expect((await request(issuer.token({ sub: "other@example.test", aud: AUDIENCE }), "POST", "/triggers", trigger(), byIdentity)).status).toBe(401);
    expect((await request(issuer.token({ sub: "host@example.test", aud: "https://other.example.test" }), "POST", "/triggers", trigger(), byIdentity)).status).toBe(401);
    expect((await request(issuer.forged({ sub: "host@example.test", aud: AUDIENCE }), "POST", "/triggers", trigger(), byIdentity)).status).toBe(401);
    expect((await request(HOST_TOKEN, "POST", "/triggers", trigger(), byIdentity)).status).toBe(401);
  });
});

describe("an agent's own connections (requirement 0004)", () => {
  const echo = { name: "lookup", readOnly: true, answer: (args: Record<string, unknown>) => ({ text: `found ${String(args["q"])}` }) };

  async function setUp(auth: "key" | "oauth", service: FakeMcp) {
    const { teamId, admin, member } = await team();
    const profile = await request(admin, "POST", `/teams/${teamId}/profiles`, claudeProfile());
    const agent = (await request(admin, "POST", `/teams/${teamId}/agents`, { name: "Clerk", profileId: profile.body.id })).body;
    const connection = (await request(admin, "POST", `/teams/${teamId}/connections`, { name: "crm", url: service.url, auth })).body;
    return { teamId, admin, member, agent, connection, base: `/teams/${teamId}/agents/${agent.id}/credentials/${connection.id}` };
  }
  const runOf = async (teamId: string, sessionId: string) => (await w.store.forTeam(teamId).listRuns({ sessionId })).at(-1)!;

  it("AS6: with a key from the service, the agent sees its tools as crm__*; a refused key waits for a person (auth_required), a new key resumes the run", async () => {
    const crm = await service({ tools: [echo], auth: { token: `crm-key-${CANARY}` } });
    const { teamId, admin, member, agent, base } = await setUp("key", crm);
    expect((await request(admin, "PUT", base, { key: `crm-key-${CANARY}` })).status).toBe(204);
    expect((await request(admin, "GET", `/teams/${teamId}/agents/${agent.id}/credentials`)).body.credentials).toEqual([expect.objectContaining({ connection: "crm", kind: "key", state: "active" })]);
    expect((await request(member, "PUT", base, { key: "x" })).status).toBe(403);
    const { sessionId } = (await request(member, "POST", `/teams/${teamId}/agents/${agent.id}/sessions`, { message: "Find Ada." })).body;
    w.anthropic.script(toolCall("crm__lookup", { q: "Ada" }), say("Ada found."), say("Summary."));
    await w.tick();
    expect(w.anthropic.requests[0]!.body.tools.map((t: { name: string }) => t.name)).toContain("crm__lookup");
    expect(crm.requests.filter((r) => r.body?.method === "tools/call")[0]!.headers["authorization"]).toBe(`Bearer crm-key-${CANARY}`);
    expect((await runOf(teamId, sessionId)).state).toBe("completed");
    expect(responses.join("\n")).not.toContain(`crm-key-${CANARY}`);

    // The key no longer valid: the call waits for a person to sign the agent in again.
    await request(admin, "PUT", base, { key: "wrong-key" });
    await request(member, "POST", `/teams/${teamId}/sessions/${sessionId}/messages`, { message: "Find Bob." });
    w.anthropic.script(say("Nothing reachable."), say("Summary."));
    await w.tick();
    expect(JSON.stringify(w.anthropic.requests.at(-2)!.body.messages)).toContain("crm (a person has to sign you in again)");
    expect((await request(admin, "GET", `/teams/${teamId}/agents/${agent.id}/credentials`)).body.credentials[0].state).toBe("needs-auth");
    await request(admin, "PUT", base, { key: `crm-key-${CANARY}` });
    expect((await request(admin, "GET", `/teams/${teamId}/agents/${agent.id}/credentials`)).body.credentials[0].state).toBe("active");
  });

  it("AS7: OAuth: a person signs the agent in at the service (client ID metadata document, PKCE, resource, iss); the token is renewed when refused; a grant that cannot be renewed waits for the next sign-in, which resumes the run", async () => {
    const crm = await service({ tools: [echo], auth: "oauth", cimd: true });
    const { teamId, admin, member, agent, base } = await setUp("oauth", crm);
    const started = await request(admin, "POST", `${base}/oauth`);
    expect(started.status).toBe(201);
    const authorize = new URL(started.body.authorizationUrl);
    expect(authorize.searchParams.get("client_id")).toBe(`${PUBLIC_URL}/oauth/client-metadata.json`);
    expect(authorize.searchParams.get("resource")).toBe(crm.url);
    expect((await request(undefined, "GET", "/oauth/client-metadata.json")).body).toMatchObject({ client_id: `${PUBLIC_URL}/oauth/client-metadata.json`, redirect_uris: [`${PUBLIC_URL}/oauth/callback`] });
    const back = new URL((await fetch(authorize, { redirect: "manual" })).headers.get("location")!);
    const callback = `/oauth/callback${back.search}`;
    expect(await request(undefined, "GET", callback)).toMatchObject({ status: 200, body: "Signed in. You can close this window." });
    expect((await request(undefined, "GET", callback)).status, "a state is used once").toBe(400);
    expect((await request(admin, "GET", `/teams/${teamId}/agents/${agent.id}/credentials`)).body.credentials).toEqual([expect.objectContaining({ kind: "oauth", state: "active", scope: "read" })]);
    const tokenRequests = () => crm.requests.filter((r) => r.path === "/token").length;
    expect(tokenRequests()).toBe(1);

    // Refused once: renewed with the refresh token, the call made again.
    crm.revoke();
    const { sessionId } = (await request(member, "POST", `/teams/${teamId}/agents/${agent.id}/sessions`, { message: "Find Ada." })).body;
    w.anthropic.script(toolCall("crm__lookup", { q: "Ada" }), say("Ada found."), say("Summary."));
    await w.tick();
    expect(tokenRequests()).toBe(2);
    expect((await runOf(teamId, sessionId)).state).toBe("completed");

    // Mid-run, the grant gone: the call waits for a person; signing in again resumes it.
    let revokeNow = false;
    await request(member, "POST", `/teams/${teamId}/sessions/${sessionId}/messages`, { message: "Find Bob." });
    w.anthropic.script((_r: unknown) => {
      revokeNow = true;
      crm.revoke({ refreshTokens: true });
      return { body: toolCall("crm__lookup", { q: "Bob" }) };
    });
    await w.tick();
    expect(revokeNow).toBe(true);
    expect(await runOf(teamId, sessionId)).toMatchObject({ state: "auth_required", waitingOn: { kind: "credential", connection: "crm" } });
    expect(w.events.at(-1)).toMatchObject({ type: "run.waiting", state: "auth_required" });
    expect((await request(member, "POST", `${base}/oauth`)).status, "only the agent's editors sign it in").toBe(403);
    const signIn = new URL((await request(admin, "POST", `${base}/oauth`)).body.authorizationUrl);
    const returned = new URL((await fetch(signIn, { redirect: "manual" })).headers.get("location")!);
    expect((await request(undefined, "GET", `/oauth/callback${returned.search}`)).status).toBe(200);
    expect((await runOf(teamId, sessionId)).state).toBe("queued");
    w.anthropic.script(say("Bob found."), say("Summary."));
    await w.tick();
    expect((await runOf(teamId, sessionId)).state).toBe("completed");
    expect(JSON.stringify(w.anthropic.requests.at(-2)!.body.messages)).toContain("found Bob");
  });

  it("AS15: two runs of one agent working at once at one OAuth service: the token one renewed is taken by the other, which waits for no one", async () => {
    const crm = await service({ tools: [echo], auth: "oauth", cimd: true });
    const { teamId, admin, member, agent, base } = await setUp("oauth", crm);
    const authorize = new URL((await request(admin, "POST", `${base}/oauth`)).body.authorizationUrl);
    const back = new URL((await fetch(authorize, { redirect: "manual" })).headers.get("location")!);
    expect((await request(undefined, "GET", `/oauth/callback${back.search}`)).status).toBe(200);
    crm.revoke();
    const sessions = [];
    for (const message of ["Find Ada.", "Find Bob."]) sessions.push((await request(member, "POST", `/teams/${teamId}/agents/${agent.id}/sessions`, { message })).body.sessionId as string);
    w.anthropic.script(toolCall("crm__lookup", { q: "Ada" }), toolCall("crm__lookup", { q: "Bob" }), say("Found."), say("Found."), say("Summary."), say("Summary."));
    await w.tick();
    for (const sessionId of sessions) expect((await runOf(teamId, sessionId)).state).toBe("completed");
    const sent = JSON.stringify(w.anthropic.requests.map((r) => r.body.messages));
    expect(sent).toContain("found Ada");
    expect(sent).toContain("found Bob");
    expect(sent).not.toContain("sign you in again");
    expect((await request(admin, "GET", `/teams/${teamId}/agents/${agent.id}/credentials`)).body.credentials[0].state).toBe("active");
  });

  it("AS7: a tool refused for a missing scope (403 insufficient_scope) waits for a person; the next sign-in asks for the wider scope and the call goes through", async () => {
    const writer = { name: "update", scope: "write", answer: () => ({ text: "Updated." }) };
    const crm = await service({ tools: [echo, writer], auth: "oauth", cimd: true });
    const { teamId, admin, member, agent, base } = await setUp("oauth", crm);
    const signIn = async () => {
      const url = new URL((await request(admin, "POST", `${base}/oauth`)).body.authorizationUrl);
      const back = new URL((await fetch(url, { redirect: "manual" })).headers.get("location")!);
      expect((await request(undefined, "GET", `/oauth/callback${back.search}`)).status).toBe(200);
      return url.searchParams.get("scope");
    };
    expect(await signIn()).toBe("read");
    const { sessionId } = (await request(member, "POST", `/teams/${teamId}/agents/${agent.id}/sessions`, { message: "Update Ada." })).body;
    w.anthropic.script(toolCall("crm__update", { id: "ada" }));
    await w.tick();
    expect(await runOf(teamId, sessionId)).toMatchObject({ state: "auth_required", waitingOn: { kind: "credential", connection: "crm" } });
    expect((await request(admin, "GET", `/teams/${teamId}/agents/${agent.id}/credentials`)).body.credentials[0]).toMatchObject({ state: "needs-auth", scope: "read write" });
    expect(await signIn()).toBe("read write");
    w.anthropic.script(say("Ada updated."), say("Summary."));
    await w.tick();
    expect((await runOf(teamId, sessionId)).state).toBe("completed");
    expect(JSON.stringify(w.anthropic.requests.at(-2)!.body.messages)).toContain("Updated.");
  });

  it("negative (AS7): a callback with an unknown state, an error from the service or another issuer signs nobody in; a connection with a key refuses OAuth, and the other way round", async () => {
    const crm = await service({ tools: [echo], auth: "oauth", cimd: true });
    const { admin, base, teamId, agent } = await setUp("oauth", crm);
    expect((await request(undefined, "GET", "/oauth/callback?state=unknown&code=x")).status).toBe(400);
    const started = new URL((await request(admin, "POST", `${base}/oauth`)).body.authorizationUrl);
    const back = new URL((await fetch(started, { redirect: "manual" })).headers.get("location")!);
    back.searchParams.set("iss", "https://evil.example.test");
    expect((await request(undefined, "GET", `/oauth/callback${back.search}`)).body).toContain("another issuer");
    expect((await request(admin, "GET", `/teams/${teamId}/agents/${agent.id}/credentials`)).body.credentials).toEqual([]);
    expect((await request(admin, "PUT", base, { key: "k" })).status).toBe(409);
    const keyed = await setUp("key", await service({ tools: [echo], auth: { token: "t".repeat(40) } }));
    expect((await request(keyed.admin, "POST", `${keyed.base}/oauth`)).status).toBe(409);
  });
});
