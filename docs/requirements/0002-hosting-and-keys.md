# Requirement 0002: Hosting and keys

- Status: **built**.
- Architecture: [ADR 0001](../adr/0001-architecture.md) (§2, §3) and
  [ADR 0002](../adr/0002-one-container.md).
- Reference: [`docs/configuration.md`](../configuration.md).

## Hosting

The server runs anywhere a container runs, on one Postgres database.
Deployers decide where. It answers `GET /health`, the directory's API
([requirement 0003](0003-directory.md)), the API for agents, sessions and
connections and the host's triggers
([requirement 0004](0004-agents-sessions-connections.md)), and runs its
scheduler in the same process.

- The deliverable is a container image (`Dockerfile`) and a configuration
  reference. No deployment code for any cloud lives here.
- The environment is read once, only in `src/server/index.ts`. A missing or
  malformed value stops the start, naming the variable and never its value.
- What depends on a provider is a port with adapters, chosen by
  configuration, exactly one per port. Two set, or none, stops the start.
- **Migrations at the start.** The server migrates its database at every
  start, in one transaction under an advisory lock, each migration recorded
  with a checksum; a migration changed since it was applied, or one this
  version does not know, stops the start and changes nothing. A database that cannot be reached or migrated stops it too,
  naming neither its URL nor its password.
- **Its own schema.** The server's tables and their ledger live in the
  Postgres schema `agent_server`, the directory's in `directory` with a
  ledger of its own ([requirement 0003](0003-directory.md)); nothing goes
  in `public`, so another product's tables there, of any name, are left
  alone. Every connection sets its search path to `agent_server`.

## Sign-in to the host connection

- **The server's sign-in.** Each call to the host's MCP endpoint
  (`HOST_MCP_URL`) carries a bearer token: a Google identity token minted
  for a configured audience (`HOST_MCP_AUDIENCE`), or a token from the
  configuration (`HOST_MCP_TOKEN`). Where a workload identity exists, it is
  the recommendation. A team's own connections sign in with their agents'
  own credentials instead ([requirement 0004](0004-agents-sessions-connections.md)).
- **The run it is for.** Each call also names the run and the step in two
  headers, `Fairlead-Run-Id` and `Fairlead-Run-Step` (canonical lower-case
  UUIDs). A run holds no credential of its own: nothing is minted, stored,
  handed over or revoked. The host admits the call as the run's
  agent only while the run is working inside its slice. For that the
  server offers a read of a run by its id across teams (`AgentRunReader`,
  six columns, no content). A step id finds a cut-off call's outcome in the
  host's record of calls (the `RunCallLog` port; no adapter is built yet,
  so a cut-off write is a runner question).
- **What a compromised server holds.** It can act as the agents of the runs
  it works right now at the host, within their grants and slices, and as
  any agent at a team's own connection, within that agent's credential.
  It holds no way to approve, answer or widen anything.

## The server's callers

- **People** call the API with their OIDC token
  ([requirement 0003](0003-directory.md)), each call judged by their own
  roles.
- **The host**, where the installation names one, sends triggers for any
  team with its own credential ([ADR 0006](../adr/0006-the-host.md)): a
  token of a configured OIDC issuer for a configured audience and subject,
  or a configured bearer token (`HOST_ISSUER`, `HOST_AUDIENCE`,
  `HOST_SUBJECT`, or `HOST_TOKEN`). It may do nothing else through the
  API.
- **The host webhook.** Where one is configured (`HOST_WEBHOOK_URL`), the
  server tells it of each new question and each run that waits or ends,
  signed by Standard Webhooks (`HOST_WEBHOOK_SECRET`) or carrying a Google
  identity token (`HOST_WEBHOOK_AUDIENCE`).
- **Other trigger senders** with a credential for one team are a later
  adapter of the same port.

A trigger is answered at once; its work is claimed by compare-and-set, so
work sent twice is done once, and one failing run does not stop the rest.

## Keys

- **A key per team** (a personal space is a team too). 32 random bytes per
  team, made at its first seal and kept wrapped in `team_keys`. It seals
  the team's transcripts, summaries, results, model API keys, triggers'
  bodies, questions, answers and service credentials with AES-256-GCM,
  bound to the team and the value's purpose, so a sealed value opens only
  for its team and purpose. An unwrapped key is cached in the process.
- **What wraps it is a port,** `KeyWrapper` (`wrap`, `unwrap`, each bound to
  the team and key id), the only thing the sealer knows of a key service.
  Two adapters: Cloud KMS (`KMS_KEY`), and a local key (`LOCAL_KEY`, 32
  bytes, AES-256-GCM), with which no service is called.

## Acceptance criteria

| Id | Criterion | Test |
|----|-----------|------|
| HK1 | The repository delivers a container image (`Dockerfile`) and a configuration reference (`docs/configuration.md`). No deployment code for any cloud | the image's start command is the entry point `test/server/startup-config.test.ts` runs |
| HK2 | The server starts with no cloud provider's service configured or reachable: a local key and shared tokens | `test/server/startup-config.test.ts` |
| HK3 | Negative: a missing or malformed value stops the start, naming the variable and never its value | `test/server/startup-config.test.ts` |
| HK4 | The MCP endpoint is signed in to with a Google identity token for a configured audience, or with a bearer token from the configuration; each call names its run and step; the runs store answers a run by its id with no content | `test/server/startup-config.test.ts`, `test/runner.test.ts` (RN3), `test/stores.test.ts` (RN2) |
| HK5 | The host is admitted for any team by its credential: a bearer token, or a token of the configured issuer for the audience naming the host's subject; a trigger is 202, the same reference again 200. Negative: any other token, subject or audience, another scheme or none is 401 and nothing is worked; a malformed trigger is 400 | `test/server/api.test.ts` |
| HK6 | Negative: both ways configured for one choice (the wrapping key; the host's MCP sign-in, trigger sign-in or webhook signature), or neither where one is required, stops the start; a way without its URL stops it | `test/server/startup-config.test.ts` |
| HK11 | The database is migrated at the start, each migration once and recorded; the server starts with no host at all. Negative: a migration changed after it was applied, an unknown one or a failing one stops it and changes nothing; a database that cannot be reached stops the start, its URL never echoed | `test/migrations.test.ts`, `test/server/startup-config.test.ts` |
| HK12 | The server's tables and ledger are in the schema `agent_server`, the directory's in `directory`, each connection finding the server's own. Negative: another product's tables in `public`, `agents` and `schema_migrations` among them, are neither read nor changed | `test/migrations.test.ts`, `test/server/startup-config.test.ts` |
| HK7 | A team's first seal makes its key, wrapped under an AAD naming team and key; later seals and other processes reuse it; two first seals at once store one key. Negative: a value opens only for its team and purpose, untouched, under its key; a wrapped key moved to another team's row does not unwrap; a refusing key service leaves nothing stored or sealed | `test/keys.test.ts`, `test/server/startup-config.test.ts` |
| HK8 | `KeyWrapper` is the only thing the sealer knows of a key service; Cloud KMS is one adapter | `test/keys.test.ts` |
| HK9 | A local key is another: no service is called, and another process with the same key opens what one sealed | `test/keys.test.ts` |
| HK10 | Negative: another local key opens nothing; a key that is not 32 bytes is refused, at the start too | `test/keys.test.ts`, `test/server/startup-config.test.ts` |

## Later

- Other key services (AWS KMS, Azure Key Vault, Vault Transit) as adapters.
- Rotating a local key; re-wrapping each team's key when an installation
  changes adapter (a command that does not exist yet).
- Trigger senders with a credential for one team, and a webhook per team.
