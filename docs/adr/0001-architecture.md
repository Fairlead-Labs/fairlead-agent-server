# ADR 0001: The runner as a client of MCP tools

- Status: **accepted**, built.
- Requirements: [0001](../requirements/0001-runs.md),
  [0002](../requirements/0002-hosting-and-keys.md).

## Context

- **Teams want an agent without hosting one.** The server runs agents for
  many teams, each with its own model account and its own services.
- **Services already enforce what an agent may do.** A service that grants
  tools per agent, holds risky actions for a person and marks untrusted
  content is the right place for those rules. A harness that enforces safety
  inside itself holds the layer an injected or compromised agent can switch
  off: harnesses have had their approvals disabled through one link,
  compaction has dropped "wait for approval" before an inbox was
  bulk-deleted, skill registries have served malicious skills, and a
  provider layer's releases have carried malware.
- **Model APIs are stateless.** Each call sends the conversation again. A
  run that waits for a person may wait for days, and costs nothing only if
  nothing is held open meanwhile.

## Decision

1. **A client of MCP tools only.**
   - The runner calls an MCP endpoint as the run's agent, exactly as any
     outside agent does. Every check of the service applies unchanged.
   - Its own tools are a fixed list about the work: `read_playbook` today;
     delegating, a session's state, asking a coordinator and the default
     memory once coordinators are built ([ADR 0005](0005-coordinators-summaries-memory.md)).
     None reaches the server's code, configuration, database or keys.
   - No shell, files, code, browser, open web, skill registry or
     provider-hosted tool.
   - The server's own controls (runner questions, limits, the slice) only
     narrow what the agent can do. The service's grants are the control.
   - The server holds no power at a service of its own. What it holds is
     each agent's credential at a service, made there for that agent,
     sealed, and used only in that agent's runs
     ([requirement 0004](../requirements/0004-agents-sessions-connections.md),
     *Connections*). A service never talks to a model.
2. **The host connection's sign-in: the server's identity, bound to a live
   run** ([ADR 0006](0006-the-host.md)). No
   credential is minted for a run; nothing is stored, handed over or
   revoked. Each call carries the server's own token (a workload identity's,
   or a configured one) and names the run and the step. The service admits
   the call as the run's agent only while the run is claimed and inside its
   slice, and records the step, so a cut-off call's outcome is found by it.
3. **A key per team seals the team's secrets.** Transcripts, summaries,
   questions, triggers, model API keys and agents' service credentials are sealed under the team's own key, which a key service
   or a local key wraps ([ADR 0002](0002-one-container.md)). The key
   service's own key never leaves it.
4. **Own thin adapters over `fetch`, one per wire format.**
   - One interface, `ModelClient`: append-only turns, and reasoning state
     as opaque parts sent back unchanged, only to the model that made them.
     The runner mints tool-call ids, and each run uses one model.
   - Anthropic Messages (the Claude API, Vertex AI, Bedrock) and OpenAI
     Responses (OpenAI, Azure OpenAI) first; Gemini and OpenAI-compatible
     Chat Completions later.
   - Cloud accounts are reached by signing requests directly (SigV4, Google
     tokens), so they need no SDK either.
   - One conformance suite runs every adapter against in-process fake
     provider servers: parallel calls, a refusal, a cut-off answer,
     round-tripped reasoning, a 429 with `Retry-After`.
   - No framework, no provider SDK, no provider gateway, no MCP SDK.
   - No hosted tools, ever: the adapters' types cannot express web search,
     code execution or remote MCP connectors.
5. **Runs park in Postgres; nothing relies on provider-side state.**
   - Sessions, runs and steps have row-level security on `team_id`. Each
     step is checkpointed. Each run is claimed by compare-and-set, under a
     lock on its agent; an agent works at most its cap of active sessions'
     runs at a time (set per agent), and runs beyond it wait queued, so the
     cap is never a refusal; parked runs do not count.
   - Each step sends the whole conversation. Nothing relies on state a
     provider keeps, such as OpenAI's `previous_response_id`.
   - A parked run holds no compute, the service refuses its id, and it has
     no end. It resumes with the decision as the result of the call that
     parked it.
   - No safety rule lives in the context: grants and held actions are
     enforced per call, so a summary can cost quality but never safety.
