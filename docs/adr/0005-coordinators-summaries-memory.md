# ADR 0005: Project coordinators, the server's own summaries, and a project memory

- Status: **accepted**. Built: the server's own summaries (4; owners
  correcting them is not built yet) and progress in the API (5).
  Coordinators, the server tools beyond `ask_person`, task services and the
  memory (1–3, 6–10) are not built yet.
- Requirements: [0005](../requirements/0005-coordinators-and-memory.md),
  [0004](../requirements/0004-agents-sessions-connections.md).

## Context

Work outlives a model's context. A task worked over days, and a project
coordinated over months, cannot live in one ever-growing conversation: it
would exceed the window, and between turns the provider's cache goes cold,
so every turn pays for the whole history again. A project also needs one
place that knows what is going on in it, and agents keep relearning the
same facts without a memory.

## Decision

1. **A coordinator is its own session kind, one per project.** It does not
   carry a growing conversation. Each of its runs starts fresh from a
   **state record** the server keeps (open items, who works on what, what
   was decided, what waits), plus what woke it. It may look things up in
   its own history. A run ends by writing the record back. Other sessions
   may look things up in a project's coordinator or ask it, as the
   project's memory, for example when a task spans projects. A level above
   projects is not built until one project's coordinator proves too
   little.
2. **A fixed, minimal set of server tools.** An agent never reaches the
   server itself. The server offers a small, fixed list of tools about the
   work only: `delegate` (start or continue a session for an agent),
   reading a session's state, asking a coordinator, and the default
   memory's tools. They are listed per session kind, judged by the
   session's team and owners, and get negative tests like any way in.
3. **Task services are optional.** Creating or finding a task for
   delegated work is used when a team marks one of its connections as its
   **task service**, and never needed. The coordinator's state record is
   the place of record either way.
4. **The server compacts.** Long work is a chain of short runs, each
   starting from the last summary, and shown to people as one session.
   The server writes the summaries itself (not a provider's compaction,
   whose result is opaque or bound to one vendor), keeps them sealed with
   the team's key, tied to the session and its task, and lets the
   session's owners read and correct them. No copy goes to a task: a
   connected task service gets the task's usual status changes only.
   Every object a summary relies on is re-checked before a run continues
   from it.
5. **Progress is in the API.** A session's state, its current run's state
   and its latest summary are readable through the API by whoever may read
   the session, so a client can show that work moves on.
6. **One memory for now: the project's, kept by its coordinator.** Only
   the coordinator writes it, from what reaches it: its sessions'
   summaries, tasks and answers. Every agent working on the project may
   read it; none writes to it directly. It is separate from the
   coordinator's state record, which is working state. Each run of an
   agent on the project recalls from it at the start.
7. **What the coordinator takes in is a setting on the project:** *save
   from team agents* and *save from personal agents*, each `always`,
   `approval` (a person confirms the entry) or `never`, starting at
   `always` and `approval`. A personal agent may be set stricter than its
   project's value, never looser. Since only the project memory exists,
   this is the one gate for content from a person's private sources
   reaching the project.
8. **A default memory in the server, replaceable behind a small tool
   contract** (`recall` for the project's agents; `remember` and `forget`
   for its coordinator; perhaps `list`). The server implements it itself,
   in its own tables with row-level security, as part of its fixed tool
   list. A team may mark one of its connections as its **memory**, which
   then replaces it. A memory server that does not follow the contract
   still works through the playbook, without the recall at the start of a
   run.
9. **Designed for more kinds, built for one.** Every entry, tool call and
   API route names its memory's kind and owner (`project` and the
   project's id today), so a team, agent or personal memory can be added
   later without changing the contract or the API's shape.
10. **The same rules for every memory:** each entry records its source;
    recalled entries come back in the untrusted envelope; people can read,
    correct and delete every entry; nothing crosses teams.

## Rejected

- **A coordinator as a long conversation with provider compaction:**
  context grows without end, the cache is cold at most wake-ups, and the
  compacted state is opaque or tied to one provider.
- **A coordinator as an ordinary session with a delegating playbook:** it
  gives the coordinator no state record and no way for others to ask it.
- **Summaries kept on the task as well:** a second copy to keep in step,
  visible to the whole project although a summary may draw on private
  sources, and editable there by anyone, so untrusted input to the next
  run.
- **Memory only as an outside service, with a reference service shipped
  beside the server:** one more thing for every installation to run, for
  the same limits as a built-in one.
- **Agents writing to the project memory directly:** many writers, each
  with its own view of what is worth keeping, and no single place to
  apply the intake setting.
- **A memory per agent, team or person now:** most sessions belong to a
  project, and every further kind adds scopes, settings and leak paths
  before anyone has needed it. The contract and API leave room for them.
- **A private memory inside the harness:** it would skip the sources'
  permission checks, and outside agents could not use it.
- **No memory until coordinators are in use:** agents would keep relearning
  the same facts, and the contract is small enough to fix now.

## Consequences

- Only a memory that knows the sources' grants can hide an entry whose
  source the agent lost. The built-in memory cannot, since the server
  does not know a service's grants, and its documentation says so; the
  intake setting and people's review are its guard.
- The server gains tools of its own; each needs a negative test that it
  reaches nothing beyond the work.
- The state record, the summaries and the progress read need tables and
  API routes, specified when their block starts.
