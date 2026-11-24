import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inTeam } from "../../src/db/sql-database.js";
import { createAccountDeletion } from "../../src/deletion.js";
import { createApiApp } from "../../src/server/api.js";
import { createDirectoryApp } from "../../src/server/directory-api.js";
import { createOidcVerifier } from "../../src/server/oidc.js";
import { hostIdentitySender, hostTokenSender } from "../../src/server/senders.js";
import { startFakeOidcIssuer, type FakeOidcIssuer } from "../../src/testing/index.js";
import { HOST_TOKEN, startWorld, type World } from "../support/world.js";

/**
 * Deleted accounts (requirement 0003, DL1–DL4): the sign-in service's
 * `POST /users/deleted`, over a real loopback issuer and PGlite.
 */

const AUDIENCE = "https://agents.example.test";
const DELETION_AUDIENCE = "https://agents.example.test/users/deleted";
const SIGN_IN_SERVICE = "sign-in-service@example.test";
let w: World;
let issuer: FakeOidcIssuer;
let app: Hono;

beforeAll(async () => {
  w = await startWorld();
  issuer = await startFakeOidcIssuer();
  const verify = createOidcVerifier({ issuer: issuer.url, audience: AUDIENCE, rolesClaim: "groups", adminRole: "agent-server-admin" });
  app = new Hono();
  app.route(
    "/",
    createApiApp({
      directory: w.directory,
      verify,
      store: w.store,
      agents: w.agents,
      connections: w.connections,
      sealer: w.sealer,
      work: w.work,
      senders: hostTokenSender(HOST_TOKEN),
      accountDeletion: {
        callers: hostIdentitySender({ issuer: issuer.url, audience: DELETION_AUDIENCE, subject: SIGN_IN_SERVICE }),
        deleteUser: createAccountDeletion({ db: w.db, directory: w.directory, work: w.work, now: () => w.at }),
      },
      publicUrl: "http://127.0.0.1:9",
      now: () => w.at,
    }),
  );
  app.route("/", createDirectoryApp({ directory: w.directory, verify, teamCreation: "users" }));
});
afterAll(async () => {
  await issuer.close();
  await w.close();
});

