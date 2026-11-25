import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { DEFAULT_LIMITS, DEFAULT_MAX_ACTIVE_SESSIONS, LIMIT_RANGES, MAX_ACTIVE_SESSIONS_RANGE, mayUseProfile, UnknownProfileError, type Agent, type AgentChanges, type AgentStore, type RunLimits } from "../agents.js";
import { CONNECTION_NAME, type AgentCredential, type Connection, type ConnectionStore, type OAuthGrant } from "../connections.js";
import type { Directory, DirectoryUser } from "../directory/index.js";
import { isSecureUrl } from "../google.js";
import type { SealedValue, TeamSealer } from "../keys.js";
import { createMcpClient, McpAuthError } from "../mcp/client.js";
import { authorizationRequest, checkIssuer, clientFor, clientMetadata, discover, exchangeCode, OAuthError, type AuthorizationServer } from "../mcp/oauth.js";
import { PROFILE_PROVIDERS, type Profile, type ProfileSettings } from "../profiles.js";
import { OPEN_RUN_STATES, type Question, type Run, type RunStore, type Session } from "../store.js";
import { WorkError, type Work } from "../work.js";
import { SignInUnavailableError, type Caller } from "./oidc.js";
import type { DeleteUser } from "../deletion.js";
import type { TriggerSenders } from "./senders.js";

/**
 * The server's API (requirement 0004, *Managing the server*, *Sessions*,
 * *Work intake*): every call a signed-in user's, judged by their own role in
 * the space it names: a team's admins manage its team agents, profiles and
 * connections (every member reads the team's profiles); a personal agent
 * and its owner's own profiles are its owner's alone; every member reads the team's sessions, starts work and
 * answers the questions of sessions they own. A space the caller is not in
 * is 404. Secrets are write-only. The host's triggers come in by its own
 * credential, and the OAuth callback by its state.
 */

export interface ApiDependencies {
  directory: Directory;
  verify: (token: string) => Promise<Caller | undefined>;
  store: RunStore;
  agents: AgentStore;
  connections: ConnectionStore;
  sealer: TeamSealer;
  work: Work;
  senders: TriggerSenders;
  /** The sign-in service's deleted accounts (requirement 0003, *Deleted accounts*): who may tell, and what follows; nobody by default. */
  accountDeletion?: { callers: TriggerSenders; deleteUser: DeleteUser };
  /** This server's public address, for the OAuth callback and its client ID metadata document. */
  publicUrl: string;
  /** Origins whose browsers may call (requirement 0002, HK13); none by default. */
  corsOrigins?: readonly string[];
  now?: () => Date;
  fetch?: typeof fetch;
}

type Env = { Variables: { caller: Caller; user: DirectoryUser } };
type Json = Record<string, unknown>;

const PENDING_MINUTES = 10;
const NAME = (value: unknown, max = 100): value is string => typeof value === "string" && value.trim().length >= 1 && [...value].length <= max;
const WORD = (value: unknown): value is string => typeof value === "string" && /^[\x21-\x7e]{1,200}$/.test(value);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const KEY = /^[\x21-\x7e]{1,4096}$/;

class Invalid extends Error {}
const check = (ok: boolean) => {
  if (!ok) throw new Invalid();
};

const zoneOk = (zone: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

function limitsOf(value: unknown): RunLimits {
  check(typeof value === "object" && value !== null);
  const given = value as Record<string, unknown>;
  const limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(LIMIT_RANGES) as (keyof RunLimits)[]) {
    if (!(key in given)) continue;
    const v = given[key];
    const [min, max] = LIMIT_RANGES[key];
    check(v === null || (Number.isInteger(v) && (v as number) >= min && (v as number) <= max));
    limits[key] = v as number | null;
  }
  return limits;
}

function profileFields(given: Json, base?: ProfileSettings): ProfileSettings {
  const text = (key: keyof ProfileSettings) => {
    const v = key in given ? given[key] : (base?.[key] ?? null);
    check(v === null || (typeof v === "string" && /^[\x21-\x7e]{1,300}$/.test(v)));
    return v as string | null;
  };
  const provider = (given["provider"] ?? base?.provider) as ProfileSettings["provider"];
  check(PROFILE_PROVIDERS.includes(provider));
  const effort = "effort" in given ? given["effort"] : (base?.effort ?? null);
  check(effort === null || ["low", "medium", "high", "xhigh", "max"].includes(effort as string));
  const cacheWindow = "cacheWindow" in given ? given["cacheWindow"] : (base?.cacheWindow ?? null);
  check(cacheWindow === null || cacheWindow === "5m" || cacheWindow === "1h");
  const name = "name" in given ? given["name"] : base?.name;
  check(NAME(name));
  const model = text("model");
  check(model !== null);
  return {
    name: (name as string).trim(),
    provider,
    model: model!,
    effort: effort as ProfileSettings["effort"],
    cacheWindow: cacheWindow as ProfileSettings["cacheWindow"],
    region: text("region"),
    project: text("project"),
    roleArn: text("roleArn"),
    endpoint: text("endpoint"),
    tenantId: text("tenantId"),
    clientId: text("clientId"),
  };
}

