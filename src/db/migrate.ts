import { createHash } from "node:crypto";
import type { TransactionalSqlDatabase } from "./sql-database.js";

/**
 * Versioned migrations (requirement 0002, *Hosting*): a list per schema,
 * applied in order in one transaction under an advisory lock, with the
 * schema first in `search_path`, each recorded with its checksum in that
 * schema's `schema_migrations`. A migration already applied is never applied
 * again; one whose statements changed since stops the start, as does a
 * database ahead of the code.
 */

export interface Migration {
  name: string;
  statements: readonly string[];
}

/** An arbitrary constant: one lock for every process migrating this database. */
const LOCK = 7_340_611_028;

const checksum = (migration: Migration) => createHash("sha256").update(migration.statements.join("\n;\n")).digest("hex");

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

/** Applies the pending migrations of `list` in `schema` (a fixed identifier, never input); answers the names applied now. */
export async function migrate(db: TransactionalSqlDatabase, list: readonly Migration[], schema: string): Promise<string[]> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new MigrationError("A schema name is a lower-case identifier");
  return db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [LOCK]);
    await tx.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await tx.query(`SET LOCAL search_path TO ${schema}`);
    await tx.query(`CREATE TABLE IF NOT EXISTS ${schema}.schema_migrations (
        name       text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await tx.query<{ name: string; checksum: string }>(`SELECT name, checksum FROM ${schema}.schema_migrations`);
    const applied = new Map(rows.map((row) => [row.name, row.checksum]));
    const known = new Set(list.map((migration) => migration.name));
    for (const name of applied.keys()) if (!known.has(name)) throw new MigrationError(`The database has a migration this version does not know: ${name}`);
    const done: string[] = [];
    for (const [index, migration] of list.entries()) {
      const sum = checksum(migration);
      const stored = applied.get(migration.name);
      if (stored !== undefined) {
        if (stored !== sum) throw new MigrationError(`Migration ${migration.name} changed after it was applied`);
        if (done.length > 0) throw new MigrationError(`Migration ${list[index - 1]!.name} is applied out of order`);
        continue;
      }
      for (const statement of migration.statements) await tx.query(statement);
      await tx.query(`INSERT INTO ${schema}.schema_migrations (name, checksum) VALUES ($1, $2)`, [migration.name, sum]);
      done.push(migration.name);
    }
    return done;
  });
}
