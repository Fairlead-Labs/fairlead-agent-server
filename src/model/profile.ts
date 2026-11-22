import { createAnthropicClient } from "./anthropic.js";
import { createOpenAIClient } from "./openai.js";
import type { AwsCredentials } from "./sigv4.js";
import type { ModelClient } from "./types.js";

/**
 * Requirement 0001, *Model profiles* (RN18): a cloud account is reached as
 * the team's **own** cloud identity, never a shared one, so a profile
 * naming another team's project, role or resource fails there. The port
 * takes the team and nothing from the profile that could choose the
 * identity: Vertex AI a service account per team (impersonated), Bedrock
 * the team's role assumed with the team's external id, Azure the team's
 * federated credential.
 */
export interface TeamIdentity {
  googleAccessToken(teamId: string): Promise<string>;
  awsCredentials(teamId: string, roleArn: string): Promise<AwsCredentials>;
  azureAccessToken(teamId: string, tenantId: string, clientId: string): Promise<string>;
}

/** Where a profile's model runs. An API key is the opened one (sealed under the team key at rest). */
export type ModelTarget =
  | { readonly provider: "claude-api"; readonly model: string; readonly apiKey: string; readonly baseUrl?: string }
  | { readonly provider: "vertex"; readonly model: string; readonly project: string; readonly region: string; readonly baseUrl?: string }
  | { readonly provider: "bedrock"; readonly model: string; readonly region: string; readonly roleArn: string; readonly baseUrl?: string }
  | { readonly provider: "openai"; readonly model: string; readonly apiKey: string; readonly baseUrl?: string }
  | {
      readonly provider: "azure-openai";
      readonly model: string;
      readonly endpoint: string;
      readonly auth: { readonly apiKey: string } | { readonly tenantId: string; readonly clientId: string };
    };

export interface ClientContext {
  readonly teamId: string;
  readonly identity: TeamIdentity;
  readonly mintCallId?: () => string;
  /** OpenAI's `prompt_cache_key`: the run's id. */
  readonly cacheKey?: string;
  readonly cacheTtl?: "5m" | "1h";
}

/** One run's client: one model, one provider, signed in as the team (RN18). */
export function createModelClient(target: ModelTarget, { teamId, identity, mintCallId, cacheKey, cacheTtl }: ClientContext): ModelClient {
  const shared = { model: target.model, ...(mintCallId ? { mintCallId } : {}) };
  const anthropic = { ...shared, ...(cacheTtl ? { cacheTtl } : {}) };
  const openai = { ...shared, ...(cacheKey ? { cacheKey } : {}) };
  const base = "baseUrl" in target && target.baseUrl ? { baseUrl: target.baseUrl } : {};
  switch (target.provider) {
    case "claude-api":
      return createAnthropicClient({ ...anthropic, route: { kind: "claude-api", apiKey: target.apiKey, ...base } });
    case "vertex":
      return createAnthropicClient({
        ...anthropic,
        route: { kind: "vertex", project: target.project, region: target.region, accessToken: () => identity.googleAccessToken(teamId), ...base },
      });
    case "bedrock":
      return createAnthropicClient({
        ...anthropic,
        route: { kind: "bedrock", region: target.region, credentials: () => identity.awsCredentials(teamId, target.roleArn), ...base },
      });
    case "openai":
      return createOpenAIClient({ ...openai, route: { kind: "openai", apiKey: target.apiKey, ...base } });
    case "azure-openai": {
      const auth = target.auth;
      return createOpenAIClient({
        ...openai,
        route: {
          kind: "azure",
          endpoint: target.endpoint,
          auth: "apiKey" in auth ? { apiKey: auth.apiKey } : { accessToken: () => identity.azureAccessToken(teamId, auth.tenantId, auth.clientId) },
        },
      });
    }
  }
}
