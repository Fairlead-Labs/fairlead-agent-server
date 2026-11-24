import { migrate, type Migration } from "../db/migrate.js";
import type { TransactionalSqlDatabase } from "../db/sql-database.js";

/**
 * The directory's migrations (requirement 0003, *Shared with another
 * product*), in the schema `directory` with their own ledger,
 * `directory.schema_migrations`. This repository alone writes them; another
 * product sharing the database runs them in its own tests and reads the
 * ledger to know the version it finds. No other import of this repository
 * is needed for that (the `./directory` export).
 *
 * A released migration is never edited: a change is a new entry.
 */
export const DIRECTORY_MIGRATIONS: readonly Migration[] = [
  {
    name: "0001-directory",
    statements: [
      `CREATE TABLE directory.users (
        id         uuid PRIMARY KEY,
        issuer     text NOT NULL,
        subject    text NOT NULL,
        email      text,
        created_at timestamptz NOT NULL,
        UNIQUE (issuer, subject)
      )`,
      `CREATE TABLE directory.teams (
        id               uuid PRIMARY KEY,
        name             text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
        kind             text NOT NULL DEFAULT 'team' CHECK (kind IN ('team', 'personal')),
        personal_user_id uuid UNIQUE REFERENCES directory.users (id),
        created_at       timestamptz NOT NULL,
        CHECK ((kind = 'personal') = (personal_user_id IS NOT NULL))
      )`,
      `CREATE TABLE directory.members (
        team_id   uuid NOT NULL REFERENCES directory.teams (id) ON DELETE CASCADE,
        user_id   uuid NOT NULL REFERENCES directory.users (id),
        role      text NOT NULL CHECK (role IN ('admin', 'member')),
        joined_at timestamptz NOT NULL,
        PRIMARY KEY (team_id, user_id)
      )`,
      `CREATE INDEX members_user ON directory.members (user_id)`,
      `CREATE TABLE directory.invitations (
        id         uuid PRIMARY KEY,
        team_id    uuid NOT NULL REFERENCES directory.teams (id) ON DELETE CASCADE,
        email      text NOT NULL,
        role       text NOT NULL CHECK (role IN ('admin', 'member')),
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL
      )`,
      `CREATE INDEX invitations_team ON directory.invitations (team_id)`,
      `CREATE TABLE directory.join_codes (
        id         uuid PRIMARY KEY,
        team_id    uuid NOT NULL REFERENCES directory.teams (id) ON DELETE CASCADE,
        code_hash  text NOT NULL UNIQUE,
        role       text NOT NULL CHECK (role IN ('admin', 'member')),
        expires_at timestamptz NOT NULL,
        uses_left  integer NOT NULL CHECK (uses_left >= 0),
        created_at timestamptz NOT NULL
      )`,
      `CREATE INDEX join_codes_team ON directory.join_codes (team_id)`,
],
  },
  {
    // A deleted account (the sign-in service's `POST /users/deleted`): the user's row stays, marked;
    // a team's retention, one value read by every product sharing the directory for its own records (null: 30 days).
    name: "0002-deleted-users-team-retention",
    statements: [
      `ALTER TABLE directory.users ADD COLUMN deleted_at timestamptz`,
      `CREATE INDEX users_deleted ON directory.users (deleted_at) WHERE deleted_at IS NOT NULL`,
      `ALTER TABLE directory.teams ADD COLUMN retention_days integer CHECK (retention_days BETWEEN 0 AND 36500)`,
    ],
  },
];

/** Brings the `directory` schema to this version. */
export const migrateDirectory = (db: TransactionalSqlDatabase) => migrate(db, DIRECTORY_MIGRATIONS, "directory");
