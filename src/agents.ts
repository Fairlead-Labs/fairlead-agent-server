import { inTeam, type SqlDatabase, type TransactionalSqlDatabase } from "./db/sql-database.js";
import type { TeamScoped } from "./db/team-scoped.js";
import type { Effort, ModelTarget } from "./model/index.js";
import type { Profile, ProfileSettings } from "./profiles.js";

/**
 * A space's agents and model profiles (requirements 0001 and 0004): each
 * agent lives in exactly one space (a team, or a user's personal space)
 * and works only there. A team agent has no owner and uses the team's
 * profiles; a personal agent has its user as owner and uses the team's
 * profiles or that user's own. Per team, under row-level security.
 */

/** Each limit `null` for *None* (requirement 0001, *Limits*). The 15-minute slice is the server's own and not here. */
export interface RunLimits {
  steps: number | null;
  inputTokens: number | null;
  /** Runs one piece of work may take before the owners are asked to allow more. */
  runsPerTrigger: number | null;
}

/** A new agent's limits: 30 steps and 300,000 input tokens per run, 10 runs per piece of work. */
export const DEFAULT_LIMITS: RunLimits = { steps: 30, inputTokens: 300_000, runsPerTrigger: 10 };
/** A new agent's cap of active sessions, and the range it may be set in. */
export const DEFAULT_MAX_ACTIVE_SESSIONS = 3;
export const MAX_ACTIVE_SESSIONS_RANGE: [number, number] = [1, 100];
export const LIMIT_RANGES: Record<keyof RunLimits, [number, number]> = { steps: [1, 500], inputTokens: [1_000, 10_000_000], runsPerTrigger: [1, 100] };

export interface Agent {
  id: string;
  teamId: string;
  name: string;
  description: string;
  /** The user a personal agent belongs to; null for a team agent. */
  ownerUserId: string | null;
  profileId: string | null;
  /** *Ask the owners*, on by default. */
  askOwners: boolean;
  limits: RunLimits;
  /** Its owner's free-text instructions, up to 10,000 characters. */
  playbook: string | null;
  /** Owners of sessions nobody else names, by user id (empty = the whole team). */
  defaultOwnerUserIds: string[];
  timeZone: string;
  language: "en" | "de";
  paused: boolean;
  /** Sessions it may hold open at once (1–100, default 3); enforcement is a later step (requirement 0004). */
  maxActiveSessions: number;
  createdAt: string;
  updatedAt: string;
  removedAt: string | null;
  version: number;
}

export type AgentChanges = Partial<Pick<Agent, "name" | "description" | "profileId" | "askOwners" | "limits" | "playbook" | "defaultOwnerUserIds" | "timeZone" | "language" | "paused" | "maxActiveSessions" | "removedAt" | "updatedAt">>;
export type ProfileChanges = Partial<Pick<Profile, keyof ProfileSettings | "apiKey" | "updatedAt">>;

/** The agent's model, opened (an API key unsealed). */
export interface ModelChoice {
  target: ModelTarget;
  effort?: Effort;
  cacheTtl?: "5m" | "1h";
}

export interface TeamAgentStore {
  /** Live agents (not removed), oldest first. */
  listAgents(): Promise<Agent[]>;
  /** Removed ones too. */
  findAgent(id: string): Promise<Agent | undefined>;
  insertAgent(agent: Agent): Promise<void>;
  /** Compare-and-set on `version`. */
  updateAgent(id: string, version: number, changes: AgentChanges): Promise<Agent | undefined>;

  listProfiles(): Promise<Profile[]>;
  findProfile(id: string): Promise<Profile | undefined>;
  insertProfile(profile: Profile): Promise<void>;
  updateProfile(id: string, version: number, changes: ProfileChanges): Promise<Profile | undefined>;
  /** `in-use` while an agent names it. */
  deleteProfile(id: string): Promise<"deleted" | "in-use" | "not-found">;
}

export type AgentStore = TeamScoped<TeamAgentStore>;

/** Whether an agent may use a profile: any agent the team's, a personal agent also its owner's own; a team agent never a member's. */
export const mayUseProfile = (agent: Pick<Agent, "ownerUserId">, profile: Pick<Profile, "ownerUserId">) => profile.ownerUserId === null || agent.ownerUserId === profile.ownerUserId;

