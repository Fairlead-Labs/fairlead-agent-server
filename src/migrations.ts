import { migrateDirectory } from "./directory/migrations.js";
import { migrate, type Migration } from "./db/migrate.js";
import type { TransactionalSqlDatabase } from "./db/sql-database.js";

/**
 * The server's own migrations (requirement 0002, *Hosting*), in the schema
 * `agent_server` with their own ledger, so a database another product
 * shares is never touched outside it; the directory's are its own
 * (`src/directory/migrations.ts`) and run first. Every team table
 * carries `team_id` under row-level security on `app.team_id`; the
 * crossings are a run read by its id (`app.run_id`) and a pending OAuth
 * connection read by its state (`app.oauth_state`).
 *
 * A released migration is never edited: a change is a new entry.
 */

const rls = (table: string) => [
  `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
  `CREATE POLICY ${table}_team ON ${table}
        USING (team_id = current_setting('app.team_id', true))
        WITH CHECK (team_id = current_setting('app.team_id', true))`,
];

const SERVER: readonly string[] = [
  `CREATE TABLE team_keys (
        team_id     text PRIMARY KEY,
        key_id      text NOT NULL,
        wrapped     text NOT NULL,
        kms_version text NOT NULL,
        created_at  timestamptz NOT NULL
      )`,
  ...rls("team_keys"),

  `CREATE TABLE profiles (
        id            uuid PRIMARY KEY,
        team_id       text NOT NULL,
        owner_user_id text,
        doc           jsonb NOT NULL,
        api_key       jsonb,
        created_at    timestamptz NOT NULL,
        updated_at    timestamptz NOT NULL,
        version       integer NOT NULL CHECK (version >= 1),
        UNIQUE (team_id, id)
      )`,
  ...rls("profiles"),

  `CREATE TABLE agents (
        id                     uuid PRIMARY KEY,
        team_id                text NOT NULL,
        name                   text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
        description            text NOT NULL DEFAULT '',
        owner_user_id          text,
        profile_id             uuid,
        ask_owners             boolean NOT NULL DEFAULT true,
        limits                 jsonb NOT NULL,
        playbook               text,
        default_owner_user_ids text[] NOT NULL DEFAULT '{}',
        time_zone              text NOT NULL DEFAULT 'UTC',
        language               text NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'de')),
        paused                 boolean NOT NULL DEFAULT false,
        created_at             timestamptz NOT NULL,
        updated_at             timestamptz NOT NULL,
        removed_at             timestamptz,
        version                integer NOT NULL CHECK (version >= 1),
        UNIQUE (team_id, id),
        FOREIGN KEY (team_id, profile_id) REFERENCES profiles (team_id, id)
      )`,
  `CREATE INDEX agents_team ON agents (team_id, created_at)`,
  ...rls("agents"),

  `CREATE TABLE sessions (
        id                 uuid PRIMARY KEY,
        team_id            text NOT NULL,
        agent_id           uuid NOT NULL,
        state              text NOT NULL CHECK (state IN ('open', 'closed')),
        close_reason       text CHECK (close_reason IN ('closed', 'idle', 'agent-removed')),
        owner_user_ids     text[] NOT NULL DEFAULT '{}',
        started_by_user_id text,
        created_at         timestamptz NOT NULL,
        updated_at         timestamptz NOT NULL,
        last_activity_at   timestamptz NOT NULL,
        closed_at          timestamptz,
        version            integer NOT NULL CHECK (version >= 1),
        UNIQUE (team_id, id),
        FOREIGN KEY (team_id, agent_id) REFERENCES agents (team_id, id),
        CHECK ((state = 'closed') = (closed_at IS NOT NULL AND close_reason IS NOT NULL))
      )`,
  `CREATE INDEX sessions_team ON sessions (team_id, state, last_activity_at)`,
  ...rls("sessions"),

  `CREATE TABLE runs (
        id                  uuid PRIMARY KEY,
        seq                 bigint GENERATED ALWAYS AS IDENTITY,
        team_id             text NOT NULL,
        session_id          uuid NOT NULL,
        agent_id            uuid NOT NULL,
        state               text NOT NULL CHECK (state IN ('queued', 'working', 'input_required', 'auth_required', 'completed', 'cancelled', 'failed')),
        cause               text NOT NULL CHECK (cause IN ('trigger', 'answer', 'continue')),
        priority            text CHECK (priority IN ('low', 'medium', 'high')),
        due_on              date,
        queued_at           timestamptz NOT NULL,
        claimed_at          timestamptz,
        slice_started_at    timestamptz,
        ended_at            timestamptz,
        stop_reason         text,
        model               jsonb,
        steps               integer NOT NULL DEFAULT 0 CHECK (steps >= 0),
        input_tokens        bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
        output_tokens       bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
        injection_suspected boolean NOT NULL DEFAULT false,
        read_versions       jsonb NOT NULL DEFAULT '[]'::jsonb,
        waiting_on          jsonb,
        cache_until         timestamptz,
        transcript          jsonb,
        summary             jsonb,
        result              jsonb,
        version             integer NOT NULL CHECK (version >= 1),
        FOREIGN KEY (team_id, session_id) REFERENCES sessions (team_id, id),
        CHECK (state <> 'working' OR (claimed_at IS NOT NULL AND slice_started_at IS NOT NULL)),
        CHECK ((state IN ('completed', 'cancelled', 'failed')) = (ended_at IS NOT NULL))
      )`,
  `CREATE UNIQUE INDEX runs_one_working ON runs (team_id, agent_id) WHERE state = 'working'`,
  `CREATE UNIQUE INDEX runs_one_open_per_session ON runs (team_id, session_id) WHERE state IN ('queued', 'working', 'input_required', 'auth_required')`,
  `CREATE INDEX runs_queue ON runs (team_id, state, queued_at)`,
  `CREATE INDEX runs_session ON runs (team_id, session_id, queued_at)`,
  ...rls("runs"),
  `CREATE POLICY runs_by_id ON runs FOR SELECT USING (id::text = current_setting('app.run_id', true))`,

  `CREATE TABLE steps (
        id            uuid PRIMARY KEY,
        team_id       text NOT NULL,
        run_id        uuid NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
        n             integer NOT NULL CHECK (n >= 1),
        kind          text NOT NULL CHECK (kind IN ('model', 'tool', 'summary')),
        at            timestamptz NOT NULL,
        tool          text,
        tool_call_id  text,
        input_tokens  bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
        output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
        UNIQUE (run_id, n)
      )`,
  ...rls("steps"),

  `CREATE TABLE triggers (
        id          uuid PRIMARY KEY,
        seq         bigint GENERATED ALWAYS AS IDENTITY,
        team_id     text NOT NULL,
        session_id  uuid NOT NULL,
        agent_id    uuid NOT NULL,
        sender      text NOT NULL CHECK (sender IN ('host', 'user')),
        user_id     text,
        event       text NOT NULL CHECK (char_length(event) BETWEEN 1 AND 200),
        reference   text NOT NULL CHECK (char_length(reference) BETWEEN 1 AND 200),
        body        jsonb,
        received_at timestamptz NOT NULL,
        run_id      uuid,
        FOREIGN KEY (team_id, session_id) REFERENCES sessions (team_id, id),
        UNIQUE (team_id, agent_id, sender, reference)
      )`,
  `CREATE INDEX triggers_session ON triggers (team_id, session_id, received_at)`,
  ...rls("triggers"),

  `CREATE TABLE questions (
        id          uuid PRIMARY KEY,
        team_id     text NOT NULL,
        session_id  uuid NOT NULL,
        run_id      uuid NOT NULL REFERENCES runs (id),
        kind        text NOT NULL CHECK (kind IN ('agent', 'runner')),
        cause       text,
        body        jsonb NOT NULL,
        state       text NOT NULL CHECK (state IN ('open', 'answered', 'withdrawn')),
        answer      jsonb,
        answered_by text,
        created_at  timestamptz NOT NULL,
        answered_at timestamptz,
        version     integer NOT NULL CHECK (version >= 1),
        FOREIGN KEY (team_id, session_id) REFERENCES sessions (team_id, id)
      )`,
  `CREATE INDEX questions_open ON questions (team_id, state, created_at)`,
  `CREATE UNIQUE INDEX questions_one_open_per_session ON questions (team_id, session_id) WHERE state = 'open'`,
  ...rls("questions"),

  `CREATE TABLE connections (
        id         uuid PRIMARY KEY,
        team_id    text NOT NULL,
        name       text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_]{0,19}$'),
        url        text NOT NULL,
        auth       text NOT NULL CHECK (auth IN ('key', 'oauth')),
        oauth      jsonb,
        revision   text,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        version    integer NOT NULL CHECK (version >= 1),
        UNIQUE (team_id, id),
        UNIQUE (team_id, name)
      )`,
  ...rls("connections"),

  `CREATE TABLE agent_credentials (
        team_id          text NOT NULL,
        agent_id         uuid NOT NULL,
        connection_id    uuid NOT NULL,
        kind             text NOT NULL CHECK (kind IN ('key', 'oauth')),
        secret           jsonb NOT NULL,
        access           jsonb,
        access_expires_at timestamptz,
        scope            text,
        state            text NOT NULL CHECK (state IN ('active', 'needs-auth')),
        created_at       timestamptz NOT NULL,
        updated_at       timestamptz NOT NULL,
        version          integer NOT NULL CHECK (version >= 1),
        PRIMARY KEY (team_id, agent_id, connection_id),
        FOREIGN KEY (team_id, agent_id) REFERENCES agents (team_id, id),
        FOREIGN KEY (team_id, connection_id) REFERENCES connections (team_id, id) ON DELETE CASCADE
      )`,
  ...rls("agent_credentials"),

  `CREATE TABLE oauth_pending (
        state         text PRIMARY KEY,
        team_id       text NOT NULL,
        agent_id      uuid NOT NULL,
        connection_id uuid NOT NULL,
        user_id       text NOT NULL,
        flow          jsonb NOT NULL,
        expires_at    timestamptz NOT NULL,
        FOREIGN KEY (team_id, connection_id) REFERENCES connections (team_id, id) ON DELETE CASCADE
      )`,
  ...rls("oauth_pending"),
  `CREATE POLICY oauth_pending_by_state ON oauth_pending FOR SELECT USING (state = current_setting('app.oauth_state', true))`,

  `CREATE TABLE usage (
        team_id       text NOT NULL,
        day           date NOT NULL,
        agent_id      uuid NOT NULL,
        user_id       text NOT NULL DEFAULT '',
        sessions      integer NOT NULL DEFAULT 0,
        runs          integer NOT NULL DEFAULT 0,
        input_tokens  bigint NOT NULL DEFAULT 0,
        output_tokens bigint NOT NULL DEFAULT 0,
        PRIMARY KEY (team_id, day, agent_id, user_id)
      )`,
  ...rls("usage"),
];

/** The schema of the server's own tables; its connections search it first (`search_path`). */
export const SERVER_SCHEMA = "agent_server";

export const MIGRATIONS: readonly Migration[] = [{ name: "0001-server", statements: SERVER }];

/** Brings the database to this version's tables: the directory, then the server's own. Answers the names applied now. */
export async function migrateDatabase(db: TransactionalSqlDatabase): Promise<string[]> {
  return [...(await migrateDirectory(db)), ...(await migrate(db, MIGRATIONS, SERVER_SCHEMA))];
}
