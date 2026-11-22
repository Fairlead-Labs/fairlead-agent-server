import type { PGlite } from "@electric-sql/pglite";
import { randomBytes, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { dueRuns, newRun, PostgresAgentStore, PostgresConnectionStore, PostgresRunStore, type Run, type Session } from "../src/index.js";
import { database, newAgent, newProfile, T0 } from "./support/db.js";

/**
 * The stores on real Postgres semantics (PGlite), as a role row-level
 * security applies to: requirement 0001 (RN1, RN2, RN20) and requirement
 * 0004 (AS1, AS6, AS10). Every test works in teams of its own.
 */

let db: PGlite;
let runs: PostgresRunStore;
let agents: PostgresAgentStore;
let connections: PostgresConnectionStore;

beforeAll(async () => {
  db = await database();
  runs = new PostgresRunStore(db);
  agents = new PostgresAgentStore(db);
  connections = new PostgresConnectionStore(db);
});

const sealed = { keyId: "k1", sealed: "c2VhbGVk" };
const later = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

/** A team with one agent and an open session. */
async function teamWithSession(sessionOverrides: Partial<Session> = {}) {
  const teamId = randomUUID();
  const agent = newAgent(teamId);
  await agents.forTeam(teamId).insertAgent(agent);
  const session: Session = {
    id: randomUUID(),
    teamId,
    agentId: agent.id,
    state: "open",
    closeReason: null,
    ownerUserIds: [],
    startedByUserId: null,
    createdAt: T0,
    updatedAt: T0,
    lastActivityAt: T0,
    closedAt: null,
    version: 1,
    ...sessionOverrides,
  };
  await runs.forTeam(teamId).insertSession(session);
  return { teamId, agent, session, team: runs.forTeam(teamId) };
}
const runOf = (s: Pick<Session, "id" | "agentId" | "teamId">, overrides: Partial<Run> = {}): Run => ({
  ...newRun({ id: randomUUID(), teamId: s.teamId, sessionId: s.id, agentId: s.agentId, cause: "trigger", queuedAt: T0 }),
  ...overrides,
});

describe("the runs store (requirement 0001)", () => {
  it("RN1: a session keeps its team and owners (empty = the whole team); owners change by compare-and-set; closed sessions are listed apart", async () => {
    const { team, session } = await teamWithSession({ ownerUserIds: ["u-ada"] });
    expect(await team.findSession(session.id)).toEqual(session);
    const changed = await team.updateSession(session.id, 1, { ownerUserIds: [], updatedAt: T0 });
    expect(changed).toMatchObject({ ownerUserIds: [], version: 2 });
    expect(await team.updateSession(session.id, 1, { ownerUserIds: ["u-bob"] }), "a stale version").toBeUndefined();
    await team.updateSession(session.id, 2, { state: "closed", closeReason: "closed", closedAt: T0 });
    expect(await team.listSessions({ state: "open" })).toEqual([]);
    expect((await team.listSessions({ state: "closed" })).map((s) => s.id)).toEqual([session.id]);
  });

  it("RN2: of two claims of one queued run one wins, starting its slice; one working run per agent; one open run per session", async () => {
    const { team, session, teamId, agent } = await teamWithSession();
    const queued = runOf(session);
    await team.insertRun(queued);
    const at = new Date(T0);
    const [a, b] = await Promise.all([team.claim(queued.id, at), team.claim(queued.id, at)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect((a ?? b)!).toMatchObject({ state: "working", claimedAt: T0, sliceStartedAt: T0 });
    await expect(team.insertRun(runOf(session)), "a second open run of the session").rejects.toMatchObject({ code: "23505" });
    // Another session of the same agent: queued, but not claimed while the first works.
    const other: Session = { ...session, id: randomUUID() };
    await team.insertSession(other);
    const second = runOf(other);
    await team.insertRun(second);
    expect(await team.claim(second.id, at)).toBeUndefined();
    expect(await runs.findRun(queued.id)).toEqual({ id: queued.id, teamId, agentId: agent.id, sessionId: session.id, state: "working", sliceStartedAt: T0 });
  });

  it("RN2: due runs by priority, due date, then age, one per agent; a run queued for later (a task's next poll) waits", () => {
    const s = { id: "s", agentId: "a1", teamId: "t" };
    const low = runOf(s, { priority: "low", queuedAt: later(-10) });
    const highLate = runOf(s, { priority: "high", dueOn: "2026-12-01" });
    const highSoon = runOf(s, { priority: "high", dueOn: "2026-11-25" });
    const otherAgent = runOf({ ...s, agentId: "a2" }, { queuedAt: later(5) });
    const busy = runOf({ ...s, agentId: "a3" }, { state: "working" });
    const blocked = runOf({ ...s, agentId: "a3" });
    expect(dueRuns([low, highLate, highSoon, otherAgent, busy, blocked], new Date(T0)).map((r) => r.id)).toEqual([highSoon.id]);
    expect(dueRuns([low, otherAgent], new Date(later(5))).map((r) => r.id)).toEqual([low.id, otherAgent.id]);
  });

  it("RN2: a run's changes by compare-and-set; steps stored in order, a number once", async () => {
    const { team, session } = await teamWithSession();
    const run = runOf(session);
    await team.insertRun(run);
    const changed = await team.updateRun(run.id, 1, { steps: 1, waitingOn: { kind: "credential", callId: "c1", connection: "crm" } });
    expect(changed).toMatchObject({ version: 2, steps: 1, waitingOn: { kind: "credential", connection: "crm" } });
    expect(await team.updateRun(run.id, 1, { steps: 2 })).toBeUndefined();
    await team.insertStep({ id: randomUUID(), runId: run.id, n: 1, kind: "model", at: T0, tool: null, toolCallId: null, inputTokens: 10, outputTokens: 2 });
    await expect(team.insertStep({ id: randomUUID(), runId: run.id, n: 1, kind: "model", at: T0, tool: null, toolCallId: null, inputTokens: 0, outputTokens: 0 })).rejects.toBeTruthy();
    expect((await team.listSteps(run.id)).map((s) => s.n)).toEqual([1]);
  });

  it("AS10: a reference starts work once per agent and sender; triggers are delivered to one run, in order", async () => {
    const { team, session, teamId, agent } = await teamWithSession();
    const trigger = (reference: string, at = T0) => ({ id: randomUUID(), teamId, sessionId: session.id, agentId: agent.id, sender: "host" as const, userId: null, event: "task.assigned", reference, body: sealed, receivedAt: at, runId: null });
    const first = trigger("r1");
    expect(await team.insertTrigger(first)).toEqual({ stored: "ok" });
    expect(await team.insertTrigger(trigger("r1"))).toMatchObject({ stored: "exists", trigger: { id: first.id } });
    expect(await team.insertTrigger({ ...trigger("r1"), sender: "user", userId: "u1" })).toEqual({ stored: "ok" });
    const second = trigger("r2", later(1));
    await team.insertTrigger(second);
    expect((await team.findTriggerByReference(agent.id, "host", "r1"))?.id).toBe(first.id);
    const run = runOf(session);
    await team.insertRun(run);
    await team.deliverTriggers([first.id], run.id);
    expect((await team.listTriggers(session.id, { undelivered: true })).map((t) => t.reference)).toEqual(["r1", "r2"]);
  });

  it("AS10: a session closes after 7 days idle only without an open run; activity keeps it open", async () => {
    const idle = await teamWithSession({ lastActivityAt: later(-8 * 24 * 60) });
    const busy = await teamWithSession({ lastActivityAt: later(-8 * 24 * 60) });
    await busy.team.insertRun(runOf(busy.session, { state: "input_required" }));
    const touched = await teamWithSession({ lastActivityAt: later(-8 * 24 * 60) });
    await touched.team.touchSession(touched.session.id, T0);
    const before = new Date(later(-7 * 24 * 60));
    expect(await idle.team.closeIdleSessions(before, new Date(T0))).toBe(1);
    expect(await idle.team.findSession(idle.session.id)).toMatchObject({ state: "closed", closeReason: "idle" });
    expect(await busy.team.closeIdleSessions(before, new Date(T0))).toBe(0);
    expect(await touched.team.closeIdleSessions(before, new Date(T0))).toBe(0);
  });

  it("RN20: transcripts, summaries, results and delivered triggers' bodies are purged for runs ended before the cutoff; the facts stay; a recent run keeps them", async () => {
    const { team, session, teamId, agent } = await teamWithSession();
    const old = runOf(session, { state: "completed", endedAt: later(-31 * 24 * 60), transcript: sealed, summary: sealed, result: sealed, steps: 4 });
    await team.insertRun(old);
    await team.insertTrigger({ id: randomUUID(), teamId, sessionId: session.id, agentId: agent.id, sender: "host", userId: null, event: "e", reference: "old", body: sealed, receivedAt: T0, runId: null });
    const [t] = await team.listTriggers(session.id);
    await team.deliverTriggers([t!.id], old.id);
    const recent = runOf(session, { state: "completed", endedAt: later(-1), transcript: sealed });
    await team.insertRun(recent);
    expect(await team.purgeTranscripts(new Date(later(-30 * 24 * 60)))).toBe(1);
    expect(await team.findRun(old.id)).toMatchObject({ transcript: null, summary: null, result: null, steps: 4 });
    expect((await team.listTriggers(session.id))[0]!.body).toBeNull();
    expect((await team.findRun(recent.id))!.transcript).toEqual(sealed);
  });

  it("AS10: usage adds up per day, agent and user", async () => {
    const { team, agent } = await teamWithSession();
    await team.addUsage("2026-11-21", agent.id, "u1", { sessions: 1 });
    await team.addUsage("2026-11-21", agent.id, "u1", { runs: 1, inputTokens: 100, outputTokens: 7 });
    await team.addUsage("2026-11-21", agent.id, null, { runs: 1 });
    const rows = await team.listUsage("2026-11-01", "2026-11-30");
    expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ userId: "u1", sessions: 1, runs: 1, inputTokens: 100, outputTokens: 7 })]));
    expect(rows).toHaveLength(2);
  });

  it("negative (RN2, RN20): another team's sessions, runs, triggers, questions and usage are never listed, found, claimed, changed or purged", async () => {
    const a = await teamWithSession();
    const b = await teamWithSession();
    const run = runOf(a.session, { state: "completed", endedAt: later(-60 * 24 * 60), transcript: sealed });
    await a.team.insertRun(run);
    const queued = runOf({ ...a.session, id: randomUUID() });
    await a.team.insertSession({ ...a.session, id: queued.sessionId });
    await a.team.insertRun(queued);
    await a.team.insertQuestion({ id: randomUUID(), teamId: a.teamId, sessionId: a.session.id, runId: run.id, kind: "agent", cause: null, body: sealed, state: "open", answer: null, answeredBy: null, createdAt: T0, answeredAt: null, version: 1 });
    await a.team.addUsage("2026-11-21", a.agent.id, null, { runs: 1 });
    expect(await b.team.findSession(a.session.id)).toBeUndefined();
    expect(await b.team.findRun(run.id)).toBeUndefined();
    expect(await b.team.listRuns()).toEqual([]);
    expect(await b.team.listQuestions()).toEqual([]);
    expect(await b.team.listUsage("2026-01-01", "2026-12-31")).toEqual([]);
    expect(await b.team.claim(queued.id, new Date(T0))).toBeUndefined();
    expect(await b.team.updateRun(queued.id, 1, { state: "cancelled" })).toBeUndefined();
    expect(await b.team.purgeTranscripts(new Date(T0))).toBe(0);
    expect((await a.team.findRun(run.id))!.transcript).toEqual(sealed);
    // Row-level security on its own: with no team bound, the role reads nothing.
    expect((await db.query("SELECT id FROM runs")).rows).toEqual([]);
    expect((await db.query("SELECT id FROM sessions")).rows).toEqual([]);
  });
});

