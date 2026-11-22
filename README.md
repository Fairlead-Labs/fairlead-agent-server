# Fairlead agent server (working name)

A multi-team agent server. One installation hosts agents for many teams;
each team brings its own model account and its own tool connections. The
server works each piece of work as a session with named owners, in short
runs that park in Postgres while they wait, and it asks the owners when it
needs a decision. Tools come only over MCP, apart from a short fixed list
about the work itself: the server has no power of its own.

**Status: private, not released.** The name is a working name. Licence:
Apache-2.0. A first version runs end to end: people sign in, keep spaces,
agents, model profiles and MCP connections through the API, start and steer
work, answer the agents' questions; a host may push triggers and hear of the
work. Coordinators, the project memory and usage limits are next (see *Not
built yet*).

## What is here

| Path | What |
| --- | --- |
| `src/runner.ts` | The loop: steps, limits, the slice, waiting on questions, services' tasks and credentials, recovery by step id, summaries, the version check, the injection mark, runner questions |
| `src/work.ts`, `src/scheduler.ts` | Work intake (triggers, answers, owners, stopping) and the server's own scheduler |
| `src/model/` | Model adapters over `fetch`: Anthropic Messages (Claude API, Vertex AI, Bedrock) and OpenAI Responses (OpenAI, Azure); the teams' own cloud identities |
| `src/mcp/` | The MCP client (revision 2026-07-28 and the older 2025-06-18, tasks, JSON or event streams) and OAuth sign-in at a service (discovery, PKCE, client ID metadata documents, registration) |
| `src/tools.ts`, `src/connections.ts` | A run's tools: the host's and the team's own connections with each agent's credential, renewed when refused |
| `src/store.ts`, `src/runs.ts` | Sessions, runs, steps, triggers, questions and usage on Postgres; a run read by its id across teams |
| `src/agents.ts`, `src/profiles.ts` | Agents (team and personal) and model profiles, and the runner's view of them |
| `src/notify.ts` | What the server announces; the host webhook |
| `src/keys.ts` | A key per team, sealing transcripts, summaries and model keys; wrapped by a key service (Cloud KMS) or a local key |
| `src/prompt.ts`, `playbooks/` | The system prompt and the playbooks, English and German |
| `src/directory/` | Users, teams, members, invitations and join codes, in the Postgres schema `directory` that another product may share |
| `src/migrations.ts`, `src/db/` | The tables with row-level security on `team_id`, applied at every start; the SQL port, transactions, team scoping |
| `src/google.ts` | Google Cloud over `fetch`: Cloud KMS, the metadata server's tokens |
| `src/server/` | The HTTP entry point, the only place that reads the environment; sign-in by an OIDC provider's token, the directory's API, the API for agents, sessions and connections, the host's triggers |
| `src/testing/` | Fake Anthropic, OpenAI, MCP, identity, federation, KMS and OIDC servers (real HTTP on loopback) |
| `Dockerfile`, `docs/configuration.md` | The container and everything it is configured with |

## Commands

```bash
npm install
npm test          # everything in-process: PGlite for Postgres, fake servers, no network
npm run typecheck
```

Node 24 or newer. To run it: `docs/configuration.md`. It needs a container
runtime and Postgres, no particular cloud.

## Not built yet

- **Coordinators**, delegation and a project memory
  ([requirement 0005](docs/requirements/0005-coordinators-and-memory.md)).
- **Usage limits** per team, agent and user (usage is recorded).
- **Private sources** in team sessions, and a team's task service.
- **Trigger senders and webhooks per team**, beside the one host; an
  outbox for webhook events.
- An adapter for the host's record of calls (`RunCallLog`).

## Documents

Requirements (what it does, with criteria mapped to tests):

- [0001 Runs](docs/requirements/0001-runs.md)
- [0002 Hosting and keys](docs/requirements/0002-hosting-and-keys.md)
- [0003 The directory](docs/requirements/0003-directory.md)
- [0004 Agents, sessions and connections](docs/requirements/0004-agents-sessions-connections.md)
- [0005 Coordinators and the project memory](docs/requirements/0005-coordinators-and-memory.md)

Decisions:

- [ADR 0001 The runner as a client of MCP tools](docs/adr/0001-architecture.md)
- [ADR 0002 One container, no cloud provider required](docs/adr/0002-one-container.md)
- [ADR 0003 Users and teams of our own](docs/adr/0003-directory.md)
- [ADR 0004 Open protocols for held actions, run states and MCP](docs/adr/0004-open-protocols.md)
- [ADR 0005 Coordinators, summaries and a project memory](docs/adr/0005-coordinators-summaries-memory.md)
- [ADR 0006 A host trusted for every team](docs/adr/0006-the-host.md)

Also: [configuration](docs/configuration.md) and the
[behaviour evaluation](docs/eval.md).

## Working rules

See `CLAUDE.md`.
