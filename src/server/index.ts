import { serve } from "@hono/node-server";
import pg from "pg";
import { Hono } from "hono";
import { CLOUD_KMS_URL, isSecureUrl, KMS_CRYPTO_KEY_PATTERN, metadataAccessToken, metadataIdentityToken } from "../google.js";
import { poolDatabase } from "../db/sql-database.js";
import {
  cloudKmsKeyWrapper,
  createRunner,
  createTeamIdentity,
  createTeamSealer,
  createToolHub,
  createWebhookNotifier,
  localKeyWrapper,
  migrateDatabase,
  SERVER_SCHEMA,
  noNotifier,
  PostgresAgentStore,
  PostgresConnectionStore,
  PostgresRunStore,
  PostgresTeamKeyStore,
  WEBHOOK_SECRET,
  type TeamIdentity,
} from "../index.js";
import { createDirectory } from "../directory/index.js";
import { createScheduler } from "../scheduler.js";
import { createWork } from "../work.js";
import { createApiApp } from "./api.js";
import { createDirectoryApp } from "./directory-api.js";
import { createOidcVerifier } from "./oidc.js";
import { hostIdentitySender, hostTokenSender, noSenders } from "./senders.js";

/**
 * The entry point (requirement 0002, HK2–HK7):
 * the one place the environment is read. A missing or malformed value stops
 * the start, naming the variable and never echoing a value. Nothing here
 * requires a cloud provider: each of the two choices below has a portable
 * way and a Google Cloud way, and exactly one of the two is set.
 * `docs/configuration.md` is the reference.
 *
 * - DATABASE_URL: Postgres.
 * - OIDC_ISSUER and OIDC_AUDIENCE: the provider users sign in at and this
 *   server's audience in its tokens; OIDC_ROLES_CLAIM (default `groups`)
 *   and OIDC_ADMIN_ROLE (default `agent-server-admin`) name the
 *   installation admins; TEAM_CREATION is `admins` (default) or `users`.
 * - The key that wraps the teams' keys: LOCAL_KEY (32 bytes,
 *   base64) or KMS_KEY (a Cloud KMS key; KMS_ENDPOINT /
 *   GCE_METADATA_HOST for a fake).
 * - PUBLIC_URL: this server's own address (the OAuth callback and its
 *   client ID metadata document).
 * - The host (all optional): HOST_MCP_URL, its tools, signed in to with
 *   HOST_MCP_TOKEN or HOST_MCP_AUDIENCE (a Google identity token);
 *   its triggers admitted by HOST_TOKEN or a token of HOST_ISSUER for
 *   HOST_AUDIENCE naming HOST_SUBJECT; HOST_WEBHOOK_URL, told of
 *   the work, signed with HOST_WEBHOOK_SECRET (`whsec_…`) or
 *   HOST_WEBHOOK_AUDIENCE (a Google identity token).
 * The database is migrated at every start.
 * - TEAM_IDENTITY_PROJECT (optional): the Google Cloud project
 *   holding each team's service account (`ag-<27 hex>@…`), which this
 *   service impersonates for Vertex AI, Bedrock (STS, audience
 *   AWS_STS_AUDIENCE, default sts.amazonaws.com) and Azure (Entra).
 *   Unset, only API-key profiles run; a cloud profile's run ends unfinished.
 */

function fail(message: string): never {
  console.error(`fairlead-agent-server: ${message}`);
  process.exit(1);
}

const env = process.env;

const required = (name: string): string => env[name] || fail(`${name} is required`);
const secureUrl = (name: string): string => {
  const value = required(name);
  if (!isSecureUrl(value) || value.includes("#")) fail(`${name} must be an https URL (http only on loopback) without a fragment`);
  return value;
};

const databaseUrl = required("DATABASE_URL");
if (!/^postgres(ql)?:\/\/[^\s]+$/.test(databaseUrl)) fail("DATABASE_URL must be a postgres:// URL");
/** Exactly one of a Google Cloud way and a portable way; answers which, with its value. */
const oneOf = (google: string, portable: string): { google: string } | { portable: string } => {
  const [g, p] = [env[google] || undefined, env[portable] || undefined];
  if (g !== undefined && p !== undefined) fail(`Set either ${google} or ${portable}, not both`);
  if (g !== undefined) return { google: g };
  if (p !== undefined) return { portable: p };
  return fail(`${google} or ${portable} is required`);
};
const sharedToken = (name: string, value: string): string => (/^[\x21-\x7e]{32,512}$/.test(value) ? value : fail(`${name} must be 32 to 512 printable characters without spaces`));

