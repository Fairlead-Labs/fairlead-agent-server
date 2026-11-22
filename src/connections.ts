import { inTeam, withSettings, type SqlDatabase, type TransactionalSqlDatabase } from "./db/sql-database.js";
import type { TeamScoped } from "./db/team-scoped.js";
import type { SealedValue } from "./keys.js";

/**
 * A team's own connections and its agents' credentials at them
 * (requirement 0004, *Connections*): an MCP service by address, and per
 * agent and service a credential made at the service, stored sealed
 * (`connection-credential`). An agent sees the tools of the services it
 * holds a credential for, plus the host's. Per team, under row-level
 * security; the one crossing is a pending OAuth sign-in read by its state.
 */

/** Lower case, as a tool name's prefix: `<name>__<tool>`. */
export const CONNECTION_NAME = /^[a-z][a-z0-9_]{0,19}$/;

export interface Connection {
  id: string;
  teamId: string;
  name: string;
  url: string;
  /** `key`: a key the service issued per agent; `oauth`: a person signs in at the service for the agent. */
  auth: "key" | "oauth";
  /** A client registered at the service's authorization server beforehand; null to use a client ID metadata document or registration. */
  oauthClient: { clientId: string; clientSecret: SealedValue | null } | null;
  /** The MCP revision the service answered with, once known. */
  revision: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

/** The opened `secret` of an OAuth credential: what renews its access token. */
export interface OAuthGrant {
  refreshToken: string | null;
  clientId: string;
  clientSecret: string | null;
  tokenEndpoint: string;
  issuer: string;
  resource: string;
}

export interface AgentCredential {
  teamId: string;
  agentId: string;
  connectionId: string;
  kind: "key" | "oauth";
  /** The key, or an `OAuthGrant` as JSON, sealed. */
  secret: SealedValue;
  /** An OAuth access token, sealed, with its expiry. */
  access: SealedValue | null;
  accessExpiresAt: string | null;
  scope: string | null;
  /** `needs-auth`: refused at the service or not renewable; a person signs in again. */
  state: "active" | "needs-auth";
  createdAt: string;
  updatedAt: string;
  version: number;
}

export type CredentialChanges = Partial<Pick<AgentCredential, "secret" | "access" | "accessExpiresAt" | "scope" | "state" | "updatedAt">>;

/** A sign-in begun at the service, until its callback: the PKCE verifier and where it goes, sealed. */
export interface PendingSignIn {
  state: string;
  teamId: string;
  agentId: string;
  connectionId: string;
  userId: string;
  flow: SealedValue;
  expiresAt: string;
}

export interface TeamConnectionStore {
  listConnections(): Promise<Connection[]>;
  findConnection(id: string): Promise<Connection | undefined>;
  /** `exists` when the name is taken in the team. */
  insertConnection(connection: Connection): Promise<"inserted" | "exists">;
  updateConnection(id: string, version: number, changes: Partial<Pick<Connection, "url" | "oauthClient" | "revision" | "updatedAt">>): Promise<Connection | undefined>;
  /** Its credentials and pending sign-ins go with it. */
  deleteConnection(id: string): Promise<boolean>;

  listCredentials(agentId?: string): Promise<AgentCredential[]>;
  findCredential(agentId: string, connectionId: string): Promise<AgentCredential | undefined>;
  /** Replaces the agent's credential at the connection. */
  putCredential(credential: AgentCredential): Promise<void>;
  updateCredential(agentId: string, connectionId: string, version: number, changes: CredentialChanges): Promise<AgentCredential | undefined>;
  deleteCredential(agentId: string, connectionId: string): Promise<boolean>;

