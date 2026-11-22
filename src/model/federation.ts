import { createHash } from "node:crypto";
import type { TeamIdentity } from "./profile.js";
import type { AwsCredentials } from "./sigv4.js";

/**
 * Each team's own cloud identity in production (requirement 0001, RN18;
 * ADR 0001 §9): one Google service account per team, which the runner's
 * own service account impersonates through IAM Credentials. It reaches:
 *
 * - Vertex AI as itself (`generateAccessToken`): the team grants it
 *   `roles/aiplatform.user` in its own project;
 * - Bedrock by STS `AssumeRoleWithWebIdentity` with its Google ID token: the
 *   team's role trusts `accounts.google.com` with `aud` the configured
 *   audience and `sub` the team account's unique id, which stands in for an
 *   external id (STS's web-identity call takes none);
 * - Azure OpenAI by Entra workload identity federation: its Google ID token
 *   as the client assertion for the team's app, whose federated credential
 *   names issuer `https://accounts.google.com` and that same `sub`.
 *
 * A profile chooses nothing of the identity: the account comes from the
 * team id alone, so a profile naming another team's project, role or app
 * fails there. Tokens are cached per team until a minute before they end.
 */

export interface TeamIdentityConfig {
  /** The Google Cloud project holding the teams' service accounts (`TEAM_IDENTITY_PROJECT`). */
  project: string;
  /** The runner's own access token (the metadata server's), which may create tokens for the teams' accounts. */
  runnerToken: () => Promise<string>;
  /** The audience of the ID token handed to STS (the team's role trusts it); default `sts.amazonaws.com`. */
  awsAudience?: string;
  /** Fakes only: IAM Credentials', STS's and Entra's addresses. */
  iamCredentialsUrl?: string;
  stsUrl?: string;
  entraUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/** The team's service account's id: `ag-` and 27 hex characters of the team id's SHA-256 (a Google account id is 6–30 lower-case characters). */
export const teamServiceAccountId = (teamId: string): string => `ag-${createHash("sha256").update(teamId, "utf8").digest("hex").slice(0, 27)}`;

/** Its email, as the operator creates it and the team grants it. */
export const teamServiceAccount = (teamId: string, project: string): string => `${teamServiceAccountId(teamId)}@${project}.iam.gserviceaccount.com`;

export class TeamIdentityError extends Error {
  constructor(step: string, status?: number) {
    super(`The team's identity was refused at ${step}${status === undefined ? "" : ` (${status})`}`);
    this.name = "TeamIdentityError";
  }
}

const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const AZURE_SCOPE = "https://cognitiveservices.azure.com/.default";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const tag = (xml: string, name: string) => xml.match(new RegExp(`<${name}>([^<]+)</${name}>`))?.[1];

export function createTeamIdentity({
  project,
  runnerToken,
  awsAudience = "sts.amazonaws.com",
  iamCredentialsUrl = "https://iamcredentials.googleapis.com",
  stsUrl = "https://sts.amazonaws.com",
  entraUrl = "https://login.microsoftonline.com",
  fetch: fetchImpl = fetch,
  now = Date.now,
}: TeamIdentityConfig): TeamIdentity & { serviceAccount(teamId: string): string } {
  const cache = new Map<string, { value: unknown; until: number }>();
  const cached = async <T>(key: string, load: () => Promise<{ value: T; until: number }>): Promise<T> => {
    const hit = cache.get(key);
    if (hit && now() < hit.until) return hit.value as T;
    const loaded = await load();
    cache.set(key, { value: loaded.value, until: loaded.until - 60_000 });
    return loaded.value;
  };

  const iam = async (teamId: string, method: "generateAccessToken" | "generateIdToken", body: object) => {
    const account = encodeURIComponent(teamServiceAccount(teamId, project));
    const response = await fetchImpl(`${iamCredentialsUrl}/v1/projects/-/serviceAccounts/${account}:${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${await runnerToken()}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new TeamIdentityError(`IAM Credentials ${method}`, response.status);
    }
    return (await response.json()) as Record<string, unknown>;
  };

  const idToken = (teamId: string, audience: string) =>
    cached(`id ${teamId} ${audience}`, async () => {
      const { token } = await iam(teamId, "generateIdToken", { audience, includeEmail: true });
      if (typeof token !== "string") throw new TeamIdentityError("IAM Credentials generateIdToken");
      const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8") || "{}") as { exp?: unknown };
      return { value: token, until: typeof payload.exp === "number" ? payload.exp * 1000 : now() + 300_000 };
    });

  return {
    serviceAccount: (teamId) => teamServiceAccount(teamId, project),

    googleAccessToken: (teamId) =>
      cached(`google ${teamId}`, async () => {
        const { accessToken, expireTime } = await iam(teamId, "generateAccessToken", { scope: [SCOPE], lifetime: "900s" });
        if (typeof accessToken !== "string") throw new TeamIdentityError("IAM Credentials generateAccessToken");
        return { value: accessToken, until: typeof expireTime === "string" ? Date.parse(expireTime) : now() + 300_000 };
      }),

    awsCredentials: (teamId, roleArn) =>
      cached(`aws ${teamId} ${roleArn}`, async () => {
        const form = new URLSearchParams({
          Action: "AssumeRoleWithWebIdentity",
          Version: "2011-06-15",
          RoleArn: roleArn,
          RoleSessionName: teamServiceAccountId(teamId),
          WebIdentityToken: await idToken(teamId, awsAudience),
          DurationSeconds: "900",
        });
        const response = await fetchImpl(stsUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form, signal: AbortSignal.timeout(10_000) });
        const xml = await response.text();
        if (!response.ok) throw new TeamIdentityError("STS AssumeRoleWithWebIdentity", response.status);
        const accessKeyId = tag(xml, "AccessKeyId");
        const secretAccessKey = tag(xml, "SecretAccessKey");
        const sessionToken = tag(xml, "SessionToken");
        const expiration = tag(xml, "Expiration");
        if (!accessKeyId || !secretAccessKey || !sessionToken) throw new TeamIdentityError("STS AssumeRoleWithWebIdentity");
        const value: AwsCredentials = { accessKeyId, secretAccessKey, sessionToken };
        return { value, until: expiration ? Date.parse(expiration) : now() + 300_000 };
      }),

    azureAccessToken: (teamId, tenantId, clientId) => {
      if (!GUID.test(tenantId) || !GUID.test(clientId)) return Promise.reject(new TeamIdentityError("Entra (tenant or client id)"));
      return cached(`azure ${teamId} ${tenantId} ${clientId}`, async () => {
        const form = new URLSearchParams({
          grant_type: "client_credentials",
          client_id: clientId,
          scope: AZURE_SCOPE,
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: await idToken(teamId, "api://AzureADTokenExchange"),
        });
        const response = await fetchImpl(`${entraUrl}/${tenantId}/oauth2/v2.0/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form, signal: AbortSignal.timeout(10_000) });
        if (!response.ok) {
          await response.body?.cancel();
          throw new TeamIdentityError("Entra token", response.status);
        }
        const { access_token, expires_in } = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
        if (typeof access_token !== "string") throw new TeamIdentityError("Entra token");
        return { value: access_token, until: now() + (typeof expires_in === "number" ? expires_in : 300) * 1000 };
      });
    },
  };
}
