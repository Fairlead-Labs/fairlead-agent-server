import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createModelClient, createTeamIdentity, ModelHttpError, teamServiceAccount, teamServiceAccountId, TeamIdentityError, type ModelRequest, type ModelTarget } from "../../src/index.js";
import {
  AssumeRoleDenied,
  fakeTeamIdentity,
  startFakeAnthropic,
  startFakeFederation,
  startFakeOpenAI,
  type FakeAnthropic,
  type FakeFederation,
  type FakeOpenAI,
  type FakeTeamIdentity,
} from "../../src/testing/index.js";

/**
 * Requirement 0001, RN18 (federation), *Model profiles*: a cloud
 * account is reached as the team's own cloud identity, chosen by the
 * team and never by the profile, so a profile naming another team's Vertex
 * project, Bedrock role or Azure resource fails there.
 */
let anthropic: FakeAnthropic;
let openai: FakeOpenAI;
let identity: FakeTeamIdentity;

const ROLE_A = "arn:aws:iam::111111111111:role/fairlead-agent-server";
const ROLE_B = "arn:aws:iam::222222222222:role/fairlead-agent-server";

beforeAll(async () => {
  anthropic = await startFakeAnthropic();
  openai = await startFakeOpenAI();
  identity = fakeTeamIdentity();
  // Each team granted its own identity in its own project, role and resource.
  anthropic.vertexAdmits = (project, token) => token === identity.googleTokenOf(project === "team-a-vertex" ? "team-a" : "team-b");
  identity.awsRoles.set(ROLE_A, "team-a").set(ROLE_B, "team-b");
  for (const team of ["team-a", "team-b"]) anthropic.awsSecrets.set(identity.awsKeyOf(team).accessKeyId, identity.awsKeyOf(team).secretAccessKey);
  openai.azureAdmits = (token) => token === identity.azureTokenOf("team-a");
});
afterAll(async () => {
  await anthropic.close();
  await openai.close();
});

const request: ModelRequest = { system: ["System."], messages: [{ role: "user", content: [{ type: "text", text: "Hello." }] }], tools: [], maxOutputTokens: 1000 };
const ANSWER = { type: "message", role: "assistant", content: [{ type: "text", text: "Hi." }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 1 } };
const RESPONSE = { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Hi." }] }], usage: { input_tokens: 3, output_tokens: 1 } };

const vertex = (project: string): ModelTarget => ({ provider: "vertex", model: "claude-opus-5-5", project, region: "eu", baseUrl: anthropic.url });
const bedrock = (roleArn: string): ModelTarget => ({ provider: "bedrock", model: "eu.anthropic.claude-opus-5-5", region: "eu-central-1", roleArn, baseUrl: anthropic.url });
const azure = (): ModelTarget => ({ provider: "azure-openai", model: "gpt-6-1-dz", endpoint: openai.url, auth: { tenantId: "tenant-a", clientId: "app-a" } });

const as = (teamId: string, target: ModelTarget) => createModelClient(target, { teamId, identity });
const failure = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error);

describe("each team reaches its cloud account as its own identity", () => {
  it("Vertex AI: the team's impersonated service account; another team's project is refused", async () => {
    anthropic.script(ANSWER);
    await expect(as("team-a", vertex("team-a-vertex")).complete(request)).resolves.toMatchObject({ stop: "end" });
    expect(anthropic.requests.at(-1)!.headers["authorization"]).toBe(`Bearer ${identity.googleTokenOf("team-a")}`);

    const from = identity.calls.length;
    const error = await failure(as("team-b", vertex("team-a-vertex")).complete(request));
    expect(error).toBeInstanceOf(ModelHttpError);
    expect((error as ModelHttpError).status).toBe(403);
    expect(identity.calls.slice(from)).toEqual([{ kind: "google", teamId: "team-b" }]);
  });

  it("Bedrock: the team's role with its external id; another team's role is refused before any call", async () => {
    anthropic.script(ANSWER);
    await expect(as("team-a", bedrock(ROLE_A)).complete(request)).resolves.toMatchObject({ stop: "end" });
    expect(anthropic.requests.at(-1)!.headers["authorization"]).toContain(`Credential=${identity.awsKeyOf("team-a").accessKeyId}/`);

    const sent = anthropic.requests.length;
    const error = await failure(as("team-b", bedrock(ROLE_A)).complete(request));
    expect(error).toBeInstanceOf(AssumeRoleDenied);
    expect(anthropic.requests.length).toBe(sent);
    expect(identity.calls.at(-1)).toEqual({ kind: "aws", teamId: "team-b", target: ROLE_A });
  });

  it("Azure OpenAI: the team's federated credential; another team's resource is refused", async () => {
    openai.script(RESPONSE);
    await expect(as("team-a", azure()).complete(request)).resolves.toMatchObject({ stop: "end" });
    const error = await failure(as("team-b", azure()).complete(request));
    expect(error).toBeInstanceOf(ModelHttpError);
    expect((error as ModelHttpError).status).toBe(401);
    expect(identity.calls.at(-1)).toMatchObject({ kind: "azure", teamId: "team-b" });
  });

  it("negative: a cloud profile holds no credential of its own to choose another identity", () => {
    // @ts-expect-error a Vertex AI profile takes no token
    const vertexWithToken: ModelTarget = { provider: "vertex", model: "m", project: "p", region: "eu", accessToken: "ya29.x" };
    // @ts-expect-error a Bedrock profile takes no key
    const bedrockWithKey: ModelTarget = { provider: "bedrock", model: "m", region: "eu-central-1", roleArn: ROLE_A, accessKeyId: "AKIA" };
    expect([vertexWithToken, bedrockWithKey]).toHaveLength(2);
  });
});