  insertPending(pending: PendingSignIn): Promise<void>;
}

export interface ConnectionStore extends TeamScoped<TeamConnectionStore> {
  /** The pending sign-in of this state, across teams (the callback names no team), used up by the read; undefined when unknown or expired. */
  takePending(state: string, now: Date): Promise<PendingSignIn | undefined>;
}

type Row = Record<string, unknown>;
const iso = (value: unknown) => (value === null || value === undefined ? null : new Date(value as string).toISOString());
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const json = (value: unknown) => (value === null || value === undefined ? null : JSON.stringify(value));
const STATE = /^[A-Za-z0-9_-]{32,128}$/;

const CONNECTION_COLUMNS = "id, team_id, name, url, auth, oauth, revision, created_at, updated_at, version";
const CREDENTIAL_COLUMNS = "team_id, agent_id, connection_id, kind, secret, access, access_expires_at, scope, state, created_at, updated_at, version";

const connectionOf = (row: Row): Connection => ({
  id: row["id"] as string,
  teamId: row["team_id"] as string,
  name: row["name"] as string,
  url: row["url"] as string,
  auth: row["auth"] as Connection["auth"],
  oauthClient: (row["oauth"] as Connection["oauthClient"]) ?? null,
  revision: (row["revision"] as string | null) ?? null,
  createdAt: iso(row["created_at"])!,
  updatedAt: iso(row["updated_at"])!,
  version: Number(row["version"]),
});

const credentialOf = (row: Row): AgentCredential => ({
  teamId: row["team_id"] as string,
  agentId: row["agent_id"] as string,
  connectionId: row["connection_id"] as string,
  kind: row["kind"] as AgentCredential["kind"],
  secret: row["secret"] as SealedValue,
  access: (row["access"] as SealedValue | null) ?? null,
  accessExpiresAt: iso(row["access_expires_at"]),
  scope: (row["scope"] as string | null) ?? null,
  state: row["state"] as AgentCredential["state"],
  createdAt: iso(row["created_at"])!,
  updatedAt: iso(row["updated_at"])!,
  version: Number(row["version"]),
});

class PostgresTeamConnections implements TeamConnectionStore {
  constructor(
    private readonly db: TransactionalSqlDatabase,
    private readonly teamId: string,
  ) {}

  private tx<T>(work: (tx: SqlDatabase) => Promise<T>) {
    return inTeam(this.db, this.teamId, work);
  }

  async listConnections() {
    const { rows } = await this.tx((tx) => tx.query<Row>(`SELECT ${CONNECTION_COLUMNS} FROM connections WHERE team_id = $1 ORDER BY name`, [this.teamId]));
    return rows.map(connectionOf);
  }

  async findConnection(id: string) {
    if (!UUID.test(id)) return undefined;
    const { rows } = await this.tx((tx) => tx.query<Row>(`SELECT ${CONNECTION_COLUMNS} FROM connections WHERE team_id = $1 AND id = $2`, [this.teamId, id]));
    return rows[0] && connectionOf(rows[0]);
  }

  async insertConnection(c: Connection) {
    const { rows } = await this.tx((tx) =>
      tx.query(
        `INSERT INTO connections (${CONNECTION_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (team_id, name) DO NOTHING RETURNING id`,
        [c.id, this.teamId, c.name, c.url, c.auth, json(c.oauthClient), c.revision, c.createdAt, c.updatedAt, c.version],
      ),
    );
    return rows.length === 1 ? ("inserted" as const) : ("exists" as const);
  }

  async updateConnection(id: string, version: number, changes: Partial<Pick<Connection, "url" | "oauthClient" | "revision" | "updatedAt">>) {
    if (!UUID.test(id)) return undefined;
    return this.tx(async (tx) => {
      const current = (await tx.query<Row>(`SELECT ${CONNECTION_COLUMNS} FROM connections WHERE team_id = $1 AND id = $2 AND version = $3 FOR UPDATE`, [this.teamId, id, version])).rows[0];
      if (!current) return undefined;
      const next = { ...connectionOf(current), ...changes };
      const { rows } = await tx.query<Row>(
        `UPDATE connections SET url = $3, oauth = $4, revision = $5, updated_at = $6, version = version + 1 WHERE team_id = $1 AND id = $2 RETURNING ${CONNECTION_COLUMNS}`,
        [this.teamId, id, next.url, json(next.oauthClient), next.revision, next.updatedAt],
      );
      return connectionOf(rows[0]!);
    });
  }

  async deleteConnection(id: string) {
    if (!UUID.test(id)) return false;
    const { rows } = await this.tx((tx) => tx.query("DELETE FROM connections WHERE team_id = $1 AND id = $2 RETURNING id", [this.teamId, id]));
    return rows.length === 1;
  }

  async listCredentials(agentId?: string) {
    if (agentId !== undefined && !UUID.test(agentId)) return [];
    const { rows } = await this.tx((tx) =>
      tx.query<Row>(`SELECT ${CREDENTIAL_COLUMNS} FROM agent_credentials WHERE team_id = $1 AND ($2::uuid IS NULL OR agent_id = $2) ORDER BY agent_id, connection_id`, [this.teamId, agentId ?? null]),
    );
    return rows.map(credentialOf);
  }

