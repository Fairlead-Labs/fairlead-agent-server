import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Test support (RN18's federation in production's shape): Google's IAM
 * Credentials, AWS STS and Entra's token endpoint on one loopback server.
 * IAM Credentials admits only `runnerToken` and only for the accounts in
 * `accounts` (the operator created them and let the runner impersonate
 * them); an ID token names the account's unique id as `sub`. STS assumes a
 * role only for the `sub` its trust policy names (`roles`: ARN → sub) and
 * the `aud` given; Entra issues a token only for an app whose federated
 * credential names that `sub` (`apps`: client id → sub). `requests` records
 * each one (path and form, no secret is checked against a log).
 */
export interface FakeFederation {
  readonly url: string;
  readonly runnerToken: string;
  readonly accounts: Set<string>;
  readonly roles: Map<string, { sub: string; aud: string }>;
  readonly apps: Map<string, string>;
  readonly requests: { path: string; authorization?: string; form?: Record<string, string>; body?: unknown }[];
  /** The account's unique id (the `sub` of its ID tokens). */
  subOf(account: string): string;
  accessTokenOf(account: string): string;
  close(): Promise<void>;
}

const read = (request: IncomingMessage) =>
  new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
const digits = (value: string) => BigInt(`0x${createHash("sha256").update(value).digest("hex").slice(0, 15)}`).toString();
const jwt = (payload: object) => `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.c2ln`;
const claims = (token: string) => {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { sub?: string; aud?: string; email?: string };
  } catch {
    return {};
  }
};

export async function startFakeFederation(): Promise<FakeFederation> {
  const fake = {
    runnerToken: "ya29.runner",
    accounts: new Set<string>(),
    roles: new Map<string, { sub: string; aud: string }>(),
    apps: new Map<string, string>(),
    requests: [] as FakeFederation["requests"],
    subOf: (account: string) => `1${digits(account)}`,
    accessTokenOf: (account: string) => `ya29.team-${digits(account)}`,
  };
  const server = createServer((incoming, outgoing) => {
    void read(incoming).then((raw) => {
      const path = incoming.url ?? "";
      const reply = (status: number, body: string, type = "application/json") => {
        outgoing.writeHead(status, { "content-type": type });
        outgoing.end(body);
      };
      const iam = path.match(/^\/v1\/projects\/-\/serviceAccounts\/([^/:]+):(generateAccessToken|generateIdToken)$/);
      if (iam) {
        const account = decodeURIComponent(iam[1]!);
        const body = raw === "" ? {} : (JSON.parse(raw) as { audience?: string; scope?: string[] });
        fake.requests.push({ path, ...(incoming.headers.authorization ? { authorization: incoming.headers.authorization } : {}), body });
        if (incoming.headers.authorization !== `Bearer ${fake.runnerToken}`) return reply(401, '{"error":{"status":"UNAUTHENTICATED"}}');
        if (!fake.accounts.has(account)) return reply(403, '{"error":{"status":"PERMISSION_DENIED"}}');
        const exp = Math.floor(Date.now() / 1000) + 3600;
        if (iam[2] === "generateAccessToken") return reply(200, JSON.stringify({ accessToken: fake.accessTokenOf(account), expireTime: new Date(exp * 1000).toISOString() }));
        return reply(200, JSON.stringify({ token: jwt({ iss: "https://accounts.google.com", sub: fake.subOf(account), aud: body.audience, email: account, exp }) }));
      }
      const form = Object.fromEntries(new URLSearchParams(raw));
      fake.requests.push({ path, form });
      if (path === "/" && form["Action"] === "AssumeRoleWithWebIdentity") {
        const token = claims(form["WebIdentityToken"] ?? "");
        const trust = fake.roles.get(form["RoleArn"] ?? "");
        if (!trust || trust.sub !== token.sub || trust.aud !== token.aud) {
          return reply(403, "<ErrorResponse><Error><Code>AccessDenied</Code></Error></ErrorResponse>", "text/xml");
        }
        const key = `ASIA${digits(token.sub!).slice(0, 16)}`;
        return reply(
          200,
          `<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult><Credentials><AccessKeyId>${key}</AccessKeyId><SecretAccessKey>secret-${key}</SecretAccessKey><SessionToken>session-${key}</SessionToken><Expiration>${new Date(Date.now() + 900_000).toISOString()}</Expiration></Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`,
          "text/xml",
        );
      }
      const entra = path.match(/^\/([0-9a-f-]{36})\/oauth2\/v2\.0\/token$/);
      if (entra) {
        const token = claims(form["client_assertion"] ?? "");
        if (form["client_assertion_type"] !== "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" || token.aud !== "api://AzureADTokenExchange" || fake.apps.get(form["client_id"] ?? "") !== token.sub) {
          return reply(401, '{"error":"invalid_client"}');
        }
        return reply(200, JSON.stringify({ access_token: `eyJ.azure-${token.sub}`, expires_in: 3600, token_type: "Bearer" }));
      }
      reply(404, "{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { ...fake, url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))) };
}