const keyChoice = oneOf("KMS_KEY", "LOCAL_KEY");
if ("google" in keyChoice && !KMS_CRYPTO_KEY_PATTERN.test(keyChoice.google)) fail("KMS_KEY must name a Cloud KMS crypto key (projects/…/locations/…/keyRings/…/cryptoKeys/…)");
const localKey = "portable" in keyChoice ? Buffer.from(keyChoice.portable, "base64") : undefined;
if (localKey && (localKey.length !== 32 || localKey.toString("base64") !== (keyChoice as { portable: string }).portable)) fail("LOCAL_KEY must be 32 bytes in base64");
if (env["KMS_ENDPOINT"] !== undefined) secureUrl("KMS_ENDPOINT");
const publicUrl = secureUrl("PUBLIC_URL").replace(/\/$/, "");
/** An optional pair: neither, or the URL with exactly one of its two ways. */
const optionalOneOf = (url: string, google: string, portable: string) => {
  if (!env[url]) {
    if (env[google] || env[portable]) fail(`${google} and ${portable} need ${url}`);
    return undefined;
  }
  return { url: secureUrl(url), way: oneOf(google, portable) };
};
const hostMcp = optionalOneOf("HOST_MCP_URL", "HOST_MCP_AUDIENCE", "HOST_MCP_TOKEN");
if (hostMcp && "portable" in hostMcp.way) sharedToken("HOST_MCP_TOKEN", hostMcp.way.portable);
if (hostMcp && "google" in hostMcp.way) secureUrl("HOST_MCP_AUDIENCE");
const hostWebhook = optionalOneOf("HOST_WEBHOOK_URL", "HOST_WEBHOOK_AUDIENCE", "HOST_WEBHOOK_SECRET");
if (hostWebhook && "portable" in hostWebhook.way && !WEBHOOK_SECRET.test(hostWebhook.way.portable)) fail("HOST_WEBHOOK_SECRET must be a whsec_ secret (24 or more bytes in base64)");
if (hostWebhook && "google" in hostWebhook.way) secureUrl("HOST_WEBHOOK_AUDIENCE");
const hostToken = env["HOST_TOKEN"] || undefined;
const hostIssuer = env["HOST_ISSUER"] || undefined;
if (hostToken !== undefined && hostIssuer !== undefined) fail("Set either HOST_ISSUER or HOST_TOKEN, not both");
if (hostToken !== undefined) sharedToken("HOST_TOKEN", hostToken);
if (hostIssuer === undefined && (env["HOST_AUDIENCE"] || env["HOST_SUBJECT"])) fail("HOST_AUDIENCE and HOST_SUBJECT need HOST_ISSUER");
const identityProject = env["TEAM_IDENTITY_PROJECT"] || undefined;
if (identityProject !== undefined && !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(identityProject)) fail("TEAM_IDENTITY_PROJECT must be a Google Cloud project id");
const awsAudience = env["AWS_STS_AUDIENCE"] || undefined;
if (awsAudience !== undefined && !/^[\x21-\x7e]{1,200}$/.test(awsAudience)) fail("AWS_STS_AUDIENCE must be an audience string");
const oidcIssuer = secureUrl("OIDC_ISSUER");
if (hostIssuer !== undefined) secureUrl("HOST_ISSUER");
const word = (name: string, fallback?: string): string => {
  const value = env[name] || fallback || fail(`${name} is required`);
  return /^[\x21-\x7e]{1,200}$/.test(value) ? value : fail(`${name} must be 1 to 200 printable characters without spaces`);
};
const oidcAudience = word("OIDC_AUDIENCE");
const rolesClaim = word("OIDC_ROLES_CLAIM", "groups");
const adminRole = word("OIDC_ADMIN_ROLE", "agent-server-admin");
const teamCreation = env["TEAM_CREATION"] || "admins";
if (teamCreation !== "users" && teamCreation !== "admins") fail("TEAM_CREATION must be users or admins");
const port = Number(env["PORT"] ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65_535) fail("PORT must be a port number");

