# ADR 0003: Users and teams of our own, signed in by an OIDC provider

- Status: **accepted**, built.
- Requirement: [0003](../requirements/0003-directory.md).

## Context

The server runs agents for teams, and its sessions, settings and questions
belong to a team or a person. It needs to know who is calling and in which
teams. It should run on its own, and it may run beside another product
that has the same people and teams.

## Decision

1. **People sign in at an OIDC provider; the server keeps no passwords and
   has no sign-in pages.** A call carries the provider's access token,
   checked against the configured issuer (its keys from the discovery
   document) and this server's audience.
2. **The server keeps its own directory:** users (issuer and subject),
   teams, members with the role `admin` or `member`, invitations and join
   codes. A user is created at their first call. Only a join code's hash is
   stored. A team always keeps an admin.
3. **The installation admin is a role in the token,** read at each call
   from a configured claim, never stored. An installation admin may list
   and remove teams and is not thereby a member of any.
4. **The directory is shareable.** Its tables live in their own Postgres
   schema, `directory`, hold nothing product-specific, and are migrated
   only by this repository, with their own ledger. The server's own tables
   live in a schema of their own too, `agent_server`, never `public`. Another product on the same database reads and
   writes them with its own database role, so teams and users exist once
   and need no sync. It keeps its own roles, permissions and settings in
   its own tables, pointing at `directory.members`. Whether a user may use a product at all is a role
   in their token, one per product.
5. **The directory is the one exception to team scoping.** Its calls name
   their team or user; every other table carries `team_id` under
   row-level security.

## Rejected

- **Members supplied by another product:** the server would not run on its
  own, and every installation would need a host to manage people.
- **Our own passwords and sign-in pages:** a second credential store to
  secure, and no single sign-on.
- **Storing the admin role:** a role removed at the provider would linger
  until someone removed it here too.
- **The directory's tables in the server's own schema:** another product
  could not share them without rights on everything else.
- **Product-specific columns in the directory** (permissions, plans,
  settings): every product sharing it would carry every other's fields.

## Consequences

- An installation needs an OIDC provider; Keycloak or any standard one
  does.
- A change to the directory's tables is a versioned change here, announced
  in the changelog, since another product may depend on them.
