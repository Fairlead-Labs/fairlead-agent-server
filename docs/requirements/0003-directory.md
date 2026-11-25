# Requirement 0003: The directory

- Status: **built**.
- Architecture: [ADR 0003](../adr/0003-directory.md).
- Code: `src/directory/`, `src/server/directory-api.ts`, `src/server/oidc.ts`, `src/deletion.ts`.

## What it is

People sign in at an OIDC provider the installation is configured with
(Keycloak, or any standard provider). The server keeps who they are, their
teams and their memberships. It has no passwords and no sign-in pages.

- A **user** is an issuer and subject, first seen at their first call with
  a valid token, with the email the token carried.
- An **installation admin** is a user whose token carries the configured
  admin role. The role is read from the token at each call, never stored.
- A **team** has a name. A user may create one if the installation allows
  it (`TEAM_CREATION`; admins always may) and becomes its team admin.
- A **personal space** is a team of kind `personal` whose only member and
  admin is its user, made once at its first use (`POST /me/personal-space`).
  Nobody joins it: no invitation, join code, assignment or role change.
- A **member** is a user in a team with the role `admin` or `member`. A
  team always keeps at least one admin.
- People join by **invitation** (a team admin names an email; the user
  whose email matches may accept), by **assignment** (a team admin adds a
  known user), or by a **join code** (a team admin makes one, with a role,
  an expiry and a number of uses; whoever presents it joins). Only the
  code's hash is stored.

## Shared with another product

The directory's tables live in their own Postgres schema, `directory`, and
nothing else of the server lives there. Another product on the same
database may read and write them with its own database role, so a team and
its members exist once for both and need no sync. The contract:

- This repository defines the tables and is the only one that migrates
  them, recording each migration in `directory.schema_migrations`. A change
  to them is a versioned change here, announced in the changelog.
- The package's `./directory` export holds the directory's migrations and
  nothing else (`DIRECTORY_MIGRATIONS`, `migrateDirectory`), so a product
  sharing the tables can build them in its own tests, or check the ledger
  at its start for the version it knows.
- The tables hold users, teams, members, invitations and join codes, and
  nothing product-specific. Each product keeps its own roles beyond
  `admin` / `member`, its permissions and settings in its own tables,
  pointing at `directory.members`.
- Whether a user may use a product at all is a role in their token, one per
  product. The directory does not record it.
- Each product has its own database role with rights on the directory and
  on its own tables only.

## Deleted accounts

When a person deletes their account at the sign-in service, the sign-in
service tells the server at `POST /users/deleted` with `{ issuer, subject }`.
Only the sign-in service's own identity is admitted: a token of
`ACCOUNT_DELETION_ISSUER` for `ACCOUNT_DELETION_AUDIENCE` naming
`ACCOUNT_DELETION_SUBJECT` (`docs/configuration.md`); unset, nobody is.

- The user's row stays, with `deleted_at` (the first time kept) and without
  its email; a person the server never saw gets such a row too, so every
  product sharing the directory learns of the deletion from it. A deleted
  user is never signed in again.
- Everything of the server's in their personal space goes: agents,
  profiles, connections, sessions, runs, questions, triggers, usage and the
  space's key.
- Their personal agents in teams are removed (open sessions closed as
  `agent-removed`, credentials deleted); the team's profiles stay; they leave every session's owners and every agent's default
  owners.
- The directory's rows stay: the personal space, its membership and the
  person's memberships in teams. A product sharing the directory removes
  its own records first and then the space.
- Each step is safe to repeat; a call that failed part-way is finished by
  the next one.

## Retention

A team's `retention_days` (0 to 36,500; none set: 30) is how long every
product sharing the directory keeps that team's records of finished work.
The server purges a team's transcripts by it (requirement 0001,
*Transcripts*). The server never writes it; a product sharing the
directory sets it from its own plans.

## The API

Every call is a signed-in user's, judged by the caller's own roles:

- `GET /me`: the user, their teams and their open invitations;
- `POST /me/personal-space`: the user's personal space, made at the first
  call;
- teams: create, rename, remove;
- members: list, assign, change role, remove, leave;
- invitations: create, list, revoke, accept;
- join codes: create, list, revoke, join.

A non-member gets 404 for a team, a member without the admin role 403 for
its writes. Anyone may leave a team, the last admin excepted.

## Acceptance criteria

| Id | Criterion | Test |
|----|-----------|------|
| D1 | A user is found or created by issuer and subject; the same pair is always the same user, its email updated when the token's changes | `test/directory.test.ts` |
| D2 | Creating a team makes its creator its first admin, in one step. Negative: an empty or over-long name is refused | `test/directory.test.ts` |
| D3 | A team's members are listed with their roles; a user's teams are listed. Negative: a team lists no member of another team | `test/directory.test.ts` |
| D4 | A member's role changes and a member is removed. Negative: the last admin can be neither demoted nor removed (409), whoever asks | `test/directory.test.ts` |
| D5 | An invitation names an email and a role; accepted by the user whose email matches, case-insensitively, it makes them a member and cannot be used again. Negative: another email, a revoked or an expired invitation joins nobody | `test/directory.test.ts` |
| D6 | A join code is shown once and stored as a hash; presenting it joins with its role until its expiry or its uses are spent. Negative: a wrong, expired, spent or revoked code joins nobody; a code never joins as more than the role it was made with | `test/directory.test.ts` |
| D7 | Joining twice changes nothing: one membership per user and team | `test/directory.test.ts` |
| D8 | Removing a team removes its members, invitations and codes | `test/directory.test.ts` |
| D9 | The tables are in the Postgres schema `directory` with their own ledger, and the directory puts none anywhere else; no foreign key leaves the schema | `test/directory.test.ts` |
| D10 | A bearer token of the configured issuer and audience identifies the caller; the admin role is read from the configured claim. Negative: another issuer or audience, an expired token, a bad signature are 401; the provider unreachable is 503 | `test/server/directory-api.test.ts`, `test/server/startup-config.test.ts` |
| D11 | The API above. Negative per route: a non-member gets 404 for the team, a member without the admin role 403 for its writes; team creation is 403 when the installation does not allow it | `test/server/directory-api.test.ts` |
| D12 | An installation admin may list and remove any team and is not thereby a member of any | `test/server/directory-api.test.ts` |
| DL1 | `POST /users/deleted` marks the user `deleted_at` (made when unknown) and clears the email; the person's tokens are refused afterwards | `test/server/account-deletion.test.ts` |
| DL2 | The personal space's records, the person's personal agents in teams and their owner marks go, the team's profiles stay; the directory's rows stay. Negative: another user's records, agents, profiles and sessions are untouched | `test/server/account-deletion.test.ts` |
| DL3 | Twice is the same: `deleted_at` keeps the first time | `test/server/account-deletion.test.ts` |
| DL4 | Only the sign-in service's identity is admitted. Negative: the host's credential, a person's token, a token for another audience or subject, a forged token or none is 401 and marks nobody; a body without an issuer and a subject is 400; one of the three settings alone stops the start | `test/server/account-deletion.test.ts`, `test/server/startup-config.test.ts` |
| DL5 | A team's `retention_days` is the transcripts' cutoff; a team without one keeps 30 days. Negative: a value out of range is refused | `test/runner.test.ts` (AS10) |
| D13 | A user's personal space is a team of kind `personal`, made once, with them its only admin. Negative: invitations, join codes, new members and role changes are refused | `test/directory.test.ts`, `test/server/api.test.ts` (AS2) |

## Open items

- Transferring a team.
- Assigning a member by email and not by id.
- A changelog of the directory's migrations for another product that
  shares it.
- Without a product sharing the directory, a deleted user's memberships
  and empty personal space stay.
