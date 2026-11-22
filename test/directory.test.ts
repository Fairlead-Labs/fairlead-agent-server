import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "../src/migrations.js";
import { createDirectory, DirectoryError, type Directory } from "../src/directory/index.js";

/** Requirement 0003 (D1–D9): the directory on real Postgres semantics (PGlite). */

let db: PGlite;
let at = new Date("2026-11-16T12:00:00.000Z");
let directory: Directory;
const later = (hours: number) => new Date(at.getTime() + hours * 3_600_000);

beforeAll(async () => {
  db = new PGlite();
  await migrateDatabase(db);
  directory = createDirectory(db, { now: () => at });
});

const user = (email: string | null = `${randomUUID()}@example.test`) => directory.signIn({ issuer: "https://id.example.test", subject: randomUUID(), email });
const refused = (code: DirectoryError["code"]) => expect.objectContaining({ name: "DirectoryError", code });

describe("the directory (requirement 0003)", () => {
  it("D1: a user is one issuer and subject, its email following the token's", async () => {
    const subject = randomUUID();
    const first = await directory.signIn({ issuer: "https://id.example.test", subject, email: "ada@example.test" });
    const again = await directory.signIn({ issuer: "https://id.example.test", subject, email: "ada@new.example.test" });
    expect(again).toMatchObject({ id: first.id, email: "ada@new.example.test" });
    expect((await directory.signIn({ issuer: "https://other.example.test", subject, email: "ada@example.test" })).id).not.toBe(first.id);
  });

  it("D2, D3: creating a team makes its creator its admin; members and a user's teams are listed, never another team's", async () => {
    const [ada, bob] = [await user(), await user()];
    const team = await directory.createTeam(ada.id, "  Finance  ");
    const other = await directory.createTeam(bob.id, "Sales");
    expect(team.name).toBe("Finance");
    expect(await directory.members(team.id)).toEqual([expect.objectContaining({ userId: ada.id, role: "admin", email: ada.email })]);
    expect(await directory.teamsOf(ada.id)).toEqual([expect.objectContaining({ id: team.id, name: "Finance", role: "admin" })]);
    expect((await directory.members(other.id)).map((member) => member.userId)).toEqual([bob.id]);
    await directory.renameTeam(team.id, "Finance EU");
    expect((await directory.teamsOf(ada.id))[0]!.name).toBe("Finance EU");
    for (const name of ["", "   ", "x".repeat(101)]) await expect(directory.createTeam(ada.id, name)).rejects.toEqual(refused("invalid"));
    await expect(directory.renameTeam(team.id, "")).rejects.toEqual(refused("invalid"));
    await expect(directory.renameTeam(randomUUID(), "Gone")).rejects.toEqual(refused("not-found"));
    expect(await directory.teamsOf(ada.id)).toHaveLength(1);
  });

  it("D4, D7: roles change and members go, but a team keeps an admin; adding a member twice changes nothing", async () => {
    const [ada, bob] = [await user(), await user()];
    const team = await directory.createTeam(ada.id, "Ops");
    await directory.addMember(team.id, bob.id, "member");
    await directory.addMember(team.id, bob.id, "admin");
    expect(await directory.roleOf(team.id, bob.id)).toBe("member");
    await expect(directory.setRole(team.id, ada.id, "member")).rejects.toEqual(refused("last-admin"));
    await expect(directory.removeMember(team.id, ada.id)).rejects.toEqual(refused("last-admin"));
    expect(await directory.roleOf(team.id, ada.id)).toBe("admin");
    await directory.setRole(team.id, bob.id, "admin");
    await directory.setRole(team.id, ada.id, "member");
    await directory.removeMember(team.id, ada.id);
    expect(await directory.roleOf(team.id, ada.id)).toBeUndefined();
    expect(await directory.teamsOf(ada.id)).toEqual([]);
    await expect(directory.removeMember(team.id, bob.id)).rejects.toEqual(refused("last-admin"));
    await expect(directory.setRole(team.id, ada.id, "admin")).rejects.toEqual(refused("not-found"));
    await expect(directory.addMember(randomUUID(), bob.id, "member")).rejects.toEqual(refused("not-found"));
  });

  it("D5: an invitation is accepted once, by the user whose email matches; another email, a revoked or an expired one joins nobody", async () => {
    at = new Date("2026-11-16T12:00:00.000Z");
    const [ada, bob, eve] = [await user(), await user("Bob@Example.test"), await user("eve@example.test")];
    const noEmail = await user(null);
    const team = await directory.createTeam(ada.id, "Legal");
    const invitation = await directory.invite(team.id, { email: "bob@example.TEST", role: "member", expiresAt: later(24) });
    expect(await directory.invitations(team.id)).toEqual([expect.objectContaining({ id: invitation.id, email: "bob@example.test", role: "member" })]);
    await expect(directory.acceptInvitation(invitation.id, eve.id)).rejects.toEqual(refused("not-found"));
    await expect(directory.acceptInvitation(invitation.id, noEmail.id)).rejects.toEqual(refused("not-found"));
    await directory.acceptInvitation(invitation.id, bob.id);
    expect(await directory.roleOf(team.id, bob.id)).toBe("member");
    await expect(directory.acceptInvitation(invitation.id, bob.id)).rejects.toEqual(refused("not-found"));
    expect(await directory.invitations(team.id)).toEqual([]);

    const revoked = await directory.invite(team.id, { email: "eve@example.test", role: "admin", expiresAt: later(24) });
    await directory.revokeInvitation(team.id, revoked.id);
    await expect(directory.acceptInvitation(revoked.id, eve.id)).rejects.toEqual(refused("not-found"));
    const expiring = await directory.invite(team.id, { email: "eve@example.test", role: "admin", expiresAt: later(1) });
    at = later(1);
    await expect(directory.acceptInvitation(expiring.id, eve.id)).rejects.toEqual(refused("not-found"));
    expect(await directory.roleOf(team.id, eve.id)).toBeUndefined();
    // Another team's admin cannot revoke it by its id.
    const other = await directory.createTeam(eve.id, "Other");
    await expect(directory.revokeInvitation(other.id, expiring.id)).rejects.toEqual(refused("not-found"));
    await expect(directory.invite(team.id, { email: "not an email", role: "member", expiresAt: later(24) })).rejects.toEqual(refused("invalid"));
  });

  it("D6, D7: a join code is shown once, stored hashed, and joins with its role until spent, expired or revoked", async () => {
    at = new Date("2026-11-16T12:00:00.000Z");
    const [ada, bob, cy, dee] = [await user(), await user(), await user(), await user()];
    const team = await directory.createTeam(ada.id, "Support");
    const { code, record } = await directory.createJoinCode(team.id, { role: "member", expiresAt: later(24), uses: 2 });
    expect(code).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    const stored = await db.query<{ code_hash: string }>("SELECT code_hash FROM directory.join_codes WHERE id = $1", [record.id]);
    expect(stored.rows[0]!.code_hash).not.toContain(code);
    expect(JSON.stringify(await directory.joinCodes(team.id))).not.toContain(code);

    await expect(directory.join(`${code}x`, bob.id)).rejects.toEqual(refused("not-found"));
    await directory.join(code, bob.id);
    await directory.join(code, bob.id);
    expect(await directory.roleOf(team.id, bob.id)).toBe("member");
    expect((await directory.joinCodes(team.id))[0]!.usesLeft).toBe(1);
    await directory.join(code, cy.id);
    await expect(directory.join(code, dee.id)).rejects.toEqual(refused("not-found"));

    const admins = await directory.createJoinCode(team.id, { role: "admin", expiresAt: later(1), uses: 5 });
    // A member stays a member: a code admits, it does not promote.
    await directory.join(admins.code, bob.id);
    expect(await directory.roleOf(team.id, bob.id)).toBe("member");
    await directory.revokeJoinCode(team.id, admins.record.id);
    await expect(directory.join(admins.code, dee.id)).rejects.toEqual(refused("not-found"));
    const short = await directory.createJoinCode(team.id, { role: "member", expiresAt: later(1), uses: 5 });
    at = later(1);
    await expect(directory.join(short.code, dee.id)).rejects.toEqual(refused("not-found"));
    expect(await directory.roleOf(team.id, dee.id)).toBeUndefined();
    for (const uses of [0, -1, 1.5, 10_001]) await expect(directory.createJoinCode(team.id, { role: "member", expiresAt: later(24), uses })).rejects.toEqual(refused("invalid"));
  });

  it("D8: removing a team removes its members, invitations and codes, and nobody else's", async () => {
    at = new Date("2026-11-16T12:00:00.000Z");
    const ada = await user();
    const [gone, kept] = [await directory.createTeam(ada.id, "Gone"), await directory.createTeam(ada.id, "Kept")];
    const invitation = await directory.invite(gone.id, { email: "x@example.test", role: "member", expiresAt: later(24) });
    const { code } = await directory.createJoinCode(gone.id, { role: "member", expiresAt: later(24), uses: 1 });
    await directory.removeTeam(gone.id);
    expect((await directory.teamsOf(ada.id)).map((team) => team.id)).toEqual([kept.id]);
    await expect(directory.join(code, (await user()).id)).rejects.toEqual(refused("not-found"));
    await expect(directory.acceptInvitation(invitation.id, (await user("x@example.test")).id)).rejects.toEqual(refused("not-found"));
    await expect(directory.removeTeam(gone.id)).rejects.toEqual(refused("not-found"));
  });

  it("D9: the tables are in the schema `directory` with its own ledger, and nowhere else", async () => {
    const { rows } = await db.query<{ table_schema: string; table_name: string }>("SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema = 'directory' ORDER BY table_name");
    expect(rows.map((row) => `${row.table_schema}.${row.table_name}`)).toEqual(["directory.invitations", "directory.join_codes", "directory.members", "directory.schema_migrations", "directory.teams", "directory.users"]);
    // The directory's columns name no server table: nothing in it refers outside the schema.
    const { rows: refs } = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM information_schema.referential_constraints r JOIN information_schema.table_constraints t ON t.constraint_name = r.unique_constraint_name WHERE r.constraint_schema = 'directory' AND t.table_schema <> 'directory'",
    );
    expect(refs[0]!.n).toBe(0);
  });

  it("D13: a user's personal space is a team of kind personal, made once, with them its only admin; nobody joins it. Negative: invitations, codes, new members and role changes are refused", async () => {
    const [ada, bob] = [await user(), await user()];
    const space = await directory.personalSpace(ada.id);
    expect(space).toMatchObject({ kind: "personal", name: "Personal" });
    expect((await directory.personalSpace(ada.id)).id).toBe(space.id);
    expect((await directory.personalSpace(bob.id)).id).not.toBe(space.id);
    expect(await directory.members(space.id)).toEqual([expect.objectContaining({ userId: ada.id, role: "admin" })]);
    expect(await directory.findTeam(space.id)).toMatchObject({ kind: "personal" });
    expect((await directory.teamsOf(ada.id)).find((team) => team.id === space.id)).toMatchObject({ kind: "personal" });
    await expect(directory.invite(space.id, { email: "x@example.test", role: "member", expiresAt: later(24) })).rejects.toEqual(refused("invalid"));
    await expect(directory.createJoinCode(space.id, { role: "member", expiresAt: later(24), uses: 1 })).rejects.toEqual(refused("invalid"));
    await expect(directory.addMember(space.id, bob.id, "member")).rejects.toEqual(refused("invalid"));
    await expect(directory.setRole(space.id, ada.id, "member")).rejects.toEqual(refused("invalid"));
    await expect(directory.removeMember(space.id, ada.id)).rejects.toEqual(refused("invalid"));
  });
});