type Row = Record<string, unknown>;
const iso = (value: unknown) => (value === null || value === undefined ? null : new Date(value as string).toISOString());
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const code = (error: unknown) => (typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined);
const json = (value: unknown) => (value === null || value === undefined ? null : JSON.stringify(value));

const AGENT_COLUMNS =
  "id, team_id, name, description, owner_user_id, profile_id, ask_owners, limits, playbook, default_owner_user_ids, time_zone, language, paused, max_active_sessions, created_at, updated_at, removed_at, version";
const PROFILE_COLUMNS = "id, team_id, owner_user_id, doc, api_key, created_at, updated_at, version";

const agentOf = (row: Row): Agent => ({
  id: row["id"] as string,
  teamId: row["team_id"] as string,
  name: row["name"] as string,
  description: row["description"] as string,
  ownerUserId: (row["owner_user_id"] as string | null) ?? null,
  profileId: (row["profile_id"] as string | null) ?? null,
  askOwners: row["ask_owners"] as boolean,
  limits: row["limits"] as RunLimits,
  playbook: (row["playbook"] as string | null) ?? null,
  defaultOwnerUserIds: [...(row["default_owner_user_ids"] as string[])],
  timeZone: row["time_zone"] as string,
  language: row["language"] as Agent["language"],
  paused: row["paused"] as boolean,
  maxActiveSessions: Number(row["max_active_sessions"]),
  createdAt: iso(row["created_at"])!,
  updatedAt: iso(row["updated_at"])!,
  removedAt: iso(row["removed_at"]),
  version: Number(row["version"]),
});

const settingsOf = (profile: ProfileSettings): ProfileSettings => {
  const { name, provider, model, effort, cacheWindow, region, project, roleArn, endpoint, tenantId, clientId } = profile;
  return { name, provider, model, effort, cacheWindow, region, project, roleArn, endpoint, tenantId, clientId };
};
const profileOf = (row: Row): Profile => ({
  ...settingsOf(row["doc"] as ProfileSettings),
  id: row["id"] as string,
  teamId: row["team_id"] as string,
  ownerUserId: (row["owner_user_id"] as string | null) ?? null,
  apiKey: (row["api_key"] as Profile["apiKey"]) ?? null,
  createdAt: iso(row["created_at"])!,
  updatedAt: iso(row["updated_at"])!,
  version: Number(row["version"]),
});

const AGENT_FIELDS: Record<keyof AgentChanges, [string, (value: unknown) => unknown]> = {
  name: ["name", (v) => v],
  description: ["description", (v) => v],
  profileId: ["profile_id", (v) => v],
  askOwners: ["ask_owners", (v) => v],
  limits: ["limits", json],
  playbook: ["playbook", (v) => v],
  defaultOwnerUserIds: ["default_owner_user_ids", (v) => v],
  timeZone: ["time_zone", (v) => v],
  language: ["language", (v) => v],
  paused: ["paused", (v) => v],
  maxActiveSessions: ["max_active_sessions", (v) => v],
  removedAt: ["removed_at", (v) => v],
  updatedAt: ["updated_at", (v) => v],
};

/** A profile named by an agent that is not the space's (another team's, or not there). */
export class UnknownProfileError extends Error {
  constructor() {
    super("Unknown profile");
    this.name = "UnknownProfileError";
  }
}

class PostgresTeamAgents implements TeamAgentStore {
  constructor(
    private readonly db: TransactionalSqlDatabase,
    private readonly teamId: string,
  ) {}

  private tx<T>(work: (tx: SqlDatabase) => Promise<T>) {
    return inTeam(this.db, this.teamId, work);
  }

  async listAgents() {
    const { rows } = await this.tx((tx) => tx.query<Row>(`SELECT ${AGENT_COLUMNS} FROM agents WHERE team_id = $1 AND removed_at IS NULL ORDER BY created_at, id`, [this.teamId]));
    return rows.map(agentOf);
  }

  async findAgent(id: string) {
    if (!UUID.test(id)) return undefined;
    const { rows } = await this.tx((tx) => tx.query<Row>(`SELECT ${AGENT_COLUMNS} FROM agents WHERE team_id = $1 AND id = $2`, [this.teamId, id]));
    return rows[0] && agentOf(rows[0]);
  }