const agentView = (a: Agent) => ({
  id: a.id,
  name: a.name,
  description: a.description,
  personal: a.ownerUserId !== null,
  ownerUserId: a.ownerUserId,
  profileId: a.profileId,
  askOwners: a.askOwners,
  limits: a.limits,
  playbook: a.playbook,
  defaultOwnerUserIds: a.defaultOwnerUserIds,
  timeZone: a.timeZone,
  language: a.language,
  paused: a.paused,
  maxActiveSessions: a.maxActiveSessions,
  createdAt: a.createdAt,
  updatedAt: a.updatedAt,
  version: a.version,
});

const profileView = ({ apiKey, teamId: _team, ...rest }: Profile) => ({ ...rest, personal: rest.ownerUserId !== null, hasApiKey: apiKey !== null });
const connectionView = ({ teamId: _team, oauthClient, ...rest }: Connection) => ({ ...rest, oauthClientId: oauthClient?.clientId ?? null });
const credentialView = (c: AgentCredential, name: string | undefined) => ({ connectionId: c.connectionId, connection: name ?? null, kind: c.kind, state: c.state, scope: c.scope, updatedAt: c.updatedAt });
const runView = (r: Run) => ({
  id: r.id,
  state: r.state,
  cause: r.cause,
  waitingOn: r.waitingOn?.kind ?? null,
  stopReason: r.stopReason,
  steps: r.steps,
  inputTokens: r.inputTokens,
  outputTokens: r.outputTokens,
  queuedAt: r.queuedAt,
  endedAt: r.endedAt,
});

