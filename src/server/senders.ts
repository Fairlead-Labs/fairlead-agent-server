import { timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

/**
 * Who may send triggers (requirement 0002, *The server's callers*; ADR
 * 0006): a port answering which teams a credential may send for. The
 * host is one adapter, admitted for every team by its own credential: a
 * token of a configured OIDC issuer for a configured audience and subject,
 * or a configured bearer token. A credential per team is a later adapter
 * of the same port.
 */
export interface TriggerSenders {
  /** The teams the `Authorization` header's credential may send for; undefined when it is no sender's. */
  admit(authorization: string | undefined): Promise<{ teams: "any" | readonly string[] } | undefined>;
}

export const noSenders: TriggerSenders = { admit: async () => undefined };

const bearer = (authorization: string | undefined) => {
  const [scheme, token, rest] = (authorization ?? "").split(" ");
  return scheme === "Bearer" && token && rest === undefined ? token : undefined;
};

/** The host by a configured bearer token. */
export function hostTokenSender(token: string): TriggerSenders {
  const expected = Buffer.from(token);
  return {
    async admit(authorization) {
      const given = Buffer.from(bearer(authorization) ?? "");
      return given.length === expected.length && timingSafeEqual(given, expected) ? { teams: "any" } : undefined;
    },
  };
}

/**
 * The host by a token of its workload identity: signed by the configured
 * issuer (keys from its discovery document), for the audience, its `sub`
 * (or verified `email`) the configured subject.
 */
export function hostIdentitySender({ issuer, audience, subject, fetch: fetchImpl = fetch }: { issuer: string; audience: string; subject: string; fetch?: typeof fetch }): TriggerSenders {
  let keys: Promise<JWTVerifyGetKey> | undefined;
  const discover = async () => {
    const response = await fetchImpl(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`, { redirect: "error" });
    const document = response.ok ? ((await response.json()) as { issuer?: unknown; jwks_uri?: unknown }) : undefined;
    if (document?.issuer !== issuer || typeof document.jwks_uri !== "string") throw new Error("No keys");
    return createRemoteJWKSet(new URL(document.jwks_uri));
  };
  return {
    async admit(authorization) {
      const token = bearer(authorization);
      if (!token) return undefined;
      keys ??= discover().catch((error: unknown) => {
        keys = undefined;
        throw error;
      });
      try {
        const { payload } = await jwtVerify(token, await keys, { issuer, audience, algorithms: ["RS256", "ES256", "PS256", "EdDSA"], requiredClaims: ["exp"], clockTolerance: 30 });
        const named = payload.sub === subject || (payload["email"] === subject && payload["email_verified"] === true);
        return named ? { teams: "any" } : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
