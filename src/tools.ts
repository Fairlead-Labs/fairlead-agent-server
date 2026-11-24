import { randomUUID } from "node:crypto";
import type { AgentCredential, Connection, ConnectionStore, OAuthGrant, TeamConnectionStore } from "./connections.js";
import type { TeamSealer } from "./keys.js";
import { createMcpClient, McpAuthError, type CallOutcome, type McpClient, type McpTool, type TaskState } from "./mcp/client.js";
import { refreshTokens } from "./mcp/oauth.js";
import type { JsonObject } from "./model/index.js";

/**
 * A run's tools (requirement 0004, *Connections*; ADR 0001 §1, §2): the
 * host connection's, with the server's own sign-in bound to the run (its
 * id and step in two headers), and those of the team's own connections the
 * agent holds a credential for, each signed in with that credential and
 * named `<connection>__<tool>`. Nothing else: the server holds no power of
 * its own at any service.
 */

/** The run a host call is for (a canonical lower-case UUID). */
export const RUN_ID_HEADER = "Fairlead-Run-Id";
/** The run's step the call belongs to, by which a cut-off call is found. */
export const RUN_STEP_HEADER = "Fairlead-Run-Step";

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

export interface RunTool {
  /** As the model sees it. */
  name: string;
  description: string;
  inputSchema: JsonObject;
  readOnly: boolean;
  /** The team connection's name; null for the host connection. */
  connection: string | null;
  remote: McpTool;
}

/** The host refused the run (its 401): no longer working, past its slice, stopped. */
export class RunRefusedError extends Error {
  constructor() {
    super("The host refused the run");
    this.name = "RunRefusedError";
  }
}

/** The agent's credential at a team connection is missing, refused or cannot be renewed: a person signs in again. */
export class CredentialNeededError extends Error {
  constructor(readonly connection: string) {
    super(`The agent needs to be signed in again at ${connection}`);
    this.name = "CredentialNeededError";
  }
}

export interface RunTools {
  tools: RunTool[];
  /** Team connections whose tools could not be listed, with why. */
  unavailable: { connection: string; reason: "needs-auth" | "unavailable" }[];
  call(tool: RunTool, args: JsonObject, stepId: string): Promise<CallOutcome>;
  getTask(connection: string | null, taskId: string, stepId: string): Promise<TaskState>;
}

export interface ToolHub {
  /** Reserved names the hub never hands out (the server's own tools). */
  open(teamId: string, agentId: string, runId: string, reserved: readonly string[]): Promise<RunTools>;
}

export interface HostConnection {
  url: string;
  /** The server's own token for the host. */
  token: () => Promise<string>;
}

export function createToolHub({
  host,
  connections,
  sealer,
  now = () => new Date(),
  fetch: fetchImpl = fetch,
}: {
  host: HostConnection | undefined;
  connections: ConnectionStore;
  sealer: TeamSealer;
  now?: () => Date;
  fetch?: typeof fetch;
}): ToolHub {
  return {
    async open(teamId, agentId, runId, reserved) {
      const store = connections.forTeam(teamId);
      const tools: RunTool[] = [];
      const unavailable: RunTools["unavailable"] = [];
      const clients = new Map<string | null, McpClient>();
      const taken = new Set(reserved);
      const add = (tool: McpTool, connection: string | null) => {
        const name = connection === null ? tool.name : `${connection}__${tool.name}`;
        if (!TOOL_NAME.test(name) || taken.has(name)) return;
        taken.add(name);
        tools.push({ name, description: tool.description, inputSchema: tool.inputSchema, readOnly: tool.readOnly, connection, remote: tool });
      };

      const hostHeaders = (stepId: string) => ({ [RUN_ID_HEADER]: runId, [RUN_STEP_HEADER]: stepId });
      if (host) {
        const client = createMcpClient({ url: host.url, token: host.token, fetch: fetchImpl });
        clients.set(null, client);
        try {
          for (const tool of await client.listTools(hostHeaders(randomUUID()))) add(tool, null);
        } catch (error) {
          if (error instanceof McpAuthError && error.status === 401) throw new RunRefusedError();
          throw error;
        }
      }

      const byId = new Map((await store.listConnections()).map((c) => [c.id, c]));
      const signIns = new Map<string, TeamSignIn>();
      for (const credential of await store.listCredentials(agentId)) {
        const connection = byId.get(credential.connectionId);
        if (!connection) continue;
        if (credential.state !== "active") {
          unavailable.push({ connection: connection.name, reason: "needs-auth" });
          continue;
        }
        const signIn = new TeamSignIn(teamId, store, connection, credential, sealer, now, fetchImpl);
        signIns.set(connection.name, signIn);
        const client = createMcpClient({
          url: connection.url,
          token: () => signIn.token(),
          revision: connection.revision,
          onRevision: (revision) => void store.updateConnection(connection.id, connection.version, { revision, updatedAt: now().toISOString() }).catch(() => {}),
          fetch: fetchImpl,
        });
        clients.set(connection.name, client);
        try {
          for (const tool of await signIn.attempt(() => client.listTools())) add(tool, connection.name);
        } catch (error) {
          unavailable.push({ connection: connection.name, reason: error instanceof CredentialNeededError ? "needs-auth" : "unavailable" });
        }
      }

      const via = async <T>(connection: string | null, work: (client: McpClient) => Promise<T>): Promise<T> => {
        const client = clients.get(connection);
        if (!client) throw new CredentialNeededError(connection ?? "host");
        if (connection === null) {
          try {
            return await work(client);
          } catch (error) {
            if (error instanceof McpAuthError && error.status === 401) throw new RunRefusedError();
            throw error;
          }
        }
        return signIns.get(connection)!.attempt(() => work(client));
      };

      return {
        tools,
        unavailable,
        call: (tool, args, stepId) => via(tool.connection, (client) => client.callTool(tool.remote, args, tool.connection === null ? hostHeaders(stepId) : {})),
        getTask: (connection, taskId, stepId) => via(connection, (client) => client.getTask(taskId, connection === null ? hostHeaders(stepId) : {})),
      };
    },
  };
}

