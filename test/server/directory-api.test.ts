import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "../../src/migrations.js";
import { createDirectory } from "../../src/directory/index.js";
import { startFakeOidcIssuer, type FakeOidcIssuer } from "../../src/testing/index.js";
import { createDirectoryApp } from "../../src/server/directory-api.js";
import { createOidcVerifier } from "../../src/server/oidc.js";

/** Requirement 0003 (D10–D12): sign-in by an OIDC provider's token and the directory's API, over a real loopback issuer and PGlite. */

const AUDIENCE = "https://agents.example.test";
let issuer: FakeOidcIssuer;
let app: ReturnType<typeof createDirectoryApp>;
let closed: ReturnType<typeof createDirectoryApp>;

beforeAll(async () => {
  issuer = await startFakeOidcIssuer();
  const db = new PGlite();
  await migrateDatabase(db);
  const directory = createDirectory(db);
  const verify = createOidcVerifier({ issuer: issuer.url, audience: AUDIENCE, rolesClaim: "groups", adminRole: "agent-server-admin" });
  app = createDirectoryApp({ directory, verify, teamCreation: "users" });
  closed = createDirectoryApp({ directory, verify, teamCreation: "admins" });
});
afterAll(() => issuer.close());

interface Person {
  token: string;
  email: string;
}
const person = (claims: Record<string, unknown> = {}): Person => {
  const email = `${randomUUID()}@example.test`;
  return { email, token: issuer.token({ sub: randomUUID(), aud: AUDIENCE, email, email_verified: true, groups: [], ...claims }) };
};
const call = async (who: Person | string | undefined, method: string, path: string, body?: unknown, on = app) => {
  const token = typeof who === "string" ? who : who?.token;
  const response = await on.request(path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : undefined) as any };
};
const idOf = async (who: Person) => (await call(who, "GET", "/me")).body.user.id as string;

describe("sign-in (D10)", () => {
  it("a token of the issuer for this audience is its user; the admin role is read from the claim", async () => {
    const ada = person();
    const me = await call(ada, "GET", "/me");
    expect(me).toMatchObject({ status: 200, body: { user: { email: ada.email }, admin: false, mayCreateTeams: true, teams: [], invitations: [] } });
    expect((await call(ada, "GET", "/me")).body.user.id).toBe(me.body.user.id);
    expect((await call(person({ groups: ["agent-server-admin"] }), "GET", "/me")).body.admin).toBe(true);
    // An unverified email is not the user's email.
    expect((await call(person({ email_verified: false }), "GET", "/me")).body.user.email).toBeNull();
    expect(issuer.discoveries).toBe(1);
  });

  it("negative: no token, another audience or issuer, an expired or forged token, or one without a subject is 401", async () => {
    const claims = { sub: randomUUID(), aud: AUDIENCE, email: "x@example.test", email_verified: true };
    const past = Math.floor(Date.now() / 1000) - 7200;
    for (const token of [
      undefined,
      "not-a-token",
      issuer.token({ ...claims, aud: "https://elsewhere.example.test" }),
      issuer.token({ ...claims, iss: "https://other-issuer.example.test" }),
      issuer.token({ ...claims, iat: past, exp: past + 3600 }),
      issuer.forged(claims),
      issuer.token({ ...claims, sub: undefined }),
    ]) {
      expect(await call(token, "GET", "/me"), String(token).slice(0, 20)).toEqual({ status: 401, body: { error: "Invalid token" } });
    }
  });

  it("negative: the provider unreachable is 503, and nobody is let in", async () => {
    const down = await startFakeOidcIssuer();
    down.down = 500;
    const lone = createDirectoryApp({ directory: createDirectory(new PGlite()), verify: createOidcVerifier({ issuer: down.url, audience: AUDIENCE, rolesClaim: "groups", adminRole: "a" }), teamCreation: "users" });
    const response = await lone.request("/me", { headers: { Authorization: `Bearer ${down.token({ sub: "s", aud: AUDIENCE })}` } });
    expect(response.status).toBe(503);
    await down.close();
  });
});