export function createApiApp(deps: ApiDependencies): Hono<Env> {
  const { directory, store, agents, connections, sealer, work } = deps;
  const now = deps.now ?? (() => new Date());
  const fetchImpl = deps.fetch ?? fetch;
  const redirectUri = `${deps.publicUrl}/oauth/callback`;
  const metadataUrl = `${deps.publicUrl}/oauth/client-metadata.json`;
  const app = new Hono<Env>();

  // First, before any sign-in: a configured origin's preflight is answered; any other origin gets no CORS header.
  const origins = new Set(deps.corsOrigins ?? []);
  const corsFor = cors({ origin: [...origins], allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"], allowHeaders: ["Authorization", "Content-Type"], maxAge: 600 });
  if (origins.size > 0) app.use((c, next) => (origins.has(c.req.header("Origin") ?? "") ? corsFor(c, next) : next()));

  app.onError((error, c) => {
    if (error instanceof Invalid) return c.json({ error: "Invalid request" }, 400);
    if (error instanceof UnknownProfileError) return c.json({ error: "Unknown profile" }, 400);
    if (error instanceof WorkError) {
      const [status, text] = ({ "not-found": [404, "Not found"], invalid: [400, "Invalid request"], closed: [409, "Closed"], forbidden: [403, "Not an owner"], conflict: [409, "Changed meanwhile"] } as const)[error.code];
      return c.json({ error: text }, status);
    }
    throw error;
  });

  // ---- outside the sign-in: the host's triggers, the OAuth callback and this server's client document

  app.post("/triggers", async (c) => {
    const admitted = await deps.senders.admit(c.req.header("Authorization"));
    if (!admitted) return c.json({ error: "Invalid credential" }, 401);
    const given = (await c.req.json().catch(() => undefined)) as Json | undefined;
    if (!given || typeof given["teamId"] !== "string" || typeof given["agentId"] !== "string" || !WORD(given["event"]) || !WORD(given["reference"])) return c.json({ error: "Invalid request" }, 400);
    if (admitted.teams !== "any" && !admitted.teams.includes(given["teamId"])) return c.json({ error: "Invalid credential" }, 401);
    if (!(await directory.findTeam(given["teamId"]))) return c.json({ error: "Not found" }, 404);
    const owners = given["ownerUserIds"];
    const priority = given["priority"];
    if (owners !== undefined && !(Array.isArray(owners) && owners.every((o) => typeof o === "string"))) return c.json({ error: "Invalid request" }, 400);
    if (priority !== undefined && priority !== "low" && priority !== "medium" && priority !== "high") return c.json({ error: "Invalid request" }, 400);
    if (given["sessionId"] !== undefined && typeof given["sessionId"] !== "string") return c.json({ error: "Invalid request" }, 400);
    if (given["dueOn"] !== undefined && typeof given["dueOn"] !== "string") return c.json({ error: "Invalid request" }, 400);
    if (given["close"] !== undefined && typeof given["close"] !== "boolean") return c.json({ error: "Invalid request" }, 400);
    const result = await work.receive({
      teamId: given["teamId"],
      agentId: given["agentId"],
      sender: "host",
      userId: null,
      event: given["event"],
      reference: given["reference"],
      body: given["body"] === undefined ? "" : JSON.stringify(given["body"]),
      ...(typeof given["sessionId"] === "string" ? { sessionId: given["sessionId"] } : {}),
      ...(owners !== undefined ? { ownerUserIds: owners as string[] } : {}),
      ...(priority !== undefined ? { priority } : {}),
      ...(typeof given["dueOn"] === "string" ? { dueOn: given["dueOn"] } : {}),
      ...(given["close"] === true ? { close: true } : {}),
    });
    return c.json(result, result.duplicate ? 200 : 202);
  });

  // The sign-in service tells of a deleted account: only its own identity, never the host's credential or a person's token.
  app.post("/users/deleted", async (c) => {
    if (!deps.accountDeletion || !(await deps.accountDeletion.callers.admit(c.req.header("Authorization")))) return c.json({ error: "Invalid credential" }, 401);
    const given = (await c.req.json().catch(() => undefined)) as Json | undefined;
    if (!given || !WORD(given["issuer"]) || !WORD(given["subject"])) return c.json({ error: "Invalid request" }, 400);
    await deps.accountDeletion.deleteUser({ issuer: given["issuer"], subject: given["subject"] });
    return c.body(null, 204);
  });

  app.get("/oauth/client-metadata.json", (c) => c.json(clientMetadata(metadataUrl, redirectUri)));

  app.get("/oauth/callback", async (c) => {
    const done = (status: 200 | 400, text: string) => c.text(text, status);
    const pending = await connections.takePending(c.req.query("state") ?? "", now());
    if (!pending) return done(400, "This sign-in is unknown or has expired. Start it again.");
    if (c.req.query("error") || !c.req.query("code")) return done(400, "The sign-in was not completed at the service.");
    const flow = JSON.parse(await sealer.open(pending.teamId, "connection-credential", pending.flow)) as {
      server: AuthorizationServer;
      resource: string;
      verifier: string;
      clientId: string;
      clientSecret: string | null;
    };
    try {
      checkIssuer(flow.server, c.req.query("iss"));
      const tokens = await exchangeCode(
        { tokenEndpoint: flow.server.tokenEndpoint, code: c.req.query("code")!, verifier: flow.verifier, clientId: flow.clientId, clientSecret: flow.clientSecret, redirectUri, resource: flow.resource },
        fetchImpl,
        now(),
      );
      const grant: OAuthGrant = { refreshToken: tokens.refreshToken, clientId: flow.clientId, clientSecret: flow.clientSecret, tokenEndpoint: flow.server.tokenEndpoint, issuer: flow.server.issuer, resource: flow.resource };
      const stamp = now().toISOString();
      const team = connections.forTeam(pending.teamId);
      const connection = await team.findConnection(pending.connectionId);
      const agent = await agents.forTeam(pending.teamId).findAgent(pending.agentId);
      if (!connection || !agent || agent.removedAt !== null) return done(400, "The connection or the agent is gone.");
      await team.putCredential({
        teamId: pending.teamId,
        agentId: pending.agentId,
        connectionId: pending.connectionId,
        kind: "oauth",
        secret: await sealer.seal(pending.teamId, "connection-credential", JSON.stringify(grant)),
        access: await sealer.seal(pending.teamId, "connection-credential", tokens.accessToken),
        accessExpiresAt: tokens.expiresAt,
        scope: tokens.scope,
        state: "active",
        createdAt: stamp,
        updatedAt: stamp,
        version: 1,
      });
      await work.reconnected(pending.teamId, pending.agentId, connection.name);
    } catch (error) {
      if (error instanceof OAuthError) return done(400, `The sign-in failed: ${error.message}.`);
      throw error;
    }
    return done(200, "Signed in. You can close this window.");
  });

  // ---- signed in from here on

  app.use(async (c, next) => {
    const [scheme, token] = (c.req.header("Authorization") ?? "").split(" ");
    let caller: Caller | undefined;
    try {
      caller = scheme === "Bearer" && token ? await deps.verify(token) : undefined;
    } catch (error) {
      if (error instanceof SignInUnavailableError) return c.json({ error: "Sign-in unavailable" }, 503);
      throw error;
    }
    if (!caller) return c.json({ error: "Invalid token" }, 401);
    const user = await directory.signIn(caller);
    // A deleted account is never let in again (requirement 0003, *Deleted accounts*).
    if (user.deleted) return c.json({ error: "Invalid token" }, 401);
    c.set("caller", caller);
    c.set("user", user);
    return next();
  });

  const body = async (c: Context<Env>) => ((await c.req.json().catch(() => undefined)) ?? {}) as Json;
  const me = (c: Context<Env>) => c.get("user").id;
  const teamOf = (c: Context<Env>) => c.req.param("teamId")!;
  /** The caller's role in the space, or a 404 response. */
  const roleIn = async (c: Context<Env>) => directory.roleOf(teamOf(c), me(c));
  const notFound = (c: Context<Env>, what = "Not found") => c.json({ error: what }, 404);
  const forbidden = (c: Context<Env>, what: string) => c.json({ error: what }, 403);

  /** The agent of the path, if the caller is in its space. */
  async function agentOf(c: Context<Env>) {
    const role = await roleIn(c);
    if (!role) return { response: notFound(c, "Team not found") };
    const agent = await agents.forTeam(teamOf(c)).findAgent(c.req.param("agentId")!);
    if (!agent || agent.removedAt !== null) return { response: notFound(c, "Agent not found") };
    /** Who edits it: a team agent the team's admins, a personal agent its owner alone. */
    const edits = agent.ownerUserId === null ? role === "admin" : agent.ownerUserId === me(c);
    return { role, agent, edits };
  }

  app.post("/me/personal-space", async (c) => c.json(await directory.personalSpace(me(c)), 200));

  // ---- agents

  app.get("/teams/:teamId/agents", async (c) => {
    if (!(await roleIn(c))) return notFound(c, "Team not found");
    return c.json({ agents: (await agents.forTeam(teamOf(c)).listAgents()).map(agentView) });
  });

  app.post("/teams/:teamId/agents", async (c) => {
    const role = await roleIn(c);
    if (!role) return notFound(c, "Team not found");
    const given = await body(c);
    const personal = given["personal"] === true;
    if (!personal && role !== "admin") return forbidden(c, "Team admin required");
    check(NAME(given["name"]));
    const stamp = now().toISOString();
    const agent: Agent = {
      id: randomUUID(),
      teamId: teamOf(c),
      name: (given["name"] as string).trim(),
      description: "",
      ownerUserId: personal ? me(c) : null,
      profileId: null,
      askOwners: true,
      limits: { ...DEFAULT_LIMITS },
      playbook: null,
      defaultOwnerUserIds: [],
      timeZone: "UTC",
      language: "en",
      paused: false,
      maxActiveSessions: DEFAULT_MAX_ACTIVE_SESSIONS,
      createdAt: stamp,
      updatedAt: stamp,
      removedAt: null,
      version: 1,
    };
    const changes = await agentChanges(c, agent, given);
    await agents.forTeam(teamOf(c)).insertAgent({ ...agent, ...changes });
    return c.json(agentView({ ...agent, ...changes }), 201);
  });

  /** The settings a body changes, checked: a profile the agent may use, owners who are members. */
  async function agentChanges(c: Context<Env>, agent: Agent, given: Json): Promise<AgentChanges> {
    const changes: AgentChanges = {};
    if ("name" in given) check(NAME(given["name"]));
    if ("name" in given) changes.name = (given["name"] as string).trim();
    if ("description" in given) {
      check(typeof given["description"] === "string" && given["description"].length <= 1000);
      changes.description = given["description"] as string;
    }
    if ("profileId" in given) {
      const id = given["profileId"];
      check(id === null || typeof id === "string");
      if (id !== null) {
        const profile = await agents.forTeam(teamOf(c)).findProfile(id as string);
        if (!profile || !mayUseProfile(agent, profile)) throw new UnknownProfileError();
      }
      changes.profileId = id as string | null;
    }
    if ("askOwners" in given) {
      check(typeof given["askOwners"] === "boolean");
      changes.askOwners = given["askOwners"] as boolean;
    }
    if ("limits" in given) changes.limits = limitsOf(given["limits"]);
    if ("playbook" in given) {
      check(given["playbook"] === null || (typeof given["playbook"] === "string" && given["playbook"].length <= 10_000));
      changes.playbook = (given["playbook"] as string | null) || null;
    }
    if ("defaultOwnerUserIds" in given) {
      const owners = given["defaultOwnerUserIds"];
      check(Array.isArray(owners) && owners.length <= 50 && owners.every((o) => typeof o === "string"));
      for (const id of owners as string[]) check((await directory.roleOf(teamOf(c), id)) !== undefined);
      changes.defaultOwnerUserIds = [...new Set(owners as string[])];
    }
    if ("timeZone" in given) {
      check(typeof given["timeZone"] === "string" && zoneOk(given["timeZone"]));
      changes.timeZone = given["timeZone"] as string;
    }
    if ("language" in given) {
      check(given["language"] === "en" || given["language"] === "de");
      changes.language = given["language"] as Agent["language"];
    }
    if ("maxActiveSessions" in given) {
      const [min, max] = MAX_ACTIVE_SESSIONS_RANGE;
      const cap = given["maxActiveSessions"];
      check(Number.isInteger(cap) && (cap as number) >= min && (cap as number) <= max);
      changes.maxActiveSessions = cap as number;
    }
    return changes;
  }

  app.get("/teams/:teamId/agents/:agentId", async (c) => {
    const found = await agentOf(c);
    return found.response ?? c.json(agentView(found.agent));
  });

  app.patch("/teams/:teamId/agents/:agentId", async (c) => {
    const found = await agentOf(c);
    if (found.response) return found.response;
    if (!found.edits) return forbidden(c, found.agent.ownerUserId === null ? "Team admin required" : "Only its owner changes a personal agent");
    const given = await body(c);
    check(Number.isInteger(given["version"]));
    const changes = await agentChanges(c, found.agent, given);
    const next = await agents.forTeam(teamOf(c)).updateAgent(found.agent.id, given["version"] as number, { ...changes, updatedAt: now().toISOString() });
    return next ? c.json(agentView(next)) : c.json({ error: "Changed meanwhile" }, 409);
  });

  /** Pausing and removing are safety controls: also a team admin's for a personal agent. */
  const control = (paused: boolean) => async (c: Context<Env>) => {
    const found = await agentOf(c);
    if (found.response) return found.response;
    if (!found.edits && found.role !== "admin") return forbidden(c, "Team admin required");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const agent = await agents.forTeam(teamOf(c)).findAgent(found.agent.id);
      const next = agent && (await agents.forTeam(teamOf(c)).updateAgent(agent.id, agent.version, { paused, updatedAt: now().toISOString() }));
      if (next) return c.json(agentView(next));
    }
    return c.json({ error: "Changed meanwhile" }, 409);
  };
  app.post("/teams/:teamId/agents/:agentId/pause", control(true));
  app.post("/teams/:teamId/agents/:agentId/resume", control(false));

  app.delete("/teams/:teamId/agents/:agentId", async (c) => {
    const found = await agentOf(c);
    if (found.response) return found.response;
    if (!found.edits && found.role !== "admin") return forbidden(c, "Team admin required");
    const team = agents.forTeam(teamOf(c));
    const agent = (await team.findAgent(found.agent.id))!;
    const removed = await team.updateAgent(agent.id, agent.version, { removedAt: now().toISOString(), profileId: null, updatedAt: now().toISOString() });
    if (!removed) return c.json({ error: "Changed meanwhile" }, 409);
    for (const session of await store.forTeam(teamOf(c)).listSessions({ state: "open", agentId: agent.id })) await work.closeSession(teamOf(c), session.id, "agent-removed");
    return c.body(null, 204);
  });

  // ---- profiles: the team's by its admins, a user's own by that user

  app.get("/teams/:teamId/profiles", async (c) => {
    const role = await roleIn(c);
    if (!role) return notFound(c, "Team not found");
    // The team's for every member (their personal agents may use them; secrets are never shown), a member's own for them alone.
    const visible = (await agents.forTeam(teamOf(c)).listProfiles()).filter((p) => p.ownerUserId === null || p.ownerUserId === me(c));
    return c.json({ profiles: visible.map(profileView) });
  });

  const profileOf = async (c: Context<Env>) => {
    const role = await roleIn(c);
    if (!role) return { response: notFound(c, "Team not found") };
    const profile = await agents.forTeam(teamOf(c)).findProfile(c.req.param("profileId")!);
    const mine = profile && (profile.ownerUserId === null ? role === "admin" : profile.ownerUserId === me(c));
    return mine ? { profile } : { response: notFound(c, "Profile not found") };
  };

  const apiKeyOf = async (c: Context<Env>, given: Json): Promise<SealedValue | null | undefined> => {
    if (!("apiKey" in given)) return undefined;
    check(given["apiKey"] === null || (typeof given["apiKey"] === "string" && KEY.test(given["apiKey"])));
    return given["apiKey"] === null ? null : sealer.seal(teamOf(c), "model-key", given["apiKey"] as string);
  };

  app.post("/teams/:teamId/profiles", async (c) => {
    const role = await roleIn(c);
    if (!role) return notFound(c, "Team not found");
    const given = await body(c);
    const personal = given["personal"] === true;
    if (!personal && role !== "admin") return forbidden(c, "Team admin required");
    const stamp = now().toISOString();
    const profile: Profile = {
      ...profileFields(given),
      id: randomUUID(),
      teamId: teamOf(c),
      ownerUserId: personal ? me(c) : null,
      apiKey: (await apiKeyOf(c, given)) ?? null,
      createdAt: stamp,
      updatedAt: stamp,
      version: 1,
    };
    await agents.forTeam(teamOf(c)).insertProfile(profile);
    return c.json(profileView(profile), 201);
  });

  app.patch("/teams/:teamId/profiles/:profileId", async (c) => {
    const found = await profileOf(c);
    if (found.response) return found.response;
    const given = await body(c);
    check(Number.isInteger(given["version"]));
    const apiKey = await apiKeyOf(c, given);
    const next = await agents.forTeam(teamOf(c)).updateProfile(found.profile.id, given["version"] as number, {
      ...profileFields(given, found.profile),
      ...(apiKey !== undefined ? { apiKey } : {}),
      updatedAt: now().toISOString(),
    });
    return next ? c.json(profileView(next)) : c.json({ error: "Changed meanwhile" }, 409);
  });

  app.delete("/teams/:teamId/profiles/:profileId", async (c) => {
    const found = await profileOf(c);
    if (found.response) return found.response;
    const outcome = await agents.forTeam(teamOf(c)).deleteProfile(found.profile.id);
    return outcome === "in-use" ? c.json({ error: "An agent uses this profile" }, 409) : c.body(null, 204);
  });

  // ---- connections: the team's admins

  const adminOnly = async (c: Context<Env>) => {
    const role = await roleIn(c);
    if (!role) return notFound(c, "Team not found");
    return role === "admin" ? undefined : forbidden(c, "Team admin required");
  };

  const oauthClientOf = async (c: Context<Env>, value: unknown): Promise<Connection["oauthClient"]> => {
    if (value === null || value === undefined) return null;
    check(typeof value === "object");
    const { clientId, clientSecret } = value as Json;
    check(typeof clientId === "string" && clientId.length >= 1 && clientId.length <= 500);
    check(clientSecret === undefined || clientSecret === null || (typeof clientSecret === "string" && KEY.test(clientSecret)));
    return { clientId: clientId as string, clientSecret: typeof clientSecret === "string" ? await sealer.seal(teamOf(c), "connection-credential", clientSecret) : null };
  };

  app.get("/teams/:teamId/connections", async (c) => {
    if (!(await roleIn(c))) return notFound(c, "Team not found");
    return c.json({ connections: (await connections.forTeam(teamOf(c)).listConnections()).map(connectionView) });
  });

  app.post("/teams/:teamId/connections", async (c) => {
    const refused = await adminOnly(c);
    if (refused) return refused;
    const given = await body(c);
    check(typeof given["name"] === "string" && CONNECTION_NAME.test(given["name"]));
    check(typeof given["url"] === "string" && isSecureUrl(given["url"]) && !given["url"].includes("#"));
    check(given["auth"] === "key" || given["auth"] === "oauth");
    const stamp = now().toISOString();
    const connection: Connection = {
      id: randomUUID(),
      teamId: teamOf(c),
      name: given["name"] as string,
      url: given["url"] as string,
      auth: given["auth"] as Connection["auth"],
      oauthClient: given["auth"] === "oauth" ? await oauthClientOf(c, given["oauthClient"]) : null,
      revision: null,
      createdAt: stamp,
      updatedAt: stamp,
      version: 1,
    };
    if ((await connections.forTeam(teamOf(c)).insertConnection(connection)) === "exists") return c.json({ error: "Name taken" }, 409);
    return c.json(connectionView(connection), 201);
  });

  app.patch("/teams/:teamId/connections/:connectionId", async (c) => {
    const refused = await adminOnly(c);
    if (refused) return refused;
    const given = await body(c);
    check(Number.isInteger(given["version"]));
    const changes: Partial<Pick<Connection, "url" | "oauthClient" | "revision" | "updatedAt">> = { updatedAt: now().toISOString() };
    if ("url" in given) {
      check(typeof given["url"] === "string" && isSecureUrl(given["url"]) && !given["url"].includes("#"));
      changes.url = given["url"] as string;
      changes.revision = null;
    }
    if ("oauthClient" in given) changes.oauthClient = await oauthClientOf(c, given["oauthClient"]);
    const next = await connections.forTeam(teamOf(c)).updateConnection(c.req.param("connectionId")!, given["version"] as number, changes);
    return next ? c.json(connectionView(next)) : c.json({ error: "Not found or changed meanwhile" }, 409);
  });

  app.delete("/teams/:teamId/connections/:connectionId", async (c) => {
    const refused = await adminOnly(c);
    if (refused) return refused;
    return (await connections.forTeam(teamOf(c)).deleteConnection(c.req.param("connectionId")!)) ? c.body(null, 204) : notFound(c, "Connection not found");
  });

  // ---- an agent's credentials at the team's connections: whoever edits the agent

  const credentialTarget = async (c: Context<Env>) => {
    const found = await agentOf(c);
    if (found.response) return { response: found.response };
    if (!found.edits) return { response: forbidden(c, found.agent.ownerUserId === null ? "Team admin required" : "Only its owner changes a personal agent") };
    const connection = await connections.forTeam(teamOf(c)).findConnection(c.req.param("connectionId") ?? "");
    return { agent: found.agent, connection };
  };

  app.get("/teams/:teamId/agents/:agentId/credentials", async (c) => {
    const found = await agentOf(c);
    if (found.response) return found.response;
    if (!found.edits) return forbidden(c, "Not this agent's editor");
    const team = connections.forTeam(teamOf(c));
    const names = new Map((await team.listConnections()).map((x) => [x.id, x.name]));
    return c.json({ credentials: (await team.listCredentials(found.agent.id)).map((cred) => credentialView(cred, names.get(cred.connectionId))) });
  });

  app.put("/teams/:teamId/agents/:agentId/credentials/:connectionId", async (c) => {
    const target = await credentialTarget(c);
    if (target.response) return target.response;
    if (!target.connection) return notFound(c, "Connection not found");
    if (target.connection.auth !== "key") return c.json({ error: "This connection signs in by OAuth" }, 409);
    const given = await body(c);
    check(typeof given["key"] === "string" && KEY.test(given["key"]));
    const stamp = now().toISOString();
    await connections.forTeam(teamOf(c)).putCredential({
      teamId: teamOf(c),
      agentId: target.agent.id,
      connectionId: target.connection.id,
      kind: "key",
      secret: await sealer.seal(teamOf(c), "connection-credential", given["key"] as string),
      access: null,
      accessExpiresAt: null,
      scope: null,
      state: "active",
      createdAt: stamp,
      updatedAt: stamp,
      version: 1,
    });
    await work.reconnected(teamOf(c), target.agent.id, target.connection.name);
    return c.body(null, 204);
  });

  app.delete("/teams/:teamId/agents/:agentId/credentials/:connectionId", async (c) => {
    const target = await credentialTarget(c);
    if (target.response) return target.response;
    if (!target.connection) return notFound(c, "Connection not found");
    return (await connections.forTeam(teamOf(c)).deleteCredential(target.agent.id, target.connection.id)) ? c.body(null, 204) : notFound(c, "Credential not found");
  });

  app.post("/teams/:teamId/agents/:agentId/credentials/:connectionId/oauth", async (c) => {
    const target = await credentialTarget(c);
    if (target.response) return target.response;
    if (!target.connection) return notFound(c, "Connection not found");
    const connection = target.connection;
    if (connection.auth !== "oauth") return c.json({ error: "This connection takes a key" }, 409);
    try {
      // The service's challenge names its metadata and scope: asked without a credential.
      let challenge: McpAuthError["challenge"] = {};
      await createMcpClient({ url: connection.url, fetch: fetchImpl })
        .listTools()
        .catch((error: unknown) => {
          if (error instanceof McpAuthError) challenge = error.challenge;
        });
      const found = await discover(connection.url, challenge, fetchImpl);
      const registered = connection.oauthClient && {
        clientId: connection.oauthClient.clientId,
        clientSecret: connection.oauthClient.clientSecret ? await sealer.open(teamOf(c), "connection-credential", connection.oauthClient.clientSecret) : null,
      };
      const client = await clientFor(found.server, { registered, metadataUrl, redirectUri }, fetchImpl);
      // A sign-in after a missing scope (403 insufficient_scope) asks for what the agent held and what was missing.
      const held = (await connections.forTeam(teamOf(c)).findCredential(target.agent.id, connection.id))?.scope;
      const scope = [...new Set([...(found.scope ?? "").split(" "), ...(held ?? "").split(" ")])].filter(Boolean).join(" ") || null;
      const request = authorizationRequest({ ...found, scope }, { clientId: client.clientId, redirectUri });
      const flow = { server: found.server, resource: found.resource, verifier: request.verifier, clientId: client.clientId, clientSecret: client.clientSecret };
      await connections.forTeam(teamOf(c)).insertPending({
        state: request.state,
        teamId: teamOf(c),
        agentId: target.agent.id,
        connectionId: connection.id,
        userId: me(c),
        flow: await sealer.seal(teamOf(c), "connection-credential", JSON.stringify(flow)),
        expiresAt: new Date(now().getTime() + PENDING_MINUTES * 60_000).toISOString(),
      });
      return c.json({ authorizationUrl: request.url }, 201);
    } catch (error) {
      if (error instanceof OAuthError) return c.json({ error: error.message }, 502);
      throw error;
    }
  });

  // ---- sessions

  const sessionOf = async (c: Context<Env>) => {
    const role = await roleIn(c);
    if (!role) return { response: notFound(c, "Team not found") };
    const session = await store.forTeam(teamOf(c)).findSession(c.req.param("sessionId")!);
    if (!session) return { response: notFound(c, "Session not found") };
    const owns = session.ownerUserIds.length === 0 || session.ownerUserIds.includes(me(c));
    return { role, session, owns, manages: owns || role === "admin" };
  };

  const sessionSummary = async (teamId: string, session: Session) => {
    const runs = await store.forTeam(teamId).listRuns({ sessionId: session.id });
    const current = runs.filter((r) => OPEN_RUN_STATES.includes(r.state)).at(-1) ?? runs.at(-1);
    return { ...session, run: current ? runView(current) : null };
  };

  app.get("/teams/:teamId/sessions", async (c) => {
    if (!(await roleIn(c))) return notFound(c, "Team not found");
    const state = c.req.query("state");
    const agentId = c.req.query("agentId");
    if ((state !== undefined && state !== "open" && state !== "closed") || (agentId !== undefined && !UUID.test(agentId))) throw new Invalid();
    const sessions = await store.forTeam(teamOf(c)).listSessions({ ...(state ? { state } : {}), ...(agentId ? { agentId } : {}) });
    return c.json({ sessions: await Promise.all(sessions.slice(0, 200).map((s) => sessionSummary(teamOf(c), s))) });
  });

  app.post("/teams/:teamId/agents/:agentId/sessions", async (c) => {
    const found = await agentOf(c);
    if (found.response) return found.response;
    const given = await body(c);
    check(typeof given["message"] === "string" && given["message"].trim().length >= 1);
    const owners = given["ownerUserIds"];
    check(owners === undefined || (Array.isArray(owners) && owners.every((o) => typeof o === "string")));
    const result = await work.receive({
      teamId: teamOf(c),
      agentId: found.agent.id,
      sender: "user",
      userId: me(c),
      event: "message",
      reference: randomUUID(),
      body: given["message"] as string,
      ...(owners !== undefined ? { ownerUserIds: owners as string[] } : {}),
    });
    return c.json({ sessionId: result.sessionId }, 201);
  });

  app.get("/teams/:teamId/sessions/:sessionId", async (c) => {
    const found = await sessionOf(c);
    if (found.response) return found.response;
    const runs = await store.forTeam(teamOf(c)).listRuns({ sessionId: found.session.id });
    const summarized = runs.filter((r) => r.summary !== null).at(-1);
    const resulted = runs.filter((r) => r.result !== null).at(-1);
    const open = (await store.forTeam(teamOf(c)).listQuestions({ state: "open", sessionId: found.session.id }))[0];
    return c.json({
      ...found.session,
      runs: runs.map(runView),
      summary: summarized ? await sealer.open(teamOf(c), "summary", summarized.summary!) : null,
      result: resulted ? await sealer.open(teamOf(c), "result", resulted.result!) : null,
      question: open ? await questionView(teamOf(c), open) : null,
    });
  });

  app.post("/teams/:teamId/sessions/:sessionId/messages", async (c) => {
    const found = await sessionOf(c);
    if (found.response) return found.response;
    const given = await body(c);
    check(typeof given["message"] === "string" && given["message"].trim().length >= 1);
    await work.receive({ teamId: teamOf(c), agentId: found.session.agentId, sender: "user", userId: me(c), event: "message", reference: randomUUID(), body: given["message"] as string, sessionId: found.session.id });
    return c.body(null, 202);
  });

  app.patch("/teams/:teamId/sessions/:sessionId", async (c) => {
    const found = await sessionOf(c);
    if (found.response) return found.response;
    if (!found.manages) return forbidden(c, "Not an owner");
    const given = await body(c);
    check(Number.isInteger(given["version"]) && Array.isArray(given["ownerUserIds"]) && (given["ownerUserIds"] as unknown[]).every((o) => typeof o === "string"));
    return c.json(await work.changeOwners(teamOf(c), found.session.id, given["version"] as number, given["ownerUserIds"] as string[]));
  });

  app.post("/teams/:teamId/sessions/:sessionId/close", async (c) => {
    const found = await sessionOf(c);
    if (found.response) return found.response;
    if (!found.manages) return forbidden(c, "Not an owner");
    return c.json(await work.closeSession(teamOf(c), found.session.id));
  });

  app.post("/teams/:teamId/runs/:runId/stop", async (c) => {
    const role = await roleIn(c);
    if (!role) return notFound(c, "Team not found");
    const run = await store.forTeam(teamOf(c)).findRun(c.req.param("runId")!);
    const session = run && (await store.forTeam(teamOf(c)).findSession(run.sessionId));
    if (!run || !session) return notFound(c, "Run not found");
    if (role !== "admin" && session.ownerUserIds.length > 0 && !session.ownerUserIds.includes(me(c))) return forbidden(c, "Not an owner");
    return c.json(runView(await work.stopRun(teamOf(c), run.id)));
  });

  // ---- questions: listed to the sessions' owners

  /** A question to its session's owners; its agent, and its run's priority and due date (the trigger's), for a host's order. */
  const questionView = async (teamId: string, q: Question) => {
    const runs = store.forTeam(teamId);
    const [session, run] = await Promise.all([runs.findSession(q.sessionId), runs.findRun(q.runId)]);
    return {
      id: q.id,
      sessionId: q.sessionId,
      agentId: session?.agentId ?? null,
      runId: q.runId,
      priority: run?.priority ?? null,
      dueOn: run?.dueOn ?? null,
      kind: q.kind,
      cause: q.cause,
      text: await sealer.open(teamId, "question", q.body),
      state: q.state,
      createdAt: q.createdAt,
      answeredAt: q.answeredAt,
    };
  };

  app.get("/teams/:teamId/questions", async (c) => {
    if (!(await roleIn(c))) return notFound(c, "Team not found");
    const runs = store.forTeam(teamOf(c));
    const mine: Question[] = [];
    for (const q of await runs.listQuestions({ state: "open" })) {
      const session = await runs.findSession(q.sessionId);
      if (session && (session.ownerUserIds.length === 0 || session.ownerUserIds.includes(me(c)))) mine.push(q);
    }
    return c.json({ questions: await Promise.all(mine.map((q) => questionView(teamOf(c), q))) });
  });

  app.post("/teams/:teamId/questions/:questionId/answer", async (c) => {
    if (!(await roleIn(c))) return notFound(c, "Team not found");
    const given = await body(c);
    check(typeof given["answer"] === "string");
    const answered = await work.answer(teamOf(c), c.req.param("questionId")!, me(c), given["answer"] as string);
    return c.json(await questionView(teamOf(c), answered));
  });

  // ---- usage: the team's admins; an installation admin sees each team's totals only

  const range = (c: Context<Env>) => {
    const today = now().toISOString().slice(0, 10);
    const from = c.req.query("from") ?? `${today.slice(0, 8)}01`;
    const to = c.req.query("to") ?? today;
    check(DAY.test(from) && DAY.test(to) && from <= to);
    return { from, to };
  };

  app.get("/teams/:teamId/usage", async (c) => {
    const refused = await adminOnly(c);
    if (refused) return refused;
    const { from, to } = range(c);
    return c.json({ from, to, usage: await store.forTeam(teamOf(c)).listUsage(from, to) });
  });

  app.get("/usage", async (c) => {
    if (!c.get("caller").admin) return forbidden(c, "Installation admin required");
    const { from, to } = range(c);
    const teams = [];
    for (const team of await directory.allTeams()) {
      const rows = await store.forTeam(team.id).listUsage(from, to);
      const sum = (key: "sessions" | "runs" | "inputTokens" | "outputTokens") => rows.reduce((total, row) => total + row[key], 0);
      teams.push({ teamId: team.id, name: team.name, kind: team.kind, sessions: sum("sessions"), runs: sum("runs"), inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens") });
    }
    return c.json({ from, to, teams });
  });

  return app;
}
