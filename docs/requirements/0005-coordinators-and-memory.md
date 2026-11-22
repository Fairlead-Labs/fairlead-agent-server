# Requirement 0005: Coordinators and the project memory

- Status: **decided, not built**. Specified in detail, with its criteria,
  when its block starts.
- Architecture: [ADR 0005](../adr/0005-coordinators-summaries-memory.md).
- Builds on [requirement 0001](0001-runs.md) (runs and summaries) and
  [requirement 0004](0004-agents-sessions-connections.md) (sessions, work
  intake, connections).

## Coordinators

- A **coordinator** is a session kind, one per project. Each run starts
  fresh from the project's **state record** (open items, who works on
  what, decisions, what waits) and what woke it, may look things up in its
  own history, and ends by writing the record back. It never carries a
  growing conversation.
- It delegates work to agents through the server's own tools. These are a
  fixed, minimal list about the work only: `delegate` (start or continue a
  session for an agent), reading a session's state, asking a coordinator,
  and the default memory's tools (below). They are listed per session
  kind, judged by the session's team and owners, never reach the server's
  code, configuration, database or keys, and each has a negative test.
- The server sets a bound on delegation when this part is specified, if
  one is needed.
- Other sessions may look things up in a project's coordinator or ask it,
  as the project's memory, for example for a task that spans projects.
- Where a team has a task service, the coordinator creates or finds tasks
  there for the work it delegates. Its state record is the place of record
  either way.
- A level above projects waits until one project's coordinator proves too
  little.

## Summaries and progress

- Long work is a chain of short runs, each starting from the last summary,
  shown to people as one session.
- The server writes the summaries itself, keeps them sealed with the
  team's key, tied to the session and its task, and lets the session's
  owners read and correct them. No copy goes to a task: a connected task
  service gets the task's usual status changes only.
- Every object a summary relies on is checked again before a run continues
  from it ([requirement 0001](0001-runs.md), RN14).
- A session's state, its current run's state and its latest summary are
  readable through the API by whoever may read the session.

## The project memory

- **One memory for now: the project's.** Its coordinator alone writes it,
  from its sessions' summaries, tasks and answers. Every agent working on
  the project reads it (each run recalls from it at the start) and none
  writes to it directly. It is separate from the coordinator's state
  record.
- **Intake is a project setting:** *save from team agents* and *save from
  personal agents*, each `always`, `approval` (a person confirms the
  entry) or `never`, starting at `always` and `approval`. A personal agent
  may be set stricter than its project's value, never looser.
- The server has a **default memory** (its own tables with row-level
  security) behind a small tool contract: `recall` for the project's
  agents, `remember` and `forget` for its coordinator, perhaps `list`. A
  team may mark one connection as its memory, which then replaces the
  default. A memory server that does not follow the contract still works
  through the playbook, without the recall at the start of a run.
- **Later kinds** (team, agent, personal) are not built. Entries, tools and
  API routes name the memory's kind and owner from the start (`project` and
  the project's id), so adding one changes neither.
- **For every memory:** each entry records its source; recalled entries
  come back in the untrusted envelope; people can read, correct and delete
  every entry; nothing crosses teams.
- Only a memory that knows the sources' grants can hide an entry whose
  source an agent has lost. The default memory cannot, and says so; the
  intake setting and people's review are its guard.

## Open items

| # | Item |
|---|------|
| CM1 | What makes a project: a task service's project, or the server's own record. |
| CM2 | Who may read and correct a state record. |
| CM3 | What wakes a coordinator. |
| CM4 | The tables and API routes of the state record, the summaries and the progress read. |