/** One agent's credential at one team connection: its token, renewed when due or refused once, marked when it cannot be. */
class TeamSignIn {
  constructor(
    private readonly teamId: string,
    private readonly store: TeamConnectionStore,
    private readonly connection: Connection,
    private credential: AgentCredential,
    private readonly sealer: TeamSealer,
    private readonly now: () => Date,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async token(): Promise<string> {
    const c = this.credential;
    if (c.kind === "key") return this.sealer.open(this.teamId, "connection-credential", c.secret);
    const due = c.accessExpiresAt !== null && Date.parse(c.accessExpiresAt) - this.now().getTime() < 60_000;
    if (!c.access || due) await this.renew();
    return this.sealer.open(this.teamId, "connection-credential", this.credential.access!);
  }

  /** `work`, with one renewal and retry on a 401; a refusal that stays, or a missing scope, marks the credential. */
  async attempt<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof McpAuthError)) throw error;
      if (error.status === 401 && this.credential.kind === "oauth") {
        try {
          await this.renew();
          return await work();
        } catch (again) {
          if (!(again instanceof McpAuthError) && !(again instanceof CredentialNeededError)) throw again;
        }
      }
      if (error.status === 403 && error.challenge.error !== "insufficient_scope") throw error;
      const scope = error.challenge.scope ? [...new Set([...(this.credential.scope ?? "").split(" "), ...error.challenge.scope.split(" ")])].filter(Boolean).join(" ") : this.credential.scope;
      await this.mark(scope);
      throw new CredentialNeededError(this.connection.name);
    }
  }

  /**
   * Renews the access token. Several runs of one agent may hold the
   * credential at once (its cap of active sessions): a newer version
   * another run stored meanwhile is taken instead, before refreshing and
   * after a refresh or a save that failed, since a service may refuse a
   * refresh token already used.
   */
  private async renew() {
    const held = this.credential;
    if (await this.takeNewer(held)) return;
    const grant = JSON.parse(await this.sealer.open(this.teamId, "connection-credential", held.secret)) as OAuthGrant;
    if (!grant.refreshToken) {
      await this.mark(held.scope);
      throw new CredentialNeededError(this.connection.name);
    }
    let tokens;
    try {
      tokens = await refreshTokens({ tokenEndpoint: grant.tokenEndpoint, refreshToken: grant.refreshToken, clientId: grant.clientId, clientSecret: grant.clientSecret, resource: grant.resource }, this.fetchImpl, this.now());
    } catch {
      if (await this.takeNewer(held)) return;
      await this.mark(held.scope);
      throw new CredentialNeededError(this.connection.name);
    }
    const next = await this.store.updateCredential(held.agentId, held.connectionId, held.version, {
      access: await this.sealer.seal(this.teamId, "connection-credential", tokens.accessToken),
      accessExpiresAt: tokens.expiresAt,
      ...(tokens.refreshToken ? { secret: await this.sealer.seal(this.teamId, "connection-credential", JSON.stringify({ ...grant, refreshToken: tokens.refreshToken })) } : {}),
      ...(tokens.scope ? { scope: tokens.scope } : {}),
      updatedAt: this.now().toISOString(),
    });
    if (next) this.credential = next;
    // ponytail: two renewals in the same instant may both refresh; the loser's token is then dropped, the winner's kept.
    else if (!(await this.takeNewer(held))) throw new CredentialNeededError(this.connection.name);
  }

  /** Takes a version of the credential newer than `held` that another run renewed, while it is active with a token. */
  private async takeNewer(held: AgentCredential): Promise<boolean> {
    const latest = await this.store.findCredential(held.agentId, held.connectionId);
    if (!latest || latest.version === held.version || latest.state !== "active" || latest.kind !== "oauth" || latest.access === null) return false;
    this.credential = latest;
    return true;
  }

  private async mark(scope: string | null) {
    await this.store.updateCredential(this.credential.agentId, this.credential.connectionId, this.credential.version, { state: "needs-auth", scope, updatedAt: this.now().toISOString() });
  }
}

/**
 * The host's word on one of the run's calls (requirement 0001, RN9), found
 * by its step id: never received, received without a recorded outcome, or
 * its answer's status.
 */
export type RecordedOutcome = "not-received" | "no-outcome" | { status: number };

/** The host's record of calls, read by step id. A port: without an adapter every cut-off write is an unknown outcome. */
export interface RunCallLog {
  outcome(teamId: string, runId: string, stepId: string): Promise<RecordedOutcome>;
}
