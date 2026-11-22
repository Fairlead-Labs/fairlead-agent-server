import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SqlDatabase, TransactionalSqlDatabase } from "../db/sql-database.js";

/**
 * The directory (requirement 0003): users, teams, members,
 * invitations and join codes, in the Postgres schema `directory`, which
 * another product on the same database may share. Nothing product-specific
 * lives here, and this repository alone changes these tables.
 *
 * Unlike every other store it is not reached through `forTeam`: it is what
 * says who is in which team. Every call names its team or its user.
 */



export type TeamRole = "admin" | "member";
export interface DirectoryUser {
  id: string;
  issuer: string;
  subject: string;
  /** The verified email its last token carried, lower case; null when it carried none. */
  email: string | null;
}
export interface DirectoryTeam {
  id: string;
  name: string;
  /** `personal`: a user's personal space, a team of one that nobody joins (requirement 0004, *Spaces and agents*). */
  kind: "team" | "personal";
  createdAt: string;
}
export interface DirectoryMember {
  userId: string;
  email: string | null;
  role: TeamRole;
  joinedAt: string;
}
export interface Invitation {
  id: string;
  teamId: string;
  email: string;
  role: TeamRole;
  expiresAt: string;
}
export interface JoinCode {
  id: string;
  teamId: string;
  role: TeamRole;
  expiresAt: string;
  usesLeft: number;
}

/** `invalid`: the input; `not-found`: no such thing for this caller, never saying which part; `last-admin`: a team keeps one. */
export class DirectoryError extends Error {
  constructor(readonly code: "invalid" | "not-found" | "last-admin") {
    super(`Directory: ${code}`);
    this.name = "DirectoryError";
  }
}

