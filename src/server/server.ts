import { Hono } from "hono";
import { createDirectory, type Directory } from "../directory/index.js";
import type { TransactionalSqlDatabase } from "../db/sql-database.js";
import { PostgresAgentStore } from "../agents.js";
import { PostgresConnectionStore } from "../connections.js";
import { createTeamSealer, PostgresTeamKeyStore, type KeyWrapper } from "../keys.js";
import { noNotifier, type Notifier } from "../notify.js";
import { createRunner, type RunnerDependencies } from "../runner.js";
import { createScheduler } from "../scheduler.js";
import { PostgresRunStore } from "../store.js";
import { createToolHub } from "../tools.js";
import { createWork } from "../work.js";
import type { TeamIdentity } from "../model/index.js";
import { createApiApp } from "./api.js";
import { createDirectoryApp } from "./directory-api.js";
import { createOidcVerifier } from "./oidc.js";
import { noSenders, type TriggerSenders } from "./senders.js";

export { migrateDatabase, SERVER_SCHEMA } from "../migrations.js";
export { hostIdentitySender, hostTokenSender, noSenders, type TriggerSenders } from "./senders.js";
export type { Caller } from "./oidc.js";

/**
 * The server wired as its entry point wires it, without reading the
 * environment (requirement 0002, HK15): the package export `./server`, so a
 * host boots the server in its own tests. The entry point
 * (`src/server/index.ts`) reads the environment and calls this.
 */
export interface ServerOptions {
  /** Postgres, migrated (`migrateDatabase`), its connections searching `agent_server` first. */
  db: TransactionalSqlDatabase;
  /** What wraps the teams' keys: `localKeyWrapper` or `cloudKmsKeyWrapper`. */
  keyWrapper: KeyWrapper;
  /** This server's own address: the OAuth callback and its client ID metadata document. */
  publicUrl: string;
  /** The provider people sign in at; roles in `groups`, admins holding `agent-server-admin`, unless named. */
  oidc: { issuer: string; audience: string; rolesClaim?: string; adminRole?: string };
  /** Who creates teams: installation admins (default) or every user. */
  teamCreation?: "users" | "admins";
  /** Origins whose browsers may call; none by default. */
  corsOrigins?: readonly string[];
  /** The host connection: its MCP address and the server's token there. */
  hostMcp?: { url: string; token: () => Promise<string> };
  /** Who may send triggers; nobody by default. */
  senders?: TriggerSenders;
  /** Where the work is announced; nowhere by default. */
  notifier?: Notifier;
  /** The teams' cloud identities; none by default (API-key profiles only). */
  identity?: TeamIdentity;
  /** The model client for a run; default the adapters over `fetch`. */
  client?: RunnerDependencies["client"];
  now?: () => Date;
}

export interface AgentServer {
  /** `GET /health`, the host's triggers, the OAuth callback and the API. */
  app: Hono;
  directory: Directory;
  work: ReturnType<typeof createWork>;
  runner: ReturnType<typeof createRunner>;
  /** Not started: `start()` runs it on its timer, `tick()` once. */
  scheduler: ReturnType<typeof createScheduler>;
}

const noIdentity: TeamIdentity = {
  googleAccessToken: () => Promise.reject(new Error("No team identity configured")),
  awsCredentials: () => Promise.reject(new Error("No team identity configured")),
  azureAccessToken: () => Promise.reject(new Error("No team identity configured")),
};

export function createServer(options: ServerOptions): AgentServer {
  const { db } = options;
  const now = options.now ?? (() => new Date());
  const store = new PostgresRunStore(db);
  const agents = new PostgresAgentStore(db);
  const connections = new PostgresConnectionStore(db);
  const directory = createDirectory(db, { now });
  const sealer = createTeamSealer({ store: new PostgresTeamKeyStore(db), wrapper: options.keyWrapper, now });
  const notifier = options.notifier ?? noNotifier;
  const tools = createToolHub({ host: options.hostMcp, connections, sealer, now });
  const runner = createRunner({ store, agents, directory, sealer, tools, identity: options.identity ?? noIdentity, notifier, now, ...(options.client ? { client: options.client } : {}) });
  const work = createWork({ store, agents, directory, sealer, notifier, now });
  const scheduler = createScheduler({ store, agents, directory, runner, now });
  const verify = createOidcVerifier({ rolesClaim: "groups", adminRole: "agent-server-admin", ...options.oidc });

  const app = new Hono();
  app.get("/health", (c) => c.json({ status: "ok", service: "fairlead-agent-server" }));
  // After the health check: the host's triggers and the OAuth callback, then a signed-in user's calls (requirements 0003, 0004).
  app.route(
    "/",
    createApiApp({ directory, verify, store, agents, connections, sealer, work, senders: options.senders ?? noSenders, publicUrl: options.publicUrl, now, ...(options.corsOrigins ? { corsOrigins: options.corsOrigins } : {}) }),
  );
  app.route("/", createDirectoryApp({ directory, verify, teamCreation: options.teamCreation ?? "admins" }));
  return { app, directory, work, runner, scheduler };
}
