import { createHash, randomBytes } from "node:crypto";
import { isSecureUrl } from "../google.js";

/**
 * Signing an agent in at a service (requirement 0004, *Connections*; the
 * MCP authorization of 2026-07-28): the service's protected resource
 * metadata names its authorization server, whose metadata (its issuer
 * checked exactly) names the endpoints. The client is one registered
 * beforehand, else this server's client ID metadata document, else one
 * registered dynamically. Authorization code with PKCE (S256) and the
 * `resource` parameter on both requests; the `iss` of the answer checked.
 */

export interface AuthorizationServer {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  clientIdMetadataDocuments: boolean;
  /** RFC 9207: the answer carries `iss`. */
  issParameter: boolean;
  scopesSupported: string[];
}

export interface Discovery {
  /** The service's canonical address, sent as `resource`. */
  resource: string;
  server: AuthorizationServer;
  /** What to ask for: the challenge's scope, else the resource's supported scopes. */
  scope: string | null;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string | null;
  /** When the access token expires; null when the server did not say. */
  expiresAt: string | null;
  scope: string | null;
}

/** Signing in cannot go on: what the service or its authorization server said, never a secret. */
export class OAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthError";
  }
}

/** The address as a resource identifier: no fragment, no trailing slash on a bare origin. */
export const canonicalResource = (value: string) => {
  const url = new URL(value);
  url.hash = "";
  return url.href.replace(/\/$/, "");
};

