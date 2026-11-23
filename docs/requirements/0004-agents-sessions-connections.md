# Requirement 0004: Agents, sessions and connections

- Status: **built**, apart from what *Not built yet* lists.
- Builds on [requirement 0001](0001-runs.md) (runs) and
  [requirement 0003](0003-directory.md) (users and teams).
- Architecture: [ADR 0004](../adr/0004-open-protocols.md) for held actions,
  run states and the MCP revision; [ADR 0005](../adr/0005-coordinators-summaries-memory.md)
  for summaries and progress.

## Principles

1. **A host is optional.** The server has its own users, teams and agents
   and runs without any other product. An installation may name one host
   it trusts for every team ([ADR 0006](../adr/0006-the-host.md)).
2. **Any agent, any service.** Services are agent-agnostic and the server is
   service-agnostic: an agent it runs arrives at a service as its own
   identity with its own credential, like any other agent would.
3. **An agent never reaches the server itself.** No tool, playbook or
   instruction gives an agent the server's code, configuration, database or
   keys. Tools come only from connected services, apart from the server's
   short fixed list about the work ([requirement 0005](0005-coordinators-and-memory.md)),
   which reaches nothing else. Every way in gets a negative test.
4. **Whoever enforces an action approves it.** Approving a held action
   belongs to the service that would carry it out. The server owns only its
   agents' questions.
5. **Plans stay outside.** The server records usage and enforces the limits
   it is given. What a limit costs is someone else's product.

## Spaces and agents

- **A space** is where agents work and sessions live: a team, or a user's
  **personal space**. A personal space is a team of kind `personal` with
  exactly one member, its user, made at its first use. Nobody joins it:
  no invitation, join code or assignment.
- **Every agent lives in exactly one space** and works only there. No
  agent works across spaces.
- A **team agent** belongs to its team and is configured by its team
  admins (later also by roles with a permission).
- A **personal agent** is owned by one user inside its space. Everyone in
  the team sees it, as an assignee and in its sessions; only its owner
  changes it: its instructions, model, settings, and that it exists. What
  it may reach in a service is at most what its owner may reach; the
  service enforces that at every call.
- **Its owner leaving the team** disables it at once: it starts no run, and
  a working run is stopped at its next save. It stays in the team, and
  works again if its owner is invited back. Whether it is disabled is read
  from the directory at each check, never stored, so a membership changed
  by another product sharing the directory takes effect the same way.
  Its team's admins may remove it.
- **Others' work for a personal agent.** Another member may start work for
  someone's personal agent, as a request: the session's owner stays the
  agent's owner, so its questions go to the person who knows the agent.
- **Active sessions at most.** Each agent holds a cap of sessions active
  at once (`maxActiveSessions`, 1 to 100, default 3), read with its
  settings and changed by whoever edits the agent: a team agent's team
  admins, a personal agent's owner. A session is active while its run is
  `working`; a session waiting on a person (`input_required`,
  `auth_required`), an idle one and a closed one do not count, so an
  agent may hold more open sessions than its cap. A trigger is never
  refused for the cap: a run beyond it waits as `queued` (the trigger's
  answer says `queued: true`) until one of the agent's runs stops working,
  then the queued runs start in the queue's order (priority, due date,
  then the oldest), as many as the cap leaves. The claim counts the
  agent's working runs under a lock on the agent, so runs started at once
  never pass the cap. A waiting run is picked up at the scheduler's first
  pass after a place frees, a server's first pass after a start included.
  Several runs of one agent working at once share its credentials: a token
  one of them renewed is taken by the others.
- **Safety controls.** A team admin may stop or pause any agent of the
  team, a personal one included. Editing a personal agent stays its
  owner's.
- A personal agent's questions go to its owner by default.
- **Behaviour:** the playbooks ship with the server and are refined in this
  repository for everyone. An agent's owner adds free-text instructions.
  Team or personal playbooks are a later step.
- **Model profiles.** A team's admins keep the team's profiles, which its
  team agents use. A user keeps their own profiles in a space, which only
  their personal agents there use, on their own model account. A personal
  agent never uses the team's profiles. (A vendor's app subscription is
  not API access; a profile needs an API address and key, or a cloud
  account of the space.)