describe("the agents store (requirement 0004)", () => {
  it("AS1: agents and profiles inserted, listed, changed by compare-and-set; a removed agent is found but not listed; a named profile is not deleted", async () => {
    const teamId = randomUUID();
    const team = agents.forTeam(teamId);
    const profile = newProfile(teamId, { apiKey: sealed });
    await team.insertProfile(profile);
    const agent = newAgent(teamId, { profileId: profile.id, ownerUserId: "u-ada" });
    await team.insertAgent(agent);
    expect(await team.findAgent(agent.id)).toEqual(agent);
    expect(await team.findProfile(profile.id)).toEqual(profile);
    const paused = await team.updateAgent(agent.id, 1, { paused: true, limits: { steps: null, inputTokens: 5_000, runsPerTrigger: 2 } });
    expect(paused).toMatchObject({ paused: true, version: 2, limits: { steps: null } });
    expect(await team.updateAgent(agent.id, 1, { paused: false })).toBeUndefined();
    expect(await team.deleteProfile(profile.id)).toBe("in-use");
    await team.updateAgent(agent.id, 2, { removedAt: T0, profileId: null });
    expect(await team.listAgents()).toEqual([]);
    expect((await team.findAgent(agent.id))?.removedAt).toBe(T0);
    expect(await team.deleteProfile(profile.id)).toBe("deleted");
    expect(await team.deleteProfile(profile.id)).toBe("not-found");
  });

  it("negative (AS1): an agent never names another team's profile; another team's agents and profiles are never found, changed or deleted", async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    const profile = newProfile(a);
    await agents.forTeam(a).insertProfile(profile);
    const agent = newAgent(a);
    await agents.forTeam(a).insertAgent(agent);
    await expect(agents.forTeam(b).insertAgent(newAgent(b, { profileId: profile.id }))).rejects.toMatchObject({ name: "UnknownProfileError" });
    expect(await agents.forTeam(b).findAgent(agent.id)).toBeUndefined();
    expect(await agents.forTeam(b).findProfile(profile.id)).toBeUndefined();
    expect(await agents.forTeam(b).updateAgent(agent.id, 1, { paused: true })).toBeUndefined();
    expect(await agents.forTeam(b).deleteProfile(profile.id)).toBe("not-found");
    expect((await db.query("SELECT id FROM agents")).rows).toEqual([]);
  });
});