async function getJson(fetchImpl: typeof fetch, url: string): Promise<Record<string, unknown> | undefined> {
  if (!isSecureUrl(url)) return undefined;
  try {
    const response = await fetchImpl(url, { redirect: "error", headers: { Accept: "application/json" } });
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    const body = (await response.json()) as unknown;
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const strings = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/** The service's authorization server, from the challenge's metadata address or the well-known ones. */
export async function discover(serviceUrl: string, challenge: { resourceMetadata?: string; scope?: string } = {}, fetchImpl: typeof fetch = fetch): Promise<Discovery> {
  const url = new URL(serviceUrl);
  const path = url.pathname.replace(/\/$/, "");
  const candidates = [challenge.resourceMetadata, `${url.origin}/.well-known/oauth-protected-resource${path}`, `${url.origin}/.well-known/oauth-protected-resource`].filter(
    (candidate): candidate is string => candidate !== undefined,
  );
  let metadata: Record<string, unknown> | undefined;
  for (const candidate of candidates) if ((metadata = await getJson(fetchImpl, candidate))) break;
  if (!metadata) throw new OAuthError("The service publishes no protected resource metadata");
  const resource = canonicalResource(serviceUrl);
  if (typeof metadata["resource"] !== "string" || canonicalResource(metadata["resource"]) !== resource) throw new OAuthError("The service's metadata names another resource");
  const issuer = strings(metadata["authorization_servers"])[0];
  if (!issuer || !isSecureUrl(issuer)) throw new OAuthError("The service names no authorization server");

  const base = new URL(issuer);
  const issuerPath = base.pathname.replace(/\/$/, "");
  const wellKnown = issuerPath
    ? [`${base.origin}/.well-known/oauth-authorization-server${issuerPath}`, `${base.origin}/.well-known/openid-configuration${issuerPath}`, `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`]
    : [`${base.origin}/.well-known/oauth-authorization-server`, `${base.origin}/.well-known/openid-configuration`];
  let server: Record<string, unknown> | undefined;
  for (const candidate of wellKnown) if ((server = await getJson(fetchImpl, candidate))) break;
  if (!server || server["issuer"] !== issuer) throw new OAuthError("The authorization server's metadata is missing or names another issuer");
  const authorizationEndpoint = server["authorization_endpoint"];
  const tokenEndpoint = server["token_endpoint"];
  if (typeof authorizationEndpoint !== "string" || typeof tokenEndpoint !== "string" || !isSecureUrl(authorizationEndpoint) || !isSecureUrl(tokenEndpoint))
    throw new OAuthError("The authorization server names no usable endpoints");
  if (!strings(server["code_challenge_methods_supported"]).includes("S256")) throw new OAuthError("The authorization server does not offer PKCE with S256");
  const registration = typeof server["registration_endpoint"] === "string" && isSecureUrl(server["registration_endpoint"]) ? server["registration_endpoint"] : null;
  const scopes = strings(metadata["scopes_supported"]);
  return {
    resource,
    scope: challenge.scope ?? (scopes.length > 0 ? scopes.join(" ") : null),
    server: {
      issuer,
      authorizationEndpoint,
      tokenEndpoint,
      registrationEndpoint: registration,
      clientIdMetadataDocuments: server["client_id_metadata_document_supported"] === true,
      issParameter: server["authorization_response_iss_parameter_supported"] === true,
      scopesSupported: strings(server["scopes_supported"]),
    },
  };
}

/** This server's client ID metadata document: its address is the client id. */
export const clientMetadata = (clientId: string, redirectUri: string) => ({
  client_id: clientId,
  client_name: "Agent server",
  redirect_uris: [redirectUri],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
});

/** The client to sign in with: the one registered beforehand, else the metadata document, else one registered now. */
export async function clientFor(
  server: AuthorizationServer,
  { registered, metadataUrl, redirectUri }: { registered: { clientId: string; clientSecret: string | null } | null; metadataUrl: string; redirectUri: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ clientId: string; clientSecret: string | null }> {
  if (registered) return registered;
  if (server.clientIdMetadataDocuments) return { clientId: metadataUrl, clientSecret: null };
  if (!server.registrationEndpoint) throw new OAuthError("The authorization server takes no client this server can be");
  const response = await fetchImpl(server.registrationEndpoint, {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ ...clientMetadata("", redirectUri), client_id: undefined, application_type: "web" }),
  }).catch(() => undefined);
  const body = response?.ok ? ((await response.json().catch(() => ({}))) as { client_id?: unknown; client_secret?: unknown }) : {};
  if (typeof body.client_id !== "string") throw new OAuthError("The authorization server did not register a client");
  return { clientId: body.client_id, clientSecret: typeof body.client_secret === "string" ? body.client_secret : null };
}

/** The address a person opens to sign in, with the PKCE verifier and state to keep until the callback. */
export function authorizationRequest(discovery: Discovery, { clientId, redirectUri }: { clientId: string; redirectUri: string }) {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const url = new URL(discovery.server.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", discovery.resource);
  if (discovery.scope) url.searchParams.set("scope", discovery.scope);
  return { url: url.href, verifier, state };
}

/** RFC 9207: an answer's `iss` must be the issuer's; a server that promised it must send it. */
export function checkIssuer(server: Pick<AuthorizationServer, "issuer" | "issParameter">, iss: string | undefined) {
  if (iss !== undefined ? iss !== server.issuer : server.issParameter) throw new OAuthError("The answer came from another issuer");
}

async function tokenRequest(tokenEndpoint: string, form: Record<string, string>, clientSecret: string | null, fetchImpl: typeof fetch, now: Date): Promise<Tokens> {
  const response = await fetchImpl(tokenEndpoint, {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(clientSecret ? { ...form, client_secret: clientSecret } : form).toString(),
  }).catch(() => undefined);
  if (!response) throw new OAuthError("The authorization server did not answer");
  const body = (await response.json().catch(() => ({}))) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown; error?: unknown };
  if (!response.ok || typeof body.access_token !== "string") throw new OAuthError(`The authorization server refused the token request${typeof body.error === "string" ? ` (${body.error})` : ""}`);
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
    expiresAt: typeof body.expires_in === "number" ? new Date(now.getTime() + body.expires_in * 1000).toISOString() : null,
    scope: typeof body.scope === "string" ? body.scope : null,
  };
}

export function exchangeCode(
  { tokenEndpoint, code, verifier, clientId, clientSecret, redirectUri, resource }: { tokenEndpoint: string; code: string; verifier: string; clientId: string; clientSecret: string | null; redirectUri: string; resource: string },
  fetchImpl: typeof fetch = fetch,
  now = new Date(),
) {
  return tokenRequest(tokenEndpoint, { grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: redirectUri, resource }, clientSecret, fetchImpl, now);
}

export function refreshTokens(
  { tokenEndpoint, refreshToken, clientId, clientSecret, resource }: { tokenEndpoint: string; refreshToken: string; clientId: string; clientSecret: string | null; resource: string },
  fetchImpl: typeof fetch = fetch,
  now = new Date(),
) {
  return tokenRequest(tokenEndpoint, { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, resource }, clientSecret, fetchImpl, now);
}