6. **A summary before the cache goes cold, and a version check on resume.**
   - Shortly before the cache window a run paid for closes, a parked run
     with no decision makes one model call without tools that reads the
     conversation at the cache price and writes a summary, where the
     conversation is long enough for that to pay.
   - For every object a tool answered about, the run keeps an id and a
     version, without content. On resume the runner checks them in one
     batch, as the agent, and reads again only what changed.
   - The summary travels in an `<untrusted-…>` envelope. The run's
     injection mark is runner state, so a summary cannot wash it out.
   - Summaries for every new run are [ADR 0005](0005-coordinators-summaries-memory.md)'s.
7. **Sessions with owners.** A session is one agent's work on a line of
   tasks, fixed to its team. Its owners are team members; an empty list
   means the whole team. Questions and runner questions go to the owners.
8. **Questions are the server's.**
   - The runner raises its own questions (runner questions) in fixed cases
     that no playbook or model output can raise, skip or answer: runs used,
     a write after a suspected injection, the same call three times, an
     unknown write outcome.
   - The agent asks the session's owners with `ask_person`, on by default
     (*Ask the owners*), a deliberate default: a question reaches only the
     owners, as text, and an answer never widens a grant or approves an
     action. A session parks while it waits, so it holds at most one
     waiting item.
   - Outside agents reach their people through their own harnesses; the
     server keeps no stream or callback open to them.
   - Held actions are the service's ([ADR 0004](0004-open-protocols.md)).
9. **The team's own model account.**
   - A team's model profiles name its own API key or cloud account. An API
     key is sealed and write-only; a cloud account is reached by federation
     as the team's own identity, one per team, so a profile naming another
     team's account fails there and no team's usage lands on another's
     bill.
   - No token budget in the server: the provider's own spend limit is the
     money cap, and limits per run and per task bound a runaway run.

## Rejected alternatives

- **A framework** (Google ADK, LangGraph, Mastra, Pydantic AI) **or a
  provider layer** (the Vercel AI SDK, LiteLLM):
  - It would wrap a loop of a few hundred lines in a large, fast-moving
    dependency whose APIs change between major versions.
  - A layer holding every provider key is a prime target; compromised
    releases of such layers have run payloads at interpreter start.
  - We take the frameworks' durable-run pattern (checkpoints in Postgres, a
    run paused for a person and resumed) and build it on our own tables.
- **Vendor-hosted loops** (managed agent services): each binds a team to one
  vendor's models and region, and some are not eligible for zero data
  retention.
- **Adopting a personal agent harness:** single-owner, bound to one host,
  with its safety policy inside the harness and self-written skills as a
  persistence path for injected text.
- **Running inside a service that holds credentials:** the runner sends
  text to an outside provider. Two processes keep a bug in a provider
  adapter away from a mail password, and the service needs no egress to
  model providers.
- **Bedrock's Converse API:** Claude through it has lost prompt caching in
  other harnesses. Claude on Bedrock goes through the Anthropic format.
- **Provider-side conversation state:** a parked run waits without an end,
  and provider state would expire under it and tie the run to one
  provider's retention.
- **A run credential** minted at each claim: it has to be minted, stored,
  handed over and revoked, it is a bearer secret in memory while the run
  works, and the server's identity bound to a live run reaches exactly as
  far with nothing to leak.
- **The server's identity with an agent id alone:** the server could act
  for any agent at any time, a confused deputy. Binding it to a claimed run
  limits it to the work handed over.
- **A token budget per agent:** the server would have to price every
  provider's tokens. The provider's spend limit and per-run caps do the
  job.
- **Asking open to every agent:** an outside agent never parks, so answers
  would have to reach it by polling, a webhook or a standing connection, and
  its own harness already reaches its people.
- **A cap on waiting questions per agent:** it would block legitimate
  questions from parallel sessions; one waiting item per session is the
  bound.
- **A private memory per agent in the harness:** it would skip the
  sources' permission checks and leave outside agents without it. The
  project memory of [ADR 0005](0005-coordinators-summaries-memory.md),
  written only by a coordinator, is the one memory.

## Consequences

- One more service to run, with egress to model providers from it alone.
- A service that admits the server's runs trusts one more signer and reads
  a run's state to admit its id.
- Transcripts hold content the services' audit logs do not: they are
  sealed under the team's key and kept 30 days.
- Tokens are paid on the team's own account.