export interface Directory {
  /** The user of this issuer and subject, made at first sight. `email` only when the token verified it. */
  signIn(identity: { issuer: string; subject: string; email: string | null }): Promise<DirectoryUser>;
  createTeam(userId: string, name: string): Promise<DirectoryTeam>;
  /** The user's personal space, made at its first use with the user its one member (an admin). */
  personalSpace(userId: string): Promise<DirectoryTeam>;
  renameTeam(teamId: string, name: string): Promise<void>;
  removeTeam(teamId: string): Promise<void>;
  teamsOf(userId: string): Promise<(DirectoryTeam & { role: TeamRole })[]>;
  /** Every team, for an installation admin: names only, nothing of their members. */
  allTeams(): Promise<DirectoryTeam[]>;
  findTeam(teamId: string): Promise<DirectoryTeam | undefined>;
  members(teamId: string): Promise<DirectoryMember[]>;
  roleOf(teamId: string, userId: string): Promise<TeamRole | undefined>;
  /** Adds a known user; one who is a member already stays as they are. */
  addMember(teamId: string, userId: string, role: TeamRole): Promise<void>;
  setRole(teamId: string, userId: string, role: TeamRole): Promise<void>;
  removeMember(teamId: string, userId: string): Promise<void>;
  invite(teamId: string, invitation: { email: string; role: TeamRole; expiresAt: Date }): Promise<Invitation>;
  invitations(teamId: string): Promise<Invitation[]>;
  /** The open invitations for a verified email, with their teams' names. */
  invitationsFor(email: string): Promise<(Invitation & { teamName: string })[]>;
  revokeInvitation(teamId: string, id: string): Promise<void>;
  acceptInvitation(id: string, userId: string): Promise<void>;
  /** `code` is shown here once; only its hash is kept. */
  createJoinCode(teamId: string, options: { role: TeamRole; expiresAt: Date; uses: number }): Promise<{ code: string; record: JoinCode }>;
  joinCodes(teamId: string): Promise<JoinCode[]>;
  revokeJoinCode(teamId: string, id: string): Promise<void>;
  join(code: string, userId: string): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;
const iso = (value: Date | string) => new Date(value).toISOString();
const hashOf = (code: string) => createHash("sha256").update(code).digest("hex");
const teamName = (name: string) => {
  const trimmed = name.trim();
  if (trimmed.length < 1 || [...trimmed].length > 100) throw new DirectoryError("invalid");
  return trimmed;
};
/** An id that cannot be one finds nothing, as an unknown one does (and never reaches a uuid cast). */
const known = (...ids: string[]) => {
  if (!ids.every((id) => UUID.test(id))) throw new DirectoryError("not-found");
};
const found = (rows: unknown[]) => {
  if (rows.length === 0) throw new DirectoryError("not-found");
};

export function createDirectory(db: TransactionalSqlDatabase, { now = () => new Date() }: { now?: () => Date } = {}): Directory {
  /** The team's row locked for the transaction, so two changes to its admins cannot both pass the last-admin check. */
  /** Also refuses a personal space, whose one member never changes. */
  const lockTeam = async (tx: SqlDatabase, teamId: string) => {
    const { rows } = await tx.query<{ kind: string }>("SELECT kind FROM directory.teams WHERE id = $1 FOR UPDATE", [teamId]);
    found(rows);
    if (rows[0]!.kind === "personal") throw new DirectoryError("invalid");
  };
  const insertMember = (tx: SqlDatabase, teamId: string, userId: string, role: TeamRole) =>
    tx.query("INSERT INTO directory.members (team_id, user_id, role, joined_at) VALUES ($1, $2, $3, $4) ON CONFLICT (team_id, user_id) DO NOTHING", [teamId, userId, role, now()]);
  /** Refuses when `userId` is the team's only admin; answers its role. */
  const mayLoseAdmin = async (tx: SqlDatabase, teamId: string, userId: string) => {
    await lockTeam(tx, teamId);
    const { rows } = await tx.query<{ user_id: string; role: TeamRole }>("SELECT user_id, role FROM directory.members WHERE team_id = $1 AND (user_id = $2 OR role = 'admin')", [teamId, userId]);
    const self = rows.find((row) => row.user_id === userId);
    if (!self) throw new DirectoryError("not-found");
    if (self.role === "admin" && rows.filter((row) => row.role === "admin").length === 1) throw new DirectoryError("last-admin");
  };

  return {
    async signIn({ issuer, subject, email }) {
      if (!issuer || !subject) throw new DirectoryError("invalid");
      const { rows } = await db.query<{ id: string; email: string | null }>(
        `INSERT INTO directory.users (id, issuer, subject, email, created_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (issuer, subject) DO UPDATE SET email = EXCLUDED.email RETURNING id, email`,
        [randomUUID(), issuer, subject, email?.toLowerCase() ?? null, now()],
      );
      return { id: rows[0]!.id, issuer, subject, email: rows[0]!.email };
    },

    async createTeam(userId, name) {
      known(userId);
      const team = { id: randomUUID(), name: teamName(name), kind: "team" as const, createdAt: iso(now()) };
      return db.transaction(async (tx) => {
        await tx.query("INSERT INTO directory.teams (id, name, created_at) VALUES ($1, $2, $3)", [team.id, team.name, team.createdAt]);
        await insertMember(tx, team.id, userId, "admin");
        return team;
      });
    },

    async personalSpace(userId) {
      known(userId);
      return db.transaction(async (tx) => {
        found((await tx.query("SELECT id FROM directory.users WHERE id = $1", [userId])).rows);
        const id = randomUUID();
        const made = await tx.query("INSERT INTO directory.teams (id, name, kind, personal_user_id, created_at) VALUES ($1, 'Personal', 'personal', $2, $3) ON CONFLICT (personal_user_id) DO NOTHING RETURNING id", [id, userId, now()]);
        if (made.rows.length === 1) await tx.query("INSERT INTO directory.members (team_id, user_id, role, joined_at) VALUES ($1, $2, 'admin', $3)", [id, userId, now()]);
        const { rows } = await tx.query<{ id: string; name: string; created_at: Date }>("SELECT id, name, created_at FROM directory.teams WHERE personal_user_id = $1", [userId]);
        return { id: rows[0]!.id, name: rows[0]!.name, kind: "personal" as const, createdAt: iso(rows[0]!.created_at) };
      });
    },

    async renameTeam(teamId, name) {
      known(teamId);
      found((await db.query("UPDATE directory.teams SET name = $2 WHERE id = $1 RETURNING id", [teamId, teamName(name)])).rows);
    },

    async removeTeam(teamId) {
      known(teamId);
      found((await db.query("DELETE FROM directory.teams WHERE id = $1 RETURNING id", [teamId])).rows);
    },

    async teamsOf(userId) {
      known(userId);
      const { rows } = await db.query<{ id: string; name: string; kind: DirectoryTeam["kind"]; created_at: Date; role: TeamRole }>(
        "SELECT t.id, t.name, t.kind, t.created_at, m.role FROM directory.members m JOIN directory.teams t ON t.id = m.team_id WHERE m.user_id = $1 ORDER BY t.created_at, t.id",
        [userId],
      );
      return rows.map((row) => ({ id: row.id, name: row.name, kind: row.kind, createdAt: iso(row.created_at), role: row.role }));
    },

    async findTeam(teamId) {
      if (!UUID.test(teamId)) return undefined;
      const { rows } = await db.query<{ id: string; name: string; kind: DirectoryTeam["kind"]; created_at: Date }>("SELECT id, name, kind, created_at FROM directory.teams WHERE id = $1", [teamId]);
      return rows[0] && { id: rows[0].id, name: rows[0].name, kind: rows[0].kind, createdAt: iso(rows[0].created_at) };
    },

    async allTeams() {
      const { rows } = await db.query<{ id: string; name: string; kind: DirectoryTeam["kind"]; created_at: Date }>("SELECT id, name, kind, created_at FROM directory.teams ORDER BY created_at, id");
      return rows.map((row) => ({ id: row.id, name: row.name, kind: row.kind, createdAt: iso(row.created_at) }));
    },

    async members(teamId) {
      known(teamId);
      const { rows } = await db.query<{ user_id: string; email: string | null; role: TeamRole; joined_at: Date }>(
        "SELECT m.user_id, u.email, m.role, m.joined_at FROM directory.members m JOIN directory.users u ON u.id = m.user_id WHERE m.team_id = $1 ORDER BY m.joined_at, m.user_id",
        [teamId],
      );
      return rows.map((row) => ({ userId: row.user_id, email: row.email, role: row.role, joinedAt: iso(row.joined_at) }));
    },

    async roleOf(teamId, userId) {
      if (!UUID.test(teamId) || !UUID.test(userId)) return undefined;
      return (await db.query<{ role: TeamRole }>("SELECT role FROM directory.members WHERE team_id = $1 AND user_id = $2", [teamId, userId])).rows[0]?.role;
    },

    async addMember(teamId, userId, role) {
      known(teamId, userId);
      return db.transaction(async (tx) => {
        await lockTeam(tx, teamId);
        found((await tx.query("SELECT id FROM directory.users WHERE id = $1", [userId])).rows);
        await insertMember(tx, teamId, userId, role);
      });
    },

    async setRole(teamId, userId, role) {
      known(teamId, userId);
      return db.transaction(async (tx) => {
        if (role === "admin") await lockTeam(tx, teamId);
        else await mayLoseAdmin(tx, teamId, userId);
        found((await tx.query("UPDATE directory.members SET role = $3 WHERE team_id = $1 AND user_id = $2 RETURNING user_id", [teamId, userId, role])).rows);
      });
    },

    async removeMember(teamId, userId) {
      known(teamId, userId);
      return db.transaction(async (tx) => {
        await mayLoseAdmin(tx, teamId, userId);
        await tx.query("DELETE FROM directory.members WHERE team_id = $1 AND user_id = $2", [teamId, userId]);
      });
    },

    async invite(teamId, { email, role, expiresAt }) {
      known(teamId);
      const address = email.trim().toLowerCase();
      if (!EMAIL.test(address)) throw new DirectoryError("invalid");
      const invitation = { id: randomUUID(), teamId, email: address, role, expiresAt: iso(expiresAt) };
      return db.transaction(async (tx) => {
        await lockTeam(tx, teamId);
        await tx.query("INSERT INTO directory.invitations (id, team_id, email, role, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)", [invitation.id, teamId, address, role, invitation.expiresAt, now()]);
        return invitation;
      });
    },

    async invitations(teamId) {
      known(teamId);
      const { rows } = await db.query<{ id: string; email: string; role: TeamRole; expires_at: Date }>("SELECT id, email, role, expires_at FROM directory.invitations WHERE team_id = $1 AND expires_at > $2 ORDER BY created_at, id", [teamId, now()]);
      return rows.map((row) => ({ id: row.id, teamId, email: row.email, role: row.role, expiresAt: iso(row.expires_at) }));
    },

    async invitationsFor(email) {
      const { rows } = await db.query<{ id: string; team_id: string; name: string; email: string; role: TeamRole; expires_at: Date }>(
        "SELECT i.id, i.team_id, t.name, i.email, i.role, i.expires_at FROM directory.invitations i JOIN directory.teams t ON t.id = i.team_id WHERE i.email = $1 AND i.expires_at > $2 ORDER BY i.created_at, i.id",
        [email.toLowerCase(), now()],
      );
      return rows.map((row) => ({ id: row.id, teamId: row.team_id, teamName: row.name, email: row.email, role: row.role, expiresAt: iso(row.expires_at) }));
    },

    async revokeInvitation(teamId, id) {
      known(teamId, id);
      found((await db.query("DELETE FROM directory.invitations WHERE team_id = $1 AND id = $2 RETURNING id", [teamId, id])).rows);
    },

    async acceptInvitation(id, userId) {
      known(id, userId);
      return db.transaction(async (tx) => {
        // Used up by the one statement that checks it: its email is the user's, and it has not expired.
        const { rows } = await tx.query<{ team_id: string; role: TeamRole }>(
          `DELETE FROM directory.invitations i USING directory.users u
           WHERE i.id = $1 AND u.id = $2 AND u.email = i.email AND i.expires_at > $3 RETURNING i.team_id, i.role`,
          [id, userId, now()],
        );
        found(rows);
        await insertMember(tx, rows[0]!.team_id, userId, rows[0]!.role);
      });
    },

    async createJoinCode(teamId, { role, expiresAt, uses }) {
      known(teamId);
      if (!Number.isInteger(uses) || uses < 1 || uses > 10_000) throw new DirectoryError("invalid");
      const code = randomBytes(24).toString("base64url");
      const record = { id: randomUUID(), teamId, role, expiresAt: iso(expiresAt), usesLeft: uses };
      return db.transaction(async (tx) => {
        await lockTeam(tx, teamId);
        await tx.query("INSERT INTO directory.join_codes (id, team_id, code_hash, role, expires_at, uses_left, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)", [record.id, teamId, hashOf(code), role, record.expiresAt, uses, now()]);
        return { code, record };
      });
    },

    async joinCodes(teamId) {
      known(teamId);
      const { rows } = await db.query<{ id: string; role: TeamRole; expires_at: Date; uses_left: number }>("SELECT id, role, expires_at, uses_left FROM directory.join_codes WHERE team_id = $1 AND expires_at > $2 AND uses_left > 0 ORDER BY created_at, id", [teamId, now()]);
      return rows.map((row) => ({ id: row.id, teamId, role: row.role, expiresAt: iso(row.expires_at), usesLeft: row.uses_left }));
    },

    async revokeJoinCode(teamId, id) {
      known(teamId, id);
      found((await db.query("DELETE FROM directory.join_codes WHERE team_id = $1 AND id = $2 RETURNING id", [teamId, id])).rows);
    },

    async join(code, userId) {
      known(userId);
      return db.transaction(async (tx) => {
        const { rows } = await tx.query<{ id: string; team_id: string; role: TeamRole }>("SELECT id, team_id, role FROM directory.join_codes WHERE code_hash = $1 AND expires_at > $2 AND uses_left > 0 FOR UPDATE", [hashOf(code), now()]);
        found(rows);
        const { id, team_id: teamId, role } = rows[0]!;
        // A member already: nothing changes and no use is spent.
        if ((await tx.query("SELECT 1 FROM directory.members WHERE team_id = $1 AND user_id = $2", [teamId, userId])).rows.length > 0) return;
        await tx.query("UPDATE directory.join_codes SET uses_left = uses_left - 1 WHERE id = $1", [id]);
        await insertMember(tx, teamId, userId, role);
      });
    },
  };
}