  async insertAgent(a: Agent) {
    try {
      await this.tx((tx) =>
        tx.query(`INSERT INTO agents (${AGENT_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`, [
          a.id,
          this.teamId,
          a.name,
          a.description,
          a.ownerUserId,
          a.profileId,
          a.askOwners,
          JSON.stringify(a.limits),
          a.playbook,
          a.defaultOwnerUserIds,
          a.timeZone,
          a.language,
          a.paused,
          a.maxActiveSessions,
          a.createdAt,
          a.updatedAt,
          a.removedAt,
          a.version,
        ]),
      );
    } catch (error) {
      if (code(error) === "23503") throw new UnknownProfileError();
      throw error;
    }
  }

  async updateAgent(id: string, version: number, changes: AgentChanges) {
    if (!UUID.test(id)) return undefined;
    const sets = ["version = version + 1"];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) continue;
      const [column, convert] = AGENT_FIELDS[key as keyof AgentChanges];
      values.push(convert(value));
      sets.push(`${column} = $${3 + values.length}`);
    }
    try {
      const { rows } = await this.tx((tx) => tx.query<Row>(`UPDATE agents SET ${sets.join(", ")} WHERE team_id = $1 AND id = $2 AND version = $3 RETURNING ${AGENT_COLUMNS}`, [this.teamId, id, version, ...values]));
      return rows[0] && agentOf(rows[0]);
    } catch (error) {
      if (code(error) === "23503") throw new UnknownProfileError();
      throw error;
    }
  }

  async listProfiles() {
    const { rows } = await this.tx((tx) => tx.query<Row>(`SELECT ${PROFILE_COLUMNS} FROM profiles WHERE team_id = $1 ORDER BY created_at, id`, [this.teamId]));
    return rows.map(profileOf);
  }

  async findProfile(id: string) {
    if (!UUID.test(id)) return undefined;
    const { rows } = await this.tx((tx) => tx.query<Row>(`SELECT ${PROFILE_COLUMNS} FROM profiles WHERE team_id = $1 AND id = $2`, [this.teamId, id]));
    return rows[0] && profileOf(rows[0]);
  }

  async insertProfile(p: Profile) {
    await this.tx((tx) =>
      tx.query(`INSERT INTO profiles (${PROFILE_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [
        p.id,
        this.teamId,
        p.ownerUserId,
        JSON.stringify(settingsOf(p)),
        json(p.apiKey),
        p.createdAt,
        p.updatedAt,
        p.version,
      ]),
    );
  }

  async updateProfile(id: string, version: number, changes: ProfileChanges) {
    if (!UUID.test(id)) return undefined;
    return this.tx(async (tx) => {
      const current = (await tx.query<Row>(`SELECT ${PROFILE_COLUMNS} FROM profiles WHERE team_id = $1 AND id = $2 AND version = $3 FOR UPDATE`, [this.teamId, id, version])).rows[0];
      if (!current) return undefined;
      const next = { ...profileOf(current), ...changes };
      const { rows } = await tx.query<Row>(
        `UPDATE profiles SET doc = $3, api_key = $4, updated_at = $5, version = version + 1 WHERE team_id = $1 AND id = $2 RETURNING ${PROFILE_COLUMNS}`,
        [this.teamId, id, JSON.stringify(settingsOf(next)), json(next.apiKey), next.updatedAt],
      );
      return profileOf(rows[0]!);
    });
  }

  async deleteProfile(id: string) {
    if (!UUID.test(id)) return "not-found" as const;
    try {
      const { rows } = await this.tx((tx) => tx.query("DELETE FROM profiles WHERE team_id = $1 AND id = $2 RETURNING id", [this.teamId, id]));
      return rows.length === 1 ? ("deleted" as const) : ("not-found" as const);
    } catch (error) {
      if (code(error) === "23503") return "in-use" as const;
      throw error;
    }
  }
}

export class PostgresAgentStore implements AgentStore {
  constructor(private readonly db: TransactionalSqlDatabase) {}
  forTeam(teamId: string): TeamAgentStore {
    if (teamId === "") throw new Error("A team id is required");
    return new PostgresTeamAgents(this.db, teamId);
  }
}
