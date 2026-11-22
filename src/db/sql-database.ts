/**
 * Minimal SQL execution surface the Postgres adapters need. Both `pg`'s
 * Pool/Client and PGlite (real Postgres in-process, used in tests)
 * satisfy it structurally, so the adapters are tested against genuine
 * Postgres semantics without Docker or an external server.
 */
export interface SqlDatabase {
  query<Row = unknown>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Row[] }>;
}

/**
 * A database that runs work in one transaction on one session (for
 * row-level security): PGlite's own `transaction`; a `pg`
 * Pool gets one from `poolDatabase`. A `SET LOCAL` is
 * only worth anything inside such a transaction.
 */
export interface TransactionalSqlDatabase extends SqlDatabase {
  transaction<T>(work: (tx: SqlDatabase) => Promise<T>): Promise<T>;
}

/**
 * Runs `work` in one transaction with the given settings `SET LOCAL`
 * (`set_config(…, true)`): the row-level security policies
 * read them, so a statement sees only what they admit, and nothing once
 * the transaction ends.
 */
export function withSettings<T>(
  db: TransactionalSqlDatabase,
  settings: Readonly<Record<string, string>>,
  work: (tx: SqlDatabase) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    for (const [name, value] of Object.entries(settings)) {
      await tx.query("SELECT set_config($1, $2, true)", [name, value]);
    }
    return work(tx);
  });
}

/** The setting every team-owned table's policy compares `team_id` with. */
export const TEAM_SETTING = "app.team_id";

/** `work` inside the team: the Postgres adapters run every team-scoped statement this way. */
export function inTeam<T>(db: TransactionalSqlDatabase, teamId: string, work: (tx: SqlDatabase) => Promise<T>): Promise<T> {
  if (teamId === "") throw new Error("A team id is required");
  return withSettings(db, { [TEAM_SETTING]: teamId }, work);
}

/** What `poolDatabase` needs of a `pg` Pool: its queries, and one client for a transaction. */
export interface PgPool extends SqlDatabase {
  connect(): Promise<SqlDatabase & { release(): void }>;
}

/**
 * A `pg` Pool as a `TransactionalSqlDatabase`: plain queries on any
 * connection, a transaction on one client (`BEGIN` … `COMMIT`, `ROLLBACK`
 * on any error), which the row-level security settings need.
 */
export function poolDatabase(pool: PgPool): TransactionalSqlDatabase {
  return {
    query: (sql, params) => pool.query(sql, params),
    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await work(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
