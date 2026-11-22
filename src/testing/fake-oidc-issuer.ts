import { generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** A loopback OIDC issuer: its discovery document, its keys, and RS256 tokens signed with them. Sign-in pages are not its job. */
export interface FakeOidcIssuer {
  /** `http://127.0.0.1:<port>`, also the tokens' `iss`. */
  readonly url: string;
  /** How often its discovery document was read. */
  discoveries: number;
  /** Answer discovery with this status instead (an outage). */
  down?: number;
  /** A signed token: `iss`, `iat` and an hour's `exp` unless the claims say otherwise. */
  token(claims: Record<string, unknown>): string;
  /** The same claims signed by a key the issuer does not publish. */
  forged(claims: Record<string, unknown>): string;
  close(): Promise<void>;
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

export async function startFakeOidcIssuer(): Promise<FakeOidcIssuer> {
  const [own, other] = [generateKeyPairSync("rsa", { modulusLength: 2048 }), generateKeyPairSync("rsa", { modulusLength: 2048 })];
  const server = createServer((request, response) => {
    const json = (status: number, body: unknown) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (request.url === "/.well-known/openid-configuration") {
      issuer.discoveries += 1;
      return issuer.down ? json(issuer.down, {}) : json(200, { issuer: issuer.url, jwks_uri: `${issuer.url}/keys` });
    }
    if (request.url === "/keys") return json(200, { keys: [{ ...own.publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" }] });
    return json(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const signed = (key: typeof own.privateKey, claims: Record<string, unknown>) => {
    const at = Math.floor(Date.now() / 1000);
    const input = `${b64({ alg: "RS256", kid: "k1", typ: "JWT" })}.${b64({ iss: issuer.url, iat: at, exp: at + 3600, ...claims })}`;
    return `${input}.${sign("sha256", Buffer.from(input), key).toString("base64url")}`;
  };
  const issuer: FakeOidcIssuer = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    discoveries: 0,
    token: (claims) => signed(own.privateKey, claims),
    forged: (claims) => signed(other.privateKey, claims),
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
  return issuer;
}