## Sessions

- **A session lives in its agent's space.** A team session is readable by
  everyone in the team; a session in a personal space only by its user.
- **Private sources in team sessions** (not built yet). A tool answer a service marks as
  from a private source is shown only to the session's owners; others see
  that something is hidden. This is a guard, not a guarantee: what the
  agent wrote afterwards is not hidden, and it depends on the service's
  mark. The playbooks tell an agent not to carry private content into team
  work unless its user asked.
- **A session can take several pieces of work.** A trigger may name an
  existing session to continue. A session works **one run at a time**, its
  triggers in the order they arrived: a trigger for a session with a
  working run reaches that run at its next step, one for a waiting run
  when it resumes, one for an idle session queues its next run.
- **Ending.** Its owners close a session through the API, a trigger may
  ask to close it after its run (`close`), or it closes after 7 days
  without a trigger or a run. A session asked to close closes once its run
  has ended and no trigger waits; it takes triggers until then. A closed
  session takes no more triggers.
- **Owners** are users of the session's team. The first owners are the ones
  the trigger names, else the person who started it through the API, else
  the agent's default owners (a personal agent's owner always among
  them). Answering changes no owner. A session's owners and the team's
  admins change its owners, by its own call. A member who leaves the team
  leaves every session's owners; a session whose last owner left goes back
  to the whole team.
- **Long work is many short runs,** each starting from the last summary
  and shown as one session ([requirement 0005](0005-coordinators-and-memory.md),
  [ADR 0005](../adr/0005-coordinators-summaries-memory.md)). Memory crosses
  sessions only through the project memory.
- **Progress is readable.** A session's state, its runs' states, the last
  run's result and its latest summary are in the API for whoever may read
  the session.