  async findCredential(agentId: string, connectionId: string) {
    if (!UUID.test(agentId) || !UUID.test(connectionId)) return undefined;
    const { rows } = await this.tx((tx) => tx.query<Row>(`SELECT ${CREDENTIAL_COLUMNS} FROM agent_credentials WHERE team_id = $1 AND agent_id = $2 AND connection_id = $3`, [this.teamId, agentId, connectionId]));
    return rows[0] && credentialOf(rows[0]);
  }

  async putCredential(c: AgentCredential) {
    await this.tx((tx) =>
      tx.query(
        `INSERT INTO agent_credentials (${CREDENTIAL_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1)
         ON CONFLICT (team_id, agent_id, connection_id) DO UPDATE SET kind = EXCLUDED.kind, secret = EXCLUDED.secret, access = EXCLUDED.access,
           access_expires_at = EXCLUDED.access_expires_at, scope = EXCLUDED.scope, state = EXCLUDED.state, updated_at = EXCLUDED.updated_at,
           version = agent_credentials.version + 1`,
        [this.teamId, c.agentId, c.connectionId, c.kind, json(c.secret), json(c.access), c.accessExpiresAt, c.scope, c.state, c.createdAt, c.updatedAt],
      ),
    );
  }

  async updateCredential(agentId: string, connectionId: string, version: number, changes: CredentialChanges) {
    const current = await this.findCredential(agentId, connectionId);
    if (!current || current.version !== version) return undefined;
    const next = { ...current, ...changes };
    const { rows } = await this.tx((tx) =>
      tx.query<Row>(
        `UPDATE agent_credentials SET secret = $5, access = $6, access_expires_at = $7, scope = $8, state = $9, updated_at = $10, version = version + 1
         WHERE team_id = $1 AND agent_id = $2 AND connection_id = $3 AND version = $4 RETURNING ${CREDENTIAL_COLUMNS}`,
        [this.teamId, agentId, connectionId, version, json(next.secret), json(next.access), next.accessExpiresAt, next.scope, next.state, next.updatedAt],
      ),
    );
    return rows[0] && credentialOf(rows[0]);
  }

  async deleteCredential(agentId: string, connectionId: string) {
    if (!UUID.test(agentId) || !UUID.test(connectionId)) return false;
    const { rows } = await this.tx((tx) => tx.query("DELETE FROM agent_credentials WHERE team_id = $1 AND agent_id = $2 AND connection_id = $3 RETURNING agent_id", [this.teamId, agentId, connectionId]));
    return rows.length === 1;
  }

  async insertPending(p: PendingSignIn) {
    await this.tx((tx) =>
      tx.query("INSERT INTO oauth_pending (state, team_id, agent_id, connection_id, user_id, flow, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)", [
        p.state,
        this.teamId,
        p.agentId,
        p.connectionId,
        p.userId,
        JSON.stringify(p.flow),
        p.expiresAt,
      ]),
    );
  }
}

export class PostgresConnectionStore implements ConnectionStore {
  constructor(private readonly db: TransactionalSqlDatabase) {}

  forTeam(teamId: string): TeamConnectionStore {
    if (teamId === "") throw new Error("A team id is required");
    return new PostgresTeamConnections(this.db, teamId);
  }

  async takePending(state: string, now: Date) {
    if (!STATE.test(state)) return undefined;
    const row = await withSettings(this.db, { "app.oauth_state": state }, async (tx) => (await tx.query<Row>("SELECT state, team_id, agent_id, connection_id, user_id, flow, expires_at FROM oauth_pending WHERE state = $1", [state])).rows[0]);
    if (!row) return undefined;
    const teamId = row["team_id"] as string;
    // Used up: only the delete that removes it may use it.
    const { rows } = await inTeam(this.db, teamId, (tx) => tx.query("DELETE FROM oauth_pending WHERE team_id = $1 AND state = $2 RETURNING state", [teamId, state]));
    if (rows.length !== 1 || new Date(row["expires_at"] as string).getTime() <= now.getTime()) return undefined;
    return {
      state,
      teamId,
      agentId: row["agent_id"] as string,
      connectionId: row["connection_id"] as string,
      userId: row["user_id"] as string,
      flow: row["flow"] as SealedValue,
      expiresAt: iso(row["expires_at"])!,
    };
  }
}
