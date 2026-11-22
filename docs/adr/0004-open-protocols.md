# ADR 0004: Held actions, run states and the MCP revision follow the open protocols

- Status: **accepted**, built.
- Requirements: [0001](../requirements/0001-runs.md),
  [0004](../requirements/0004-agents-sessions-connections.md).

## Context

Whoever enforces an action approves it: a service holds an action, and the
server waits. The server needs to learn that an action is held and when it
was decided. MCP has a Tasks extension (`io.modelcontextprotocol/tasks`) and
a new revision (2026-07-28), and A2A 1.0 names the states of a long-running
task. A server that clients and services of any vendor talk to should speak
those, not a dialect of its own.

## Decision

1. **Held actions are MCP tasks.** A service that holds a tool call
   answers it with a task (`taskId`, `ttlMs`, `pollIntervalMs`) in the
   state `input_required` until a person decides. The server declares the
   extension in its client capabilities, parks the run on the task id and
   resumes it when `tasks/get` says `completed`, `failed` or `cancelled`.
   It polls no faster than `pollIntervalMs` while parked, from the
   scheduler, never from a held-open run. A cancelled task reaches the
   agent as a refused call. The server never answers a service's
   `inputRequests` itself: deciding is a person's, at the service.
2. **Run states take the A2A and MCP Tasks names**, so a client reads them
   without a mapping table:

   | Stored today | Then | A2A 1.0 | MCP Tasks |
   | --- | --- | --- | --- |
   | queued | `queued` | SUBMITTED | (none) |
   | working | `working` | WORKING | working |
   | parked on a question | `input_required` | INPUT_REQUIRED | input_required |
   | parked on a held action | `input_required`, with the service's task id | INPUT_REQUIRED | input_required |
   | (none) parked on an expired credential | `auth_required` | AUTH_REQUIRED | (none) |
   | done | `completed` | COMPLETED | completed |
   | stopped | `cancelled` | CANCELED | cancelled |
   | ended-unfinished | `failed`, with the reason | FAILED | failed |

   What a run waits for (a question, a task, a credential) is a field
   beside the state, not a state of its own.
3. **The MCP client speaks the 2026-07-28 revision first,** before OAuth
   connections are built: the protected resource metadata (RFC 9728), the
   `resource` parameter (RFC 8707) and the `iss` check (RFC 9207) on every
   OAuth connection; a client ID metadata document where the
   authorization server takes one; a new token with the asked scope on a
   403 `insufficient_scope`; the stateless transport. A service that
   answers only an older revision is spoken to in that one; the revision
   used is recorded per connection.

## Rejected

- **A trigger that says a held action was decided:** every service would
  need the server's trigger credential and its own way to name the run.
  MCP Tasks puts both in the call that was held.
- **The server holding tool calls itself:** against "whoever enforces an
  action approves it"; it stays for later, for services that cannot hold.
- **Our own state names** with a mapping table at the API: every client
  would carry the table.
- **The new revision only:** most services will move over months, and a
  server that speaks to none of them helps nobody.

## Consequences

- The stored run states are renamed by a migration; the API and the
  playbooks say the new names.
- Two revisions of the MCP client live side by side until the older one
  can be dropped, which a later ADR decides.
