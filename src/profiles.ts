import type { SealedValue } from "./keys.js";
import type { Effort, ModelTarget } from "./model/index.js";

/**
 * Model profiles (requirement 0001, *Model profiles*; requirement 0004):
 * the records and the model target they name. A profile names
 * where the model runs; an API key is sealed under the team key
 * and never shown again, a cloud route names no credential at all (the
 * team's own identity reaches it, `TeamIdentity`).
 */

export const PROFILE_PROVIDERS = ["claude-api", "vertex", "bedrock", "openai", "azure-openai"] as const;
export type ProfileProvider = (typeof PROFILE_PROVIDERS)[number];

/** What a profile holds besides its key. Fields a provider does not use are null. */
export interface ProfileSettings {
  name: string;
  provider: ProfileProvider;
  model: string;
  effort: Effort | null;
  /** Anthropic's paid cache window (`5m` the default); null on OpenAI's routes. */
  cacheWindow: "5m" | "1h" | null;
  /** Vertex AI's location (`eu`, `us`, `global` or a region), Bedrock's region, or OpenAI's data residency (`eu`, null for the default). */
  region: string | null;
  /** Vertex AI: the team's own Google Cloud project. */
  project: string | null;
  /** Bedrock: the team's role that trusts its cloud identity. */
  roleArn: string | null;
  /** Azure OpenAI: the team's resource. */
  endpoint: string | null;
  /** Azure OpenAI by federation: the team's Entra tenant and app; null with an API key. */
  tenantId: string | null;
  clientId: string | null;
}

export interface Profile extends ProfileSettings {
  id: string;
  teamId: string;
  /** The user whose own profile it is, for their personal agents only; null for the team's (requirement 0004, *Model profiles*). */
  ownerUserId: string | null;
  /** Sealed under the team key (`model-key`); null on a federated route. */
  apiKey: SealedValue | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

/** The runner's target for a profile, its API key opened. */
export function modelTargetOf(profile: ProfileSettings, apiKey: string | undefined): ModelTarget | undefined {
  switch (profile.provider) {
    case "claude-api":
      return apiKey === undefined ? undefined : { provider: "claude-api", model: profile.model, apiKey };
    case "openai":
      return apiKey === undefined ? undefined : { provider: "openai", model: profile.model, apiKey, ...(profile.region === "eu" ? { baseUrl: "https://eu.api.openai.com" } : {}) };
    case "vertex":
      return profile.project && profile.region ? { provider: "vertex", model: profile.model, project: profile.project, region: profile.region } : undefined;
    case "bedrock":
      return profile.region && profile.roleArn ? { provider: "bedrock", model: profile.model, region: profile.region, roleArn: profile.roleArn } : undefined;
    case "azure-openai": {
      if (!profile.endpoint) return undefined;
      if (profile.tenantId && profile.clientId) return { provider: "azure-openai", model: profile.model, endpoint: profile.endpoint, auth: { tenantId: profile.tenantId, clientId: profile.clientId } };
      return apiKey === undefined ? undefined : { provider: "azure-openai", model: profile.model, endpoint: profile.endpoint, auth: { apiKey } };
    }
  }
}
