import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { isSecureUrl } from "../google.js";

/** Who a token says its bearer is. `email` only when the provider verified it. */
export interface Caller {
  issuer: string;
  subject: string;
  email: string | null;
  /** The installation admin role, read from this token and never stored. */
  admin: boolean;
}

/** The provider could not be asked for its keys: nobody is let in, and it is not the caller's fault. */
export class SignInUnavailableError extends Error {
  constructor() {
    super("Sign-in unavailable");
    this.name = "SignInUnavailableError";
  }
}

export interface OidcConfig {
  /** The provider's issuer, exactly as its tokens and its discovery document spell it. */
  issuer: string;
  /** This server's audience: a token minted for anything else is refused. */
  audience: string;
  /** The claim holding the bearer's roles (an array of strings), e.g. `groups`. */
  rolesClaim: string;
  adminRole: string;
}

const ALGORITHMS = ["RS256", "ES256", "PS256", "EdDSA"];

/**
 * Verifies a bearer token of any standard OIDC provider (requirement 0003,
 * D10): its keys come from the provider's discovery document, read at the
 * first token and kept. Answers the caller, or undefined for a token that
 * does not pass (never saying why).
 */
export function createOidcVerifier({ issuer, audience, rolesClaim, adminRole }: OidcConfig): (token: string) => Promise<Caller | undefined> {
  let keys: Promise<JWTVerifyGetKey> | undefined;
  const discover = async (): Promise<JWTVerifyGetKey> => {
    const response = await fetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`, { redirect: "error" });
    const document = response.ok ? ((await response.json()) as { issuer?: unknown; jwks_uri?: unknown }) : undefined;
    if (document?.issuer !== issuer || typeof document.jwks_uri !== "string" || !isSecureUrl(document.jwks_uri)) throw new SignInUnavailableError();
    return createRemoteJWKSet(new URL(document.jwks_uri));
  };
  return async (token) => {
    keys ??= discover().catch((error: unknown) => {
      keys = undefined;
      throw error instanceof SignInUnavailableError ? error : new SignInUnavailableError();
    });
    const getKey = await keys;
    try {
      const { payload } = await jwtVerify(token, getKey, { issuer, audience, algorithms: ALGORITHMS, requiredClaims: ["exp", "sub"], clockTolerance: 30 });
      if (!payload.sub) return undefined;
      const roles = payload[rolesClaim];
      return {
        issuer,
        subject: payload.sub,
        email: payload["email_verified"] === true && typeof payload["email"] === "string" ? payload["email"] : null,
        admin: Array.isArray(roles) && roles.includes(adminRole),
      };
    } catch (error) {
      // The provider's keys not reachable is an outage, not a bad token.
      if (error instanceof Error && "code" in error && (error.code === "ERR_JWKS_TIMEOUT" || error.code === "ERR_JOSE_GENERIC")) throw new SignInUnavailableError();
      return undefined;
    }
  };
}
