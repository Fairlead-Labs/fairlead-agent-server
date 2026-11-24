import { randomUUID } from "node:crypto";
import {
  createModelClient,
  createRunner,
  createScheduler,
  createToolHub,
  createWork,
  PostgresAgentStore,
  PostgresConnectionStore,
  PostgresRunStore,
  type Agent,
  type Notifier,
  type RunTool,
  type TeamIdentity,
  type WorkEvent,
} from "../../src/index.js";
import { createDirectory, type Directory } from "../../src/directory/index.js";
import { startFakeAnthropic, startFakeMcp, type FakeAnthropic, type FakeMcp, type FakeTool } from "../../src/testing/index.js";
import { database, newAgent, newProfile, sealerFor } from "./db.js";

/**
 * The server's parts wired as the entry point wires them, on PGlite, a
 * fake Anthropic API and a fake host MCP service; the clock is the test's.
 */

export const MODEL = "claude-sonnet-5-5";
export const HOST_TOKEN = "host-token-of-the-agent-server-0001";

/** Anthropic answers, as the API sends them. */
export const say = (text: string, usage = { input: 1_000, output: 20 }) => ({
  id: `msg_${randomUUID().slice(0, 8)}`,
  type: "message",
  role: "assistant",
  model: MODEL,
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
  stop_details: null,
  usage: { input_tokens: 10, cache_creation_input_tokens: usage.input - 10, cache_read_input_tokens: 0, output_tokens: usage.output },
});
export const call = (name: string, input: Record<string, unknown> = {}, id = `toolu_${randomUUID().replaceAll("-", "").slice(0, 12)}`, usage = { input: 1_000, output: 20 }) => ({
  id: `msg_${randomUUID().slice(0, 8)}`,
  type: "message",
  role: "assistant",
  model: MODEL,
  content: [{ type: "tool_use", id, name, input }],
  stop_reason: "tool_use",
  stop_details: null,
  usage: { input_tokens: 10, cache_creation_input_tokens: usage.input - 10, cache_read_input_tokens: 0, output_tokens: usage.output },
});

const noIdentity: TeamIdentity = {
  googleAccessToken: () => Promise.reject(new Error("none")),
  awsCredentials: () => Promise.reject(new Error("none")),
  azureAccessToken: () => Promise.reject(new Error("none")),
};

export interface World {
  /** The database, for what a test sets or reads beside the stores. */
  db: Awaited<ReturnType<typeof database>>;
  at: Date;
  advance(ms: number): void;
  directory: Directory;
  store: PostgresRunStore;
  agents: PostgresAgentStore;
  connections: PostgresConnectionStore;
  sealer: ReturnType<typeof sealerFor>;
  anthropic: FakeAnthropic;
  host: FakeMcp;
  /** The host's tools, changeable per test. */
  hostTools: FakeTool[];
  events: WorkEvent[];
  runner: ReturnType<typeof createRunner>;
  work: ReturnType<typeof createWork>;
  scheduler: ReturnType<typeof createScheduler>;
  /** A team with an admin, a member and an agent on a Claude profile. */
  team(overrides?: Partial<Agent>): Promise<{ teamId: string; admin: string; member: string; agent: Agent }>;
  /** One scheduler pass, awaiting the runs it started. */
  tick(): Promise<void>;
  close(): Promise<void>;
}

export async function startWorld(): Promise<World> {
  const db = await database();
  const world = { db, at: new Date("2026-11-21T09:00:00.000Z") } as World;
  const now = () => world.at;
  world.advance = (ms) => {
    world.at = new Date(world.at.getTime() + ms);
  };
  world.directory = createDirectory(db, { now });
  world.store = new PostgresRunStore(db);
  world.agents = new PostgresAgentStore(db);
  world.connections = new PostgresConnectionStore(db);
  world.sealer = sealerFor(db);
  world.anthropic = await startFakeAnthropic();
  world.hostTools = [];
  world.host = await startFakeMcp({ tools: world.hostTools, auth: { token: HOST_TOKEN } });
  world.events = [];
  const notifier: Notifier = { notify: (event) => void world.events.push(event) };
  const tools = createToolHub({ host: { url: world.host.url, token: async () => HOST_TOKEN }, connections: world.connections, sealer: world.sealer, now });
  world.runner = createRunner({
    store: world.store,
    agents: world.agents,
    directory: world.directory,
    sealer: world.sealer,
    tools,
    identity: noIdentity,
    notifier,
    now,
    client: (choice, context) => createModelClient(choice.target.provider === "claude-api" ? { ...choice.target, baseUrl: world.anthropic.url } : choice.target, context),
  });
  world.work = createWork({ store: world.store, agents: world.agents, directory: world.directory, sealer: world.sealer, notifier, now });
  world.scheduler = createScheduler({ store: world.store, agents: world.agents, directory: world.directory, runner: world.runner, now, onError: (error) => { throw error; } });
  world.tick = async () => {
    await Promise.all(await world.scheduler.tick());
  };
  world.team = async (overrides = {}) => {
    const sign = (name: string) => world.directory.signIn({ issuer: "https://id.example.test", subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 6)}@example.test` });
    const [admin, member] = [await sign("ada"), await sign("bob")];
    const team = await world.directory.createTeam(admin.id, "Finance");
    await world.directory.addMember(team.id, member.id, "member");
    const profile = newProfile(team.id, { model: MODEL, apiKey: await world.sealer.seal(team.id, "model-key", world.anthropic.apiKey) });
    await world.agents.forTeam(team.id).insertProfile(profile);
    const agent = newAgent(team.id, { profileId: profile.id, ...overrides });
    await world.agents.forTeam(team.id).insertAgent(agent);
    return { teamId: team.id, admin: admin.id, member: member.id, agent };
  };
  world.close = async () => {
    await world.anthropic.close();
    await world.host.close();
    await db.close();
  };
  return world;
}

/** The text of every user message the fake model was sent in its `n`th request (0-based; -1 the last). */
export function sentTo(anthropic: FakeAnthropic, n = -1): string {
  const request = anthropic.requests.filter((r) => r.route === "claude-api").at(n)!;
  return JSON.stringify(request.body.messages);
}

export type { RunTool };
