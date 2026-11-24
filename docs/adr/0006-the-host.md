# ADR 0006: A host trusted for every team

- Status: **accepted**, built.
- Requirements: [0002](../requirements/0002-hosting-and-keys.md),
  [0004](../requirements/0004-agents-sessions-connections.md).
- Amends [ADR 0002](0002-one-container.md) §6.

## Context

The server is often installed beside one product that holds the teams'
work: their tasks, mail and calendars. That product sends the server its
work, serves the agents' tools, and wants to hear when an agent asks
something. It shares the server's database and directory, so its teams
are the server's teams. Configuring a sender credential, a connection and
a webhook again for each team would repeat, per team, what the
installation already knows.

## Decision

1. **An installation may name one host** in its configuration. The host
   is trusted for every team of the installation, and only for three
   things:
   - **sending triggers** for any team, admitted by the host's own
     credential: a token of a configured OIDC issuer for a configured
     audience and subject (a workload identity, which expires within the
     hour), or a configured bearer token;
   - **the host connection**, one MCP service every team's agents reach
     with the server's own sign-in, bound to the run
     ([ADR 0001](0001-architecture.md) §2), without a connection per team;
   - **the host webhook**, where the server announces every team's new
     questions and the end of a session's run, signed or carrying an
     identity token.
2. **Every trigger still names its team and agent,** and the server checks
   both: the agent is in that team and working there, a session it names
   is that agent's, owners it names are members. The host chooses which
   team's work it sends, never what an agent may do: grants stay the
   services'.
3. **Senders, connections and destinations are ports.** The host is one
   adapter of each. A credential per team for other senders, connections
   per team and a webhook per team are further adapters of the same ports,
   added later without changing the callers.
4. **A host is optional.** Without one the server runs on its own: people
   start sessions through the API, and teams configure their own
   connections.
5. **A host on the same database reads two views, nothing else.** The
   server's migrations add `agent_server.host_runs` (a run's id, team,
   agent, state, slice end and latest step: what admitting a call as the
   run takes; and its session, to address a trigger to it) and `agent_server.host_agents` (an agent's id, team, owner
   and removal). The installation grants the host's role `SELECT` on them
   alone. A view reads as its owner, so across teams, and holds no content
   column: no transcript, summary, question or setting. The host reads the
   current row at every check, with no cache and no call to the server.

## Rejected

- **A sender credential per team for the host:** the same trust, set up
  once for every team, with nothing gained.
- **The host's connection configured by each team:** a team admin choosing
  the address would receive the server's own token. The host connection's
  address is the installation's.
- **A read of runs and agents over HTTP:** a credential and an endpoint for
  what the shared database already answers, and a cache whose staleness
  would admit a stopped run.
- **Grants on the tables themselves:** the host would read transcripts,
  sealed or not, and every setting; row-level security cannot hide columns.
- **A host that may also manage teams or answer questions:** it would be a
  credential that manages every team. People manage and answer with their
  own sign-in.

## Consequences

- A leaked host credential sends work to every team. A workload identity
  keeps that window under an hour; a bearer token lasts until it is
  changed, so the configuration reference recommends the identity.
- The host webhook receives every team's question texts: it is for a
  product the installation trusts with them.
- The views are a contract: their columns change only by a new migration,
  and a host's checks follow.