- **Run states** take the A2A and MCP Tasks names
  ([ADR 0004](../adr/0004-open-protocols.md)): `queued`, `working`,
  `input_required`, `auth_required`, `completed`, `cancelled`, `failed`.
  What a run waits for (a question, a service's task, a credential) is a
  field beside the state.

## Work intake

- **Triggers are pushed.** A trigger names the team, the agent, what
  happened (an event name), a reference its sender chose (the same
  reference for the same agent starts work once), and optionally a session
  to continue, its owners, a priority, a due date and `close` (close the
  session after this trigger's run). Its body is data for the agent,
  sealed at rest. The server pulls work from nowhere.
- **The host's `POST /triggers`** takes `{ teamId, agentId, event,
  reference, body?, sessionId?, ownerUserIds?, priority?, dueOn?, close? }`
  and answers `{ sessionId, triggerId, duplicate, queued }`: `202` for a
  new trigger, `200` for a reference sent before (`duplicate: true`).
  `queued` is true while the session's run waits for a free session (the
  agent's cap of active sessions); the run's state is then `queued`, in
  the API and in the host's view `host_runs`.
- **Who may send.** The installation's host, for any team
  ([ADR 0006](../adr/0006-the-host.md)). A credential per team for other
  senders is a later adapter of the same port. People start and continue
  sessions through the API with their own sign-in, as the session's owner.
- **Questions are the server's.** `ask_person` is a server tool: the
  server keeps the question sealed, lists it to the session's owners,
  takes the answer and resumes the run. Runner questions go to the owners
  the same way, answered *Continue* or *Stop*. An answer never widens a
  grant or approves an action. The host webhook hears of each new question
  and of each run that ends or waits; a webhook per team is a later
  adapter.
- **Held actions are the service's,** as MCP tasks
  ([ADR 0004](../adr/0004-open-protocols.md)). A service answers a held call
  with a task; the run parks on its id and continues when the task is
  `completed`, `failed` or `cancelled`. The server polls no faster than the
  task's `pollIntervalMs` and never answers its `inputRequests` itself.
  Holding tool calls in the server itself is for later, for services that
  cannot hold.
- **A task service is optional** (not built yet). A team may mark one connection as its
  task service; coordinators then create or find tasks there for the work
  they delegate. Without one everything works the same, the coordinator's
  state record being the place of record.

## Connections

- **The host connection.** Where an installation names one, every agent of
  every team reaches it with the server's own sign-in bound to the run
  ([ADR 0001](../adr/0001-architecture.md) §2, [ADR 0006](../adr/0006-the-host.md)).
  The service decides per agent what it grants.
- **A team's own connections.** A team configures further MCP services by
  address. Per agent and service there is a credential, made at the service
  and stored sealed here: a key the service issued for that agent, or an
  OAuth connection made by a person at the service for that agent. An
  agent sees only the tools of the services it holds a credential for, plus
  the host's.
- **One space, one credential.** A credential is per agent and service, in
  the agent's one space, so no session can call into another space.
- **The MCP revision:** the client speaks 2026-07-28 first (protected
  resource metadata, the `resource` parameter, PKCE, the `iss` check,
  client ID metadata documents where taken, else dynamic registration, the
  stateless transport, answers as JSON or an event stream), and the older
  2025-06-18 revision, with its session, to a service that answers only
  that. The revision used is recorded per connection.
- **Renewal.** An OAuth token refused with 401 is renewed once with its
  refresh token and the call made again. A grant that cannot be renewed, a
  key the service refuses, and a 403 `insufficient_scope` mark the
  credential *needs sign-in*; the run waits in `auth_required`, and the
  next sign-in asks for the scope held plus the one missing.
- A team may mark one connection as its **task service** and one as its
  **memory** ([requirement 0005](0005-coordinators-and-memory.md); not
  built yet).

## Managing the server

There is no UI. Signed-in users manage their spaces, agents, model
profiles and connections through the API, each call judged by the caller's
own roles: a team's admins for its team agents, profiles and connections,
an owner for their personal agent. There is no credential that manages
every team. An installation admin sees that a team exists and what it
uses, never its sessions.

## Usage and budgets

The server records sessions, runs and model tokens per day, team, agent and
the user a session was started for, and offers them through the API to the
team's admins; an installation admin sees each team's totals. Limits per team, per agent and per user, which the server
then enforces (at a limit no new run starts, and the session says why), come
next. The safety limits in code (steps, time, delegation depth) are not
configurable upwards.

## Checking behaviour

Tests run on every change. The behaviour evaluation ([`docs/eval.md`](../eval.md))
runs before each release, on the maintainers' model account, and its result
is published with the release. Behaviour changes in between merge on
review.

## Not built yet

- Private sources in team sessions (the service's mark and hiding a tool
  answer from all but the owners).
- A team's task service and memory connection, and coordinators
  ([requirement 0005](0005-coordinators-and-memory.md)).
- Usage limits per team, agent and user.
- Owners correcting a session's summary (they read it today).
- Trigger senders with a credential for one team, and a webhook per team.
- Delivering webhook events through an outbox: today an event is tried
  three times and then left, so a server stopped meanwhile loses it.

## Acceptance criteria

"Negative" marks a criterion about what must be refused. The API tests
(`test/server/api.test.ts`) sign people in at a fake OIDC issuer and play
the services with the fake MCP server over real HTTP.

| Id | Criterion | Test |
|----|-----------|------|
| AS1 | A team's admins keep its agents, profiles and connections; a member reads the agents and connections; secrets are write-only; agents and profiles are changed by compare-and-set, a removed agent found but not listed, a named profile not deleted. Negative: invalid settings are 400 (a limit out of range, an unknown time zone, a connection name or address that is not one, another team's profile); another team's agents and profiles are never found, changed or deleted | `test/server/api.test.ts`, `test/stores.test.ts` |
| AS2 | A member keeps their own personal agent and profiles; the team's admins neither see its profile nor edit it, but pause and remove it; a personal space is its user's alone; a personal agent whose owner left starts no run and works again once they are back. Negative: a personal agent never uses the team's profile | `test/server/api.test.ts`, `test/runner.test.ts` |
| AS3 | A paused agent starts no run and its working run goes back to the queue; resumed, it goes on; a stopped run is cancelled with its question withdrawn | `test/runner.test.ts` |
| AS4 | A held call waits on the service's task, polled no faster than its interval and doubling; its outcome is the call's result; a cancelled task is said so; a task waiting on a person at the service puts the run in `input_required` until it completes | `test/runner.test.ts` |
| AS5 | A member starts work, reads its progress and result and continues it; the owners change owners; an owner closes it. Negative: a member who owns none of a session neither changes its owners, closes it nor answers its question; another team's sessions are 404 | `test/server/api.test.ts` |
| AS6 | A connection's name once per team; one credential per agent and connection; with a key from the service the agent sees its tools as `<connection>__<tool>`; a refused key waits for a person (`auth_required`) and a new key resumes the run. Negative: another team's connections and credentials are never listed, found, changed or deleted | `test/server/api.test.ts`, `test/stores.test.ts` |
| AS7 | OAuth: a person signs the agent in at the service (client ID metadata document, PKCE, `resource`, `iss`); a pending sign-in is taken once, before it expires; a refused token is renewed; a grant that cannot be renewed, or a missing scope, waits for the next sign-in, which asks for the wider scope and resumes the run. Negative: an unknown state, an error from the service or another issuer signs nobody in; a key connection refuses OAuth and the other way round | `test/server/api.test.ts`, `test/stores.test.ts` |
| AS8 | The same reference starts work once; a trigger naming the session starts its next run from the last summary. Negative: another team's agent, a closed session, a malformed event or a body over 64 KiB starts nothing | `test/runner.test.ts` |
| AS9 | `ask_person` keeps the question sealed for the session's owners; only an owner answers; the answer resumes the run with what arrived meanwhile | `test/runner.test.ts` |
| AS10 | Triggers are delivered to one run, in order; a session closes after 7 days idle only without an open run; usage adds up per day, agent and user; the hourly pass purges old transcripts and closes idle sessions | `test/stores.test.ts`, `test/runner.test.ts` |
| AS11 | Usage per team for its admins; an installation admin sees each team's totals, never its sessions | `test/server/api.test.ts` |
| AS12 | The host webhook: each event POSTed signed by Standard Webhooks, a failed delivery tried again, three times in all; with an identity, each delivery carries a fresh token instead of a signature | `test/notify.test.ts` |
| AS13 | A new agent's cap of active sessions is 3; a team admin changes a team agent's, its owner a personal agent's, on creating or by `PATCH`. Negative: a member who is neither 403; below 1, above 100 or not an integer 400, nothing changed | `test/server/api.test.ts` |
| AS14 | A trigger naming its session with `close` closes the session once its run has ended and no trigger waits, not before; the answer and the session say so. Negative: `close` that is not a boolean is 400; another agent's session is 404, a closed one 409, and neither is changed | `test/runner.test.ts`, `test/stores.test.ts`, `test/server/api.test.ts` |
| AS15 | A trigger beyond the agent's cap of active sessions is `202` with `queued: true`, its run `queued` until one of the agent's runs stops working, then the oldest starts first; claims at once never pass the cap; a waiting run starts at a fresh scheduler's first pass; two runs of one agent share a renewed OAuth token. Negative: never refused for the cap; the same reference again starts it once; a run waiting on a person does not hold the cap; another agent's run stopping starts nothing for this agent | `test/runner.test.ts`, `test/stores.test.ts`, `test/server/api.test.ts` |
| CN1 | The MCP client speaks the current revision first: no `initialize`, the revision, client and capabilities in `_meta`, the routing headers, JSON or an event stream | `test/mcp.test.ts` |
| CN2 | A service that speaks only the older revision is initialized and its session kept, `initialize` and its notification carrying the caller's own headers (a host's run headers), never the routing ones; a forgotten session is begun again; the revision is recorded | `test/mcp.test.ts` |
| CN3 | A held call answers a task, polled with `tasks/get` to its result or its failure; a service's JSON-RPC error is its refusal; no token is 401 with the challenge | `test/mcp.test.ts` |
| CN4 | Discovery from the challenge, PKCE with S256, the resource on both requests, the answer's `iss` checked; a client ID metadata document where taken, else registration. Negative: a wrong verifier, another issuer's answer, a missing `iss` where promised, metadata for another resource and a service without metadata are refused | `test/mcp.test.ts` |