describe("the connections store (requirement 0004)", () => {
  async function teamWithConnection() {
    const teamId = randomUUID();
    const agent = newAgent(teamId);
    await agents.forTeam(teamId).insertAgent(agent);
    const connection = { id: randomUUID(), teamId, name: "crm", url: "https://crm.example.test/mcp", auth: "oauth" as const, oauthClient: null, revision: null, createdAt: T0, updatedAt: T0, version: 1 };
    expect(await connections.forTeam(teamId).insertConnection(connection)).toBe("inserted");
    return { teamId, agent, connection, team: connections.forTeam(teamId) };
  }
  const credential = (teamId: string, agentId: string, connectionId: string) => ({
    teamId,
    agentId,
    connectionId,
    kind: "key" as const,
    secret: sealed,
    access: null,
    accessExpiresAt: null,
    scope: null,
    state: "active" as const,
    createdAt: T0,
    updatedAt: T0,
    version: 1,
  });

  it("AS6: a name once per team; one credential per agent and connection, replaced by a new one; deleting the connection takes its credentials", async () => {
    const { team, teamId, agent, connection } = await teamWithConnection();
    expect(await team.insertConnection({ ...connection, id: randomUUID() })).toBe("exists");
    await team.putCredential(credential(teamId, agent.id, connection.id));
    await team.putCredential({ ...credential(teamId, agent.id, connection.id), kind: "oauth", scope: "read" });
    expect(await team.listCredentials(agent.id)).toEqual([expect.objectContaining({ kind: "oauth", scope: "read" })]);
    const marked = await team.updateCredential(agent.id, connection.id, (await team.findCredential(agent.id, connection.id))!.version, { state: "needs-auth" });
    expect(marked?.state).toBe("needs-auth");
    expect(await team.deleteConnection(connection.id)).toBe(true);
    expect(await team.listCredentials()).toEqual([]);
  });

  it("AS7: a pending sign-in is taken once by its state, across teams, and only before it expires", async () => {
    const { teamId, agent, connection, team } = await teamWithConnection();
    const state = randomBytes(32).toString("base64url");
    await team.insertPending({ state, teamId, agentId: agent.id, connectionId: connection.id, userId: "u1", flow: sealed, expiresAt: later(10) });
    expect(await connections.takePending(state, new Date(T0))).toMatchObject({ teamId, agentId: agent.id });
    expect(await connections.takePending(state, new Date(T0)), "used up").toBeUndefined();
    const expired = randomBytes(32).toString("base64url");
    await team.insertPending({ state: expired, teamId, agentId: agent.id, connectionId: connection.id, userId: "u1", flow: sealed, expiresAt: later(10) });
    expect(await connections.takePending(expired, new Date(later(11)))).toBeUndefined();
    expect(await connections.takePending("short", new Date(T0))).toBeUndefined();
    expect((await db.query("SELECT state FROM oauth_pending")).rows, "no state bound, none read").toEqual([]);
  });

  it("negative (AS6): another team's connections and credentials are never listed, found, changed or deleted; a credential never names another team's agent or connection", async () => {
    const a = await teamWithConnection();
    const b = await teamWithConnection();
    await a.team.putCredential(credential(a.teamId, a.agent.id, a.connection.id));
    expect(await b.team.findConnection(a.connection.id)).toBeUndefined();
    expect((await b.team.listConnections()).map((c) => c.id)).toEqual([b.connection.id]);
    expect(await b.team.findCredential(a.agent.id, a.connection.id)).toBeUndefined();
    expect(await b.team.updateCredential(a.agent.id, a.connection.id, 1, { state: "needs-auth" })).toBeUndefined();
    expect(await b.team.deleteConnection(a.connection.id)).toBe(false);
    await expect(b.team.putCredential(credential(b.teamId, a.agent.id, b.connection.id))).rejects.toBeTruthy();
    await expect(b.team.putCredential(credential(b.teamId, b.agent.id, a.connection.id))).rejects.toBeTruthy();
    expect((await db.query("SELECT team_id FROM agent_credentials")).rows).toEqual([]);
  });
});