/**
 * The identity as production builds it (`createTeamIdentity`), over
 * fetch against a fake of Google's IAM Credentials, AWS STS and Entra: the
 * runner impersonates the team's own service account, named from the team
 * id alone in the operator's identity project.
 */
describe("the teams' identities in production's shape (IAM Credentials, STS, Entra)", () => {
  const PROJECT = "example-team-ids";
  const TENANT = "11111111-2222-3333-4444-555555555555";
  const APP_A = "aaaaaaaa-0000-0000-0000-000000000001";
  let federation: FakeFederation;
  const accountA = () => teamServiceAccount("team-a", PROJECT);
  const accountB = () => teamServiceAccount("team-b", PROJECT);
  const production = (runnerToken = async () => federation.runnerToken) =>
    createTeamIdentity({ project: PROJECT, runnerToken, iamCredentialsUrl: federation.url, stsUrl: `${federation.url}/`, entraUrl: federation.url });

  beforeAll(async () => {
    federation = await startFakeFederation();
    federation.accounts.add(accountA()).add(accountB());
    // Each team granted its own account: team A's project, role and app.
    anthropic.vertexAdmits = (project, token) => (project === "team-a-vertex" ? token === federation.accessTokenOf(accountA()) : token === federation.accessTokenOf(accountB()));
    federation.roles.set(ROLE_A, { sub: federation.subOf(accountA()), aud: "sts.amazonaws.com" });
    federation.apps.set(APP_A, federation.subOf(accountA()));
  });
  afterAll(() => federation.close());

  it("the team's account is named from its id alone: ag- and 27 hex characters, a valid Google account id", () => {
    expect(teamServiceAccountId("team-a")).toMatch(/^ag-[0-9a-f]{27}$/);
    expect(teamServiceAccountId("team-a")).not.toBe(teamServiceAccountId("team-b"));
    expect(accountA()).toBe(`${teamServiceAccountId("team-a")}@${PROJECT}.iam.gserviceaccount.com`);
  });

  it("Vertex AI: the runner's token impersonates the team's account; another team's project is refused at Vertex", async () => {
    const identity = production();
    anthropic.script(ANSWER);
    await expect(createModelClient(vertex("team-a-vertex"), { teamId: "team-a", identity }).complete(request)).resolves.toMatchObject({ stop: "end" });
    expect(anthropic.requests.at(-1)!.headers["authorization"]).toBe(`Bearer ${federation.accessTokenOf(accountA())}`);
    expect(federation.requests.at(-1)).toMatchObject({ path: `/v1/projects/-/serviceAccounts/${encodeURIComponent(accountA())}:generateAccessToken`, authorization: `Bearer ${federation.runnerToken}` });
    const error = await failure(createModelClient(vertex("team-a-vertex"), { teamId: "team-b", identity }).complete(request));
    expect((error as ModelHttpError).status).toBe(403);
  });

  it("Bedrock: the team account's ID token assumes the role that trusts its sub; another team's role is refused by STS before any model call", async () => {
    const identity = production();
    const credentials = await identity.awsCredentials("team-a", ROLE_A);
    expect(credentials.sessionToken).toMatch(/^session-ASIA/);
    const assumed = federation.requests.at(-1)!;
    expect(assumed.form).toMatchObject({ Action: "AssumeRoleWithWebIdentity", RoleArn: ROLE_A, RoleSessionName: teamServiceAccountId("team-a") });
    anthropic.awsSecrets.set(credentials.accessKeyId, credentials.secretAccessKey);
    anthropic.script(ANSWER);
    await expect(createModelClient(bedrock(ROLE_A), { teamId: "team-a", identity }).complete(request)).resolves.toMatchObject({ stop: "end" });
    const sent = anthropic.requests.length;
    expect(await failure(identity.awsCredentials("team-b", ROLE_A))).toBeInstanceOf(TeamIdentityError);
    expect(await failure(createModelClient(bedrock(ROLE_A), { teamId: "team-b", identity }).complete(request))).toBeInstanceOf(TeamIdentityError);
    expect(anthropic.requests.length).toBe(sent);
  });

  it("Azure OpenAI: the team account's ID token as Entra's client assertion; another team's app is refused", async () => {
    const identity = production();
    const token = await identity.azureAccessToken("team-a", TENANT, APP_A);
    expect(federation.requests.at(-1)).toMatchObject({ path: `/${TENANT}/oauth2/v2.0/token`, form: { grant_type: "client_credentials", client_id: APP_A, scope: "https://cognitiveservices.azure.com/.default" } });
    openai.azureAdmits = (sent) => sent === token;
    openai.script(RESPONSE);
    const target: ModelTarget = { provider: "azure-openai", model: "gpt-6-1-dz", endpoint: openai.url, auth: { tenantId: TENANT, clientId: APP_A } };
    await expect(createModelClient(target, { teamId: "team-a", identity }).complete(request)).resolves.toMatchObject({ stop: "end" });
    expect(await failure(identity.azureAccessToken("team-b", TENANT, APP_A))).toBeInstanceOf(TeamIdentityError);
  });

  it("negative: without the runner's own token, or for a team whose account the operator never created, nothing is issued", async () => {
    expect(await failure(production(async () => "ya29.someone-else").googleAccessToken("team-a"))).toBeInstanceOf(TeamIdentityError);
    expect(await failure(production().googleAccessToken("team-c"))).toBeInstanceOf(TeamIdentityError);
  });

  it("tokens are cached per team: a second call asks IAM Credentials nothing", async () => {
    const identity = production();
    await identity.googleAccessToken("team-a");
    const asked = federation.requests.length;
    await identity.googleAccessToken("team-a");
    expect(federation.requests.length).toBe(asked);
  });
});