describe("the directory's API (D11, D12)", () => {
  it("teams and members: a creator administers; a member reads; a stranger finds nothing", async () => {
    const [ada, bob, eve] = [person(), person(), person()];
    const team = (await call(ada, "POST", "/teams", { name: "Finance" })).body;
    expect(team).toMatchObject({ name: "Finance" });
    const base = `/teams/${team.id}`;
    expect((await call(ada, "GET", "/me")).body.teams).toEqual([expect.objectContaining({ id: team.id, role: "admin" })]);
    expect(await call(ada, "POST", `${base}/members`, { userId: await idOf(bob), role: "member" })).toMatchObject({ status: 204 });
    expect((await call(bob, "GET", `${base}/members`)).body.members.map((member: any) => member.role)).toEqual(["admin", "member"]);

    // A stranger: 404 everywhere, the team's existence not confirmed.
    for (const [method, path, body] of [
      ["GET", `${base}/members`],
      ["PATCH", base, { name: "Mine" }],
      ["DELETE", base],
      ["POST", `${base}/members`, { userId: await idOf(eve), role: "admin" }],
      ["GET", `${base}/invitations`],
      ["POST", `${base}/invitations`, { email: eve.email, role: "admin" }],
      ["GET", `${base}/join-codes`],
      ["POST", `${base}/join-codes`, { role: "admin" }],
    ] as const) {
      expect(await call(eve, method, path, body), `${method} ${path}`).toEqual({ status: 404, body: { error: "Team not found" } });
    }
    // A member who is no admin: reads the members, 403 for every write and for invitations and codes.
    for (const [method, path, body] of [
      ["PATCH", base, { name: "Mine" }],
      ["DELETE", base],
      ["POST", `${base}/members`, { userId: await idOf(eve), role: "member" }],
      ["PATCH", `${base}/members/${await idOf(bob)}`, { role: "admin" }],
      ["DELETE", `${base}/members/${await idOf(ada)}`],
      ["GET", `${base}/invitations`],
      ["POST", `${base}/invitations`, { email: eve.email, role: "member" }],
      ["GET", `${base}/join-codes`],
      ["POST", `${base}/join-codes`, { role: "member" }],
    ] as const) {
      expect(await call(bob, method, path, body), `${method} ${path}`).toEqual({ status: 403, body: { error: "Team admin required" } });
    }
    expect((await call(ada, "GET", `${base}/members`)).body.members).toHaveLength(2);

    expect((await call(ada, "PATCH", base, { name: "Finance EU" })).status).toBe(204);
    expect(await call(ada, "PATCH", `${base}/members/${await idOf(ada)}`, { role: "member" })).toEqual({ status: 409, body: { error: "A team keeps an admin" } });
    expect((await call(ada, "PATCH", `${base}/members/${await idOf(bob)}`, { role: "admin" })).status).toBe(204);
    // Anyone may leave; the last admin may not.
    expect((await call(ada, "DELETE", `${base}/members/${await idOf(ada)}`)).status).toBe(204);
    expect((await call(bob, "DELETE", `${base}/members/${await idOf(bob)}`)).status).toBe(409);
    expect((await call(ada, "GET", `${base}/members`)).status).toBe(404);
    for (const body of [undefined, {}, { name: 5 }, { name: "" }]) expect((await call(bob, "POST", "/teams", body)).status, JSON.stringify(body)).toBe(400);
    expect((await call(bob, "POST", `${base}/members`, { userId: await idOf(eve), role: "owner" })).status).toBe(400);
  });

  it("invitations: made by an admin, seen by the invited in /me, accepted once by them only", async () => {
    const [ada, bob, eve] = [person(), person(), person()];
    const base = `/teams/${(await call(ada, "POST", "/teams", { name: "Legal" })).body.id}`;
    const invitation = (await call(ada, "POST", `${base}/invitations`, { email: bob.email.toUpperCase(), role: "member" })).body;
    expect((await call(ada, "GET", `${base}/invitations`)).body.invitations).toEqual([expect.objectContaining({ id: invitation.id, email: bob.email })]);
    expect((await call(bob, "GET", "/me")).body.invitations).toEqual([expect.objectContaining({ id: invitation.id, teamName: "Legal", role: "member" })]);
    expect((await call(eve, "GET", "/me")).body.invitations).toEqual([]);
    expect(await call(eve, "POST", `/invitations/${invitation.id}/accept`)).toEqual({ status: 404, body: { error: "Invitation not found" } });
    expect((await call(bob, "POST", `/invitations/${invitation.id}/accept`)).status).toBe(204);
    expect((await call(bob, "POST", `/invitations/${invitation.id}/accept`)).status).toBe(404);
    expect((await call(bob, "GET", `${base}/members`)).status).toBe(200);
    const second = (await call(ada, "POST", `${base}/invitations`, { email: eve.email, role: "admin" })).body;
    expect((await call(ada, "DELETE", `${base}/invitations/${second.id}`)).status).toBe(204);
    expect((await call(eve, "POST", `/invitations/${second.id}/accept`)).status).toBe(404);
    expect((await call(ada, "POST", `${base}/invitations`, { email: "nope", role: "member" })).status).toBe(400);
  });

  it("join codes: shown once, joining with their role; a wrong or revoked code joins nobody", async () => {
    const [ada, bob, eve] = [person(), person(), person()];
    const base = `/teams/${(await call(ada, "POST", "/teams", { name: "Support" })).body.id}`;
    const made = (await call(ada, "POST", `${base}/join-codes`, { role: "member", uses: 1 })).body;
    expect(made.code).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    const listed = await call(ada, "GET", `${base}/join-codes`);
    expect(listed.body.joinCodes).toEqual([expect.objectContaining({ id: made.id, role: "member", usesLeft: 1 })]);
    expect(JSON.stringify(listed.body)).not.toContain(made.code);
    expect(await call(bob, "POST", "/join", { code: `${made.code}x` })).toEqual({ status: 404, body: { error: "Code not found" } });
    expect((await call(bob, "POST", "/join", { code: made.code })).status).toBe(204);
    expect((await call(eve, "POST", "/join", { code: made.code })).status).toBe(404);
    const more = (await call(ada, "POST", `${base}/join-codes`, { role: "admin" })).body;
    expect((await call(ada, "DELETE", `${base}/join-codes/${more.id}`)).status).toBe(204);
    expect((await call(eve, "POST", "/join", { code: more.code })).status).toBe(404);
    for (const body of [{ role: "member", uses: 0 }, { role: "member", expiresInHours: 100_000 }, { role: "root" }]) expect((await call(ada, "POST", `${base}/join-codes`, body)).status, JSON.stringify(body)).toBe(400);
  });

  it("team creation closed to users: 403 for a user, allowed for an installation admin (D11)", async () => {
    const [ada, root] = [person(), person({ groups: ["agent-server-admin"] })];
    expect((await call(ada, "GET", "/me", undefined, closed)).body.mayCreateTeams).toBe(false);
    expect(await call(ada, "POST", "/teams", { name: "Mine" }, closed)).toEqual({ status: 403, body: { error: "Team creation is closed" } });
    expect((await call(root, "POST", "/teams", { name: "Theirs" }, closed)).status).toBe(201);
  });

  it("D12: an installation admin lists and removes any team and is a member of none; a user lists none", async () => {
    const [ada, root] = [person(), person({ groups: ["agent-server-admin"] })];
    const team = (await call(ada, "POST", "/teams", { name: "Watched" })).body;
    expect(await call(ada, "GET", "/teams")).toEqual({ status: 403, body: { error: "Installation admin required" } });
    expect((await call(root, "GET", "/teams")).body.teams).toContainEqual(expect.objectContaining({ id: team.id, name: "Watched" }));
    expect((await call(root, "GET", `/teams/${team.id}/members`)).status).toBe(404);
    expect((await call(root, "PATCH", `/teams/${team.id}`, { name: "Taken" })).status).toBe(404);
    expect((await call(root, "DELETE", `/teams/${team.id}`)).status).toBe(204);
    expect((await call(ada, "GET", "/me")).body.teams).toEqual([]);
  });
});
