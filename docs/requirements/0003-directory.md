# Requirement 0003: The directory

- Status: **built**.
- Architecture: [ADR 0003](../adr/0003-directory.md).
- Code: `src/directory/`, `src/server/directory-api.ts`, `src/server/oidc.ts`.

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
| D13 | A user's personal space is a team of kind `personal`, made once, with them its only admin. Negative: invitations, join codes, new members and role changes are refused | `test/directory.test.ts`, `test/server/api.test.ts` (AS2) |

## Open items

- Transferring a team.
- Assigning a member by email and not by id.
- A changelog of the directory's migrations for another product that
  shares it.