async function request(token: string | undefined, method: string, path: string, body?: unknown) {
  const response = await app.request(path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

interface Person {
  subject: string;
  token: string;
  id: string;
}
async function person(): Promise<Person> {
  const subject = randomUUID();
  const token = issuer.token({ sub: subject, aud: AUDIENCE, email: `${subject}@example.test`, email_verified: true, groups: [] });
  return { subject, token, id: (await request(token, "GET", "/me")).body.user.id };
}
const deletion = (subject: string, token = issuer.token({ sub: SIGN_IN_SERVICE, aud: DELETION_AUDIENCE })) => request(token, "POST", "/users/deleted", { issuer: issuer.url, subject });
const rowsIn = async (teamId: string, sql: string) => (await inTeam(w.db, teamId, (tx) => tx.query<Record<string, unknown>>(sql, [teamId]))).rows;
const userRow = async (subject: string) =>
  (await w.db.query<{ email: string | null; deleted_at: Date | null }>("SELECT email, deleted_at FROM directory.users WHERE issuer = $1 AND subject = $2", [issuer.url, subject])).rows[0];

/** A person with a personal space (an agent, a profile, a session) and, in a team, a personal agent with an open session, owner marks on a team agent's session and as its default owner. */
async function personWithEverything(admin: Person, teamId: string, teamAgentId: string) {
  const who = await person();
  expect((await request(admin.token, "POST", `/teams/${teamId}/members`, { userId: who.id, role: "member" })).status).toBe(204);
  const space = (await request(who.token, "POST", "/me/personal-space")).body.id as string;
  const spaceProfile = await request(who.token, "POST", `/teams/${space}/profiles`, { name: "Mine", provider: "claude-api", model: "claude-sonnet-5-5", apiKey: "sk-test", personal: true });
  const spaceAgent = await request(who.token, "POST", `/teams/${space}/agents`, { name: "Mine", personal: true, profileId: spaceProfile.body.id });
  expect((await request(who.token, "POST", `/teams/${space}/agents/${spaceAgent.body.id}/sessions`, { message: "Sort my mail." })).status).toBe(201);
  const profile = await request(who.token, "POST", `/teams/${teamId}/profiles`, { name: "Mine", provider: "claude-api", model: "claude-sonnet-5-5", apiKey: "sk-test", personal: true });
  const agent = await request(who.token, "POST", `/teams/${teamId}/agents`, { name: "Helper", personal: true, profileId: profile.body.id });
  const session = await request(who.token, "POST", `/teams/${teamId}/agents/${agent.body.id}/sessions`, { message: "Draft the minutes." });
  expect(session.status).toBe(201);
  const teamSession = await request(admin.token, "POST", `/teams/${teamId}/agents/${teamAgentId}/sessions`, { message: "Book invoice 7.", ownerUserIds: [admin.id, who.id] });
  expect(teamSession.status).toBe(201);
  return { who, space, agentId: agent.body.id as string, profileId: profile.body.id as string, sessionId: session.body.sessionId as string, teamSessionId: teamSession.body.sessionId as string };
}

describe("deleted accounts (requirement 0003)", () => {
  it("DL1–DL3: the sign-in service's identity marks the user deleted; their personal space's records, their personal agents in teams and their owner marks go; another user's stay", async () => {
    const admin = await person();
    const teamId = (await request(admin.token, "POST", "/teams", { name: "Finance" })).body.id as string;
    const teamAgent = await request(admin.token, "POST", `/teams/${teamId}/agents`, { name: "Clerk" });
    const ada = await personWithEverything(admin, teamId, teamAgent.body.id);
    const bob = await personWithEverything(admin, teamId, teamAgent.body.id);
    const defaults = await request(admin.token, "PATCH", `/teams/${teamId}/agents/${teamAgent.body.id}`, { version: teamAgent.body.version, defaultOwnerUserIds: [ada.who.id, bob.who.id] });
    expect(defaults.status).toBe(200);

    expect(await deletion(ada.who.subject)).toMatchObject({ status: 204 });

    // DL1: the row stays, marked, without its email; the person is never let in again.
    expect(await userRow(ada.who.subject)).toMatchObject({ email: null, deleted_at: w.at });
    expect((await request(ada.who.token, "GET", "/me")).status).toBe(401);
    expect((await request(ada.who.token, "GET", `/teams/${teamId}/agents`)).status).toBe(401);
    // DL2: nothing of the server's in the personal space; the directory's space stays for a sharing product to remove.
    for (const table of ["agents", "profiles", "sessions", "runs", "triggers", "usage", "team_keys"]) expect(await rowsIn(ada.space, `SELECT 1 FROM ${table} WHERE team_id = $1`), table).toEqual([]);
    expect((await w.db.query("SELECT 1 FROM directory.teams WHERE id = $1", [ada.space])).rows).toHaveLength(1);
    // DL2: the personal agent in the team removed, its session closed, the owner's own profile gone.
    expect((await w.agents.forTeam(teamId).findAgent(ada.agentId))?.removedAt).not.toBeNull();
    expect(await w.store.forTeam(teamId).findSession(ada.sessionId)).toMatchObject({ state: "closed", closeReason: "agent-removed" });
    expect(await w.agents.forTeam(teamId).findProfile(ada.profileId)).toBeUndefined();
    // DL2: the owner marks dropped.
    expect((await w.store.forTeam(teamId).findSession(ada.teamSessionId))?.ownerUserIds).toEqual([admin.id]);
    expect((await w.agents.forTeam(teamId).findAgent(teamAgent.body.id))?.defaultOwnerUserIds).toEqual([bob.who.id]);

    // Negative: another user's records are untouched.
    expect(await userRow(bob.who.subject)).toMatchObject({ deleted_at: null });
    expect((await request(bob.who.token, "GET", "/me")).status).toBe(200);
    expect((await rowsIn(bob.space, "SELECT 1 FROM agents WHERE team_id = $1")).length).toBe(1);
    expect((await w.agents.forTeam(teamId).findAgent(bob.agentId))?.removedAt).toBeNull();
    expect(await w.store.forTeam(teamId).findSession(bob.sessionId)).toMatchObject({ state: "open" });
    expect(await w.agents.forTeam(teamId).findProfile(bob.profileId)).toBeDefined();
    expect((await w.store.forTeam(teamId).findSession(bob.teamSessionId))?.ownerUserIds).toEqual([admin.id, bob.who.id]);

    // DL3: twice is the same, the first time kept.
    const first = w.at;
    w.advance(3_600_000);
    expect((await deletion(ada.who.subject)).status).toBe(204);
    expect(await userRow(ada.who.subject)).toMatchObject({ deleted_at: first });
  });

  it("DL1: a person the server never saw is marked too, so a product sharing the directory learns of it", async () => {
    const subject = randomUUID();
    expect((await deletion(subject)).status).toBe(204);
    expect(await userRow(subject)).toMatchObject({ email: null, deleted_at: w.at });
  });

  it("negative (DL4): the host's credential, a person's token, a token for another audience or subject, a forged one or none is 401, and nothing is marked; a body without an issuer or subject is 400", async () => {
    const ada = await person();
    for (const token of [
      HOST_TOKEN,
      ada.token,
      issuer.token({ sub: SIGN_IN_SERVICE, aud: AUDIENCE }),
      issuer.token({ sub: "someone@example.test", aud: DELETION_AUDIENCE }),
      issuer.forged({ sub: SIGN_IN_SERVICE, aud: DELETION_AUDIENCE }),
      undefined,
    ])
      expect((await request(token, "POST", "/users/deleted", { issuer: issuer.url, subject: ada.subject })).status).toBe(401);
    expect(await userRow(ada.subject)).toMatchObject({ deleted_at: null });
    expect((await request(ada.token, "GET", "/me")).status).toBe(200);
    const service = issuer.token({ sub: SIGN_IN_SERVICE, aud: DELETION_AUDIENCE });
    for (const body of [{}, { issuer: issuer.url }, { subject: ada.subject }, { issuer: issuer.url, subject: "with space" }])
      expect((await request(service, "POST", "/users/deleted", body)).status).toBe(400);
  });
});