const metadataHost = env["GCE_METADATA_HOST"];
const metadata = metadataHost ? { baseUrl: `http://${metadataHost}` } : {};
// Connections open at the first query, the server's own schema first in their search path.
const pool = new pg.Pool({ connectionString: databaseUrl, max: Number(env["DATABASE_POOL_SIZE"] ?? 5), ...(env["DATABASE_SSL"] === "true" ? { ssl: { rejectUnauthorized: true } } : {}) });
// Queued before the connection's first query; a failure fails that query.
pool.on("connect", (client) => void client.query(`SET search_path TO ${SERVER_SCHEMA}`).catch(() => undefined));
const db = poolDatabase(pool);
const store = new PostgresRunStore(db);
const agents = new PostgresAgentStore(db);
const connections = new PostgresConnectionStore(db);
const directory = createDirectory(db);
const sealer = createTeamSealer({
  store: new PostgresTeamKeyStore(db),
  wrapper: localKey
    ? localKeyWrapper(localKey)
    : cloudKmsKeyWrapper({ cryptoKey: (keyChoice as { google: string }).google, accessToken: metadataAccessToken(metadata), baseUrl: env["KMS_ENDPOINT"] || CLOUD_KMS_URL }),
});
const noIdentity = () => Promise.reject(new Error("No team identity configured (TEAM_IDENTITY_PROJECT)"));
const identity: TeamIdentity =
  identityProject === undefined
    ? { googleAccessToken: noIdentity, awsCredentials: noIdentity, azureAccessToken: noIdentity }
    : createTeamIdentity({ project: identityProject, runnerToken: metadataAccessToken(metadata), ...(awsAudience ? { awsAudience } : {}) });
const tokenFor = (way: { google: string } | { portable: string }) => ("portable" in way ? async () => way.portable : metadataIdentityToken(way.google, metadata));
const tools = createToolHub({ host: hostMcp && { url: hostMcp.url, token: tokenFor(hostMcp.way) }, connections, sealer });
const notifier = hostWebhook
  ? createWebhookNotifier({ url: hostWebhook.url, ...("portable" in hostWebhook.way ? { secret: hostWebhook.way.portable } : { token: tokenFor(hostWebhook.way) }) })
  : noNotifier;
const senders =
  hostToken !== undefined ? hostTokenSender(hostToken) : hostIssuer !== undefined ? hostIdentitySender({ issuer: hostIssuer, audience: word("HOST_AUDIENCE"), subject: word("HOST_SUBJECT") }) : noSenders;
const runner = createRunner({ store, agents, directory, sealer, tools, identity, notifier });
const work = createWork({ store, agents, directory, sealer, notifier });
const scheduler = createScheduler({ store, agents, directory, runner });
const verify = createOidcVerifier({ issuer: oidcIssuer, audience: oidcAudience, rolesClaim, adminRole });

const app = new Hono();
app.get("/health", (c) => c.json({ status: "ok", service: "fairlead-agent-server" }));
// After the health check: the host's triggers and the OAuth callback, then a signed-in user's calls (requirements 0003, 0004).
app.route("/", createApiApp({ directory, verify, store, agents, connections, sealer, work, senders, publicUrl }));
app.route("/", createDirectoryApp({ directory, verify, teamCreation }));

await migrateDatabase(db).catch((error: unknown) => fail(`the database could not be migrated (${error instanceof Error ? error.name : "error"})`));
console.log(`fairlead-agent-server: users sign in at ${oidcIssuer}; teams are created by ${teamCreation}; teams' keys wrapped by ${localKey ? "a local key" : "Cloud KMS"}`);
console.log(`fairlead-agent-server: host tools ${hostMcp ? `at ${hostMcp.url}` : "none"}; host triggers ${hostToken ? "by a bearer token" : hostIssuer ? `by tokens of ${hostIssuer}` : "none"}; host webhook ${hostWebhook ? hostWebhook.url : "none"}`);
console.log(identityProject === undefined ? "fairlead-agent-server: no team identities (no TEAM_IDENTITY_PROJECT): API-key profiles only" : `fairlead-agent-server: team identities in ${identityProject}`);
scheduler.start();
serve({ fetch: app.fetch, port }, (info) => console.log(`fairlead-agent-server listening on port ${info.port}`));
