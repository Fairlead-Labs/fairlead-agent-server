import { createHash } from "node:crypto";
import type { TeamIdentity } from "../model/profile.js";
import type { AwsCredentials } from "../model/sigv4.js";

/**
 * Test support (RN18's federation): each team's own cloud identity. A
 * Google token, Azure token and AWS key are derived from the team alone
 * (`googleTokenOf`, `azureTokenOf`, `awsKeyOf` for the fakes' admission
 * rules). An AWS role trusts one team's external id (`awsRoles`: role ARN →
 * team); assuming it as any other team is refused, as STS refuses a wrong
 * external id. `calls` records each request for an identity.
 */
export interface FakeTeamIdentity extends TeamIdentity {
  readonly awsRoles: Map<string, string>;
  readonly calls: { kind: "google" | "aws" | "azure"; teamId: string; target?: string }[];
  googleTokenOf(teamId: string): string;
  azureTokenOf(teamId: string): string;
  awsKeyOf(teamId: string): AwsCredentials;
}

export class AssumeRoleDenied extends Error {
  constructor() {
    super("AccessDenied: not authorized to perform sts:AssumeRole");
    this.name = "AssumeRoleDenied";
  }
}

const tag = (teamId: string) => createHash("sha256").update(teamId).digest("hex").slice(0, 16).toUpperCase();

export function fakeTeamIdentity(): FakeTeamIdentity {
  const identity: FakeTeamIdentity = {
    awsRoles: new Map(),
    calls: [],
    googleTokenOf: (teamId) => `ya29.team-${tag(teamId)}`,
    azureTokenOf: (teamId) => `eyJ.team-${tag(teamId)}`,
    awsKeyOf: (teamId) => ({ accessKeyId: `ASIA${tag(teamId)}`, secretAccessKey: `secret-${tag(teamId)}`, sessionToken: `session-${tag(teamId)}` }),
    async googleAccessToken(teamId) {
      identity.calls.push({ kind: "google", teamId });
      return identity.googleTokenOf(teamId);
    },
    async awsCredentials(teamId, roleArn) {
      identity.calls.push({ kind: "aws", teamId, target: roleArn });
      if (identity.awsRoles.get(roleArn) !== teamId) throw new AssumeRoleDenied();
      return identity.awsKeyOf(teamId);
    },
    async azureAccessToken(teamId, tenantId) {
      identity.calls.push({ kind: "azure", teamId, target: tenantId });
      return identity.azureTokenOf(teamId);
    },
  };
  return identity;
}
