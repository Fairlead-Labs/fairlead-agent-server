# Configuration

The server is one container (`Dockerfile`) and a Postgres database. It needs
no particular cloud: where it runs, and how its secrets reach it, is the
deployer's choice. All configuration is environment variables, read once at
the start in `src/server/index.ts`. A missing or malformed value stops the
start and names the variable, never its value. The server migrates its
database at every start, then serves the API and runs its scheduler in the
same process.

```bash
docker build -t agent-server .
docker run --env-file agent-server.env -p 3000:3000 agent-server
```

`GET /health` answers 200 once it listens.

## Always

| Variable | What |
| --- | --- |
| `DATABASE_URL` | `postgres://…`. The role needs to create the schemas `agent_server` (the server's tables) and `directory` (users and teams), or own them; nothing is created in `public`. The migrations are in `src/migrations.ts` and `src/directory/migrations.ts`. |
| `DATABASE_SSL` | `true` to connect over TLS with the certificate checked. |
| `DATABASE_POOL_SIZE` | Connections, default 5. |
| `PUBLIC_URL` | This server's own address, https (http only on loopback). OAuth sign-ins at services return to `<PUBLIC_URL>/oauth/callback`, and `<PUBLIC_URL>/oauth/client-metadata.json` is its client ID metadata document. |
| `PORT` | Default 3000. |

## Users

People sign in at an OIDC provider (Keycloak, or any standard one) and call
the server with its access token. The server has no passwords and no
sign-in pages.

| Variable | What |
| --- | --- |
| `OIDC_ISSUER` | The provider's issuer, exactly as its tokens spell it. Its keys are read from its discovery document at the first call. |
| `OIDC_AUDIENCE` | This server's audience. A token minted for anything else is refused. |
| `OIDC_ROLES_CLAIM` | The claim holding a user's roles as an array, default `groups`. |
| `OIDC_ADMIN_ROLE` | The role that makes an installation admin, default `agent-server-admin`. |
| `TEAM_CREATION` | `admins` (default): only installation admins create teams. `users`: every signed-in user may. |

Users, teams, members, invitations and join codes live in the Postgres
schema `directory` (`src/directory/`), which another product on the same
database may share ([requirement 0003](requirements/0003-directory.md)).

## The key

Set exactly one; both, or neither, stops the start.

| Portable | Google Cloud |
| --- | --- |
| `LOCAL_KEY`: 32 random bytes in base64 | `KMS_KEY`: a Cloud KMS key, `projects/…/locations/…/keyRings/…/cryptoKeys/…` |

## The host (optional)

An installation may name one host it trusts for every team
([ADR 0006](adr/0006-the-host.md)): an MCP service every agent reaches, a
sender of triggers, a webhook told of the work. Each part is optional, and
each has a portable way and a Google Cloud way: set at most one, and a way
without its URL stops the start. Without a host, people start work through
the API and agents reach only their team's own connections.

| Part | Portable | Google Cloud |
| --- | --- | --- |
| `HOST_MCP_URL`: the host's MCP endpoint, called as the run (`Fairlead-Run-Id`, `Fairlead-Run-Step`) | `HOST_MCP_TOKEN`: a bearer token | `HOST_MCP_AUDIENCE`: the audience of a Google identity token, read from the metadata server |
| Triggers at `POST /triggers` | `HOST_TOKEN`: the bearer token the host sends | `HOST_ISSUER`, `HOST_AUDIENCE`, `HOST_SUBJECT`: the host sends a token of that issuer for that audience, naming that subject (a Google identity token: `https://accounts.google.com`, this server's URL, the host's service account) |
| `HOST_WEBHOOK_URL`: told of each new question, each answer and each run that waits or ends (ids and kinds, never a question's text) | `HOST_WEBHOOK_SECRET`: a `whsec_` secret; each delivery is signed by Standard Webhooks | `HOST_WEBHOOK_AUDIENCE`: each delivery carries a Google identity token for that audience |

Bearer tokens are 32 to 512 printable characters without spaces. A team's
own MCP services are configured through the API, not here
([requirement 0004](requirements/0004-agents-sessions-connections.md)).

**Which to choose.** A key service keeps the wrapping key outside the
process and the database: someone who reads the environment and the database
still opens nothing. With `LOCAL_KEY`, whoever reads the
configuration can open every team's model keys and transcripts, so keep it
in your platform's secret store, and keep a copy: without it nothing sealed
opens again. An identity token expires within the hour and names its
caller; a bearer token is valid until you change it. Where a workload
identity exists, prefer it. Other key services and identity providers are
adapters behind the same ports (`KeyWrapper` in `src/keys.ts`, the token
functions in `src/server/index.ts`, the senders in `src/server/senders.ts`).

A local key is made with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## Optional

| Variable | What |
| --- | --- |
| `CORS_ORIGINS` | Comma-separated origins whose browsers may call the API, each `https://host[:port]` without a path (http only on loopback). Their preflights are answered; any other origin gets no CORS header. Unset, none. |
| `TEAM_IDENTITY_PROJECT` | The Google Cloud project holding a service account per team, for model accounts reached by identity (Vertex AI, Bedrock, Azure) and not by API key. Unset, only API-key profiles run. |
| `AWS_STS_AUDIENCE` | The audience for AWS STS, default `sts.amazonaws.com`. |
| `KMS_ENDPOINT`, `GCE_METADATA_HOST` | Other addresses for Cloud KMS and the metadata server, for tests. |

## A host on the same database

A host sharing the database reads two views in `agent_server`, and nothing
else of the schema ([ADR 0006](adr/0006-the-host.md) §5). Grant its role
`USAGE` on the schema and `SELECT` on the views it needs:

| View | Columns |
| --- | --- |
| `host_runs` | `id`, `team_id`, `agent_id`, `state`, `slice_ends_at` (null while the run holds no slice), `step_id` (its latest step, the one a call in progress names), `session_id` |
| `host_agents` | `id`, `team_id`, `owner_user_id` (null for a team agent), `removed_at` |

A host that boots the server in its own tests imports `createServer` from
the package export `./server`: the API and the runner wired as the entry
point wires them, from options instead of the environment.

## A first run with a Claude API key

No model key goes into the configuration: model keys belong to a space and
are stored sealed. With the server running and signed in as a user:

1. `POST /teams` with a name (an installation admin, or anyone with
   `TEAM_CREATION=users`), or `POST /me/personal-space`.
2. `POST /teams/{team}/profiles` with `{ "name": "Claude", "provider":
   "claude-api", "model": "claude-sonnet-5-5", "apiKey": "…" }`. The key
   is sealed and write-only from then on.
3. `POST /teams/{team}/agents` with a `name` and that `profileId`.
4. `POST /teams/{team}/agents/{agent}/sessions` with a message; read the
   session with `GET /teams/{team}/sessions/{session}` until its run is
   `completed`, and answer its questions under `/teams/{team}/questions`.

## Not yet

- One local key, no rotation.
