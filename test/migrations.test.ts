import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { migrate, MigrationError } from "../src/index.js";
import { migrateDatabase, MIGRATIONS, SERVER_SCHEMA } from "../src/migrations.js";
import { DIRECTORY_MIGRATIONS } from "../src/directory/migrations.js";

/** Requirement 0002 (HK11, HK12, HK14): the migrations the server applies at every start, and the host views they add. */

describe("migrations (requirement 0002)", () => {
  it("HK11: applied once, in order, each recorded in its schema's ledger; a second start applies nothing", async () => {
    const db = new PGlite();
    expect(await migrateDatabase(db)).toEqual([...DIRECTORY_MIGRATIONS, ...MIGRATIONS].map((m) => m.name));
    expect(await migrateDatabase(db)).toEqual([]);
    const ledger = async (schema: string) => (await db.query<{ name: string }>(`SELECT name FROM ${schema}.schema_migrations ORDER BY name`)).rows.map((r) => r.name);
    expect(await ledger("directory")).toEqual(DIRECTORY_MIGRATIONS.map((m) => m.name));
    expect(await ledger(SERVER_SCHEMA)).toEqual(MIGRATIONS.map((m) => m.name));
    await db.close();
  });

  it("HK12: on a database another product shares, the server's tables are in its own schema and the directory in `directory`; nothing in `public` is created or touched", async () => {
    const db = new PGlite();
    await db.exec("CREATE TABLE public.agents (id text PRIMARY KEY); CREATE TABLE public.schema_migrations (version int); INSERT INTO public.agents VALUES ('theirs')");
    await migrateDatabase(db);
    const tables = (await db.query<{ name: string }>("SELECT table_schema || '.' || table_name AS name FROM information_schema.tables WHERE table_schema IN ('public', 'directory', 'agent_server') ORDER BY 1")).rows.map((r) => r.name);
    expect(tables.filter((t) => t.startsWith("public."))).toEqual(["public.agents", "public.schema_migrations"]);
    expect(tables).toEqual(expect.arrayContaining(["agent_server.agents", "agent_server.runs", "agent_server.schema_migrations", "directory.teams", "directory.schema_migrations"]));
    expect((await db.query("SELECT id FROM public.agents")).rows).toEqual([{ id: "theirs" }]);
    await db.close();
  });

  it("negative (HK11): a migration changed after it was applied, or one this version does not know, stops it and changes nothing", async () => {
    const db = new PGlite();
    const first = [{ name: "0001-a", statements: ["CREATE TABLE a (id int)"] }];
    await migrate(db, first, "x");
    await expect(migrate(db, [{ name: "0001-a", statements: ["CREATE TABLE a (id bigint)"] }], "x")).rejects.toBeInstanceOf(MigrationError);
    await expect(migrate(db, [], "x")).rejects.toThrow("does not know: 0001-a");
    await expect(migrate(db, [...first, { name: "0002-b", statements: ["CREATE TABLE b (id int)", "SELECT nonsense FROM nowhere"] }], "x")).rejects.toBeTruthy();
    const { rows } = await db.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'b'");
    expect(rows, "a failed migration leaves nothing behind").toEqual([]);
    await db.close();
  });

  it("HK14: the host views list exactly their admission columns, no content; read across teams by a role granted only them", async () => {
    const db = new PGlite();
    await migrateDatabase(db);
    const columns = async (view: string) =>
      (await db.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position", [SERVER_SCHEMA, view])).rows.map((r) => r.column_name);
    expect(await columns("host_runs")).toEqual(["id", "team_id", "agent_id", "state", "slice_ends_at", "step_id", "session_id"]);
    expect(await columns("host_agents")).toEqual(["id", "team_id", "owner_user_id", "removed_at"]);

    const [teamA, teamB, agentA, agentB, owner, session, run, idle, firstStep, lastStep] = ["team-a", "team-b", randomUUID(), randomUUID(), "user-1", randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const limits = JSON.stringify({ steps: 30, inputTokens: null, runsPerTrigger: 10 });
    await db.query(
      `INSERT INTO ${SERVER_SCHEMA}.agents (id, team_id, name, owner_user_id, limits, created_at, updated_at, removed_at, version) VALUES
         ($1, $3, 'Clerk', NULL, $5, now(), now(), NULL, 1), ($2, $4, 'Helper', $6, $5, now(), now(), '2026-11-22T10:00:00Z', 1)`,
      [agentA, agentB, teamA, teamB, limits, owner],
    );
    await db.query(`INSERT INTO ${SERVER_SCHEMA}.sessions (id, team_id, agent_id, state, created_at, updated_at, last_activity_at, version) VALUES ($1, $2, $3, 'open', now(), now(), now(), 1)`, [session, teamA, agentA]);
    await db.query(
      `INSERT INTO ${SERVER_SCHEMA}.runs (id, team_id, session_id, agent_id, state, cause, queued_at, claimed_at, slice_started_at, ended_at, transcript, version) VALUES
         ($1, $3, $4, $5, 'working', 'trigger', now(), now(), '2026-11-23T09:00:00Z', NULL, '{"secret": true}', 1),
         ($2, $3, $4, $5, 'completed', 'trigger', now(), NULL, NULL, now(), NULL, 1)`,
      [run, idle, teamA, session, agentA],
    );
    await db.query(`INSERT INTO ${SERVER_SCHEMA}.steps (id, team_id, run_id, n, kind, at) VALUES ($1, $3, $4, 1, 'model', now()), ($2, $3, $4, 2, 'tool', now())`, [firstStep, lastStep, teamA, run]);
    const tables = (await db.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY 1", [SERVER_SCHEMA])).rows.map((r) => r.table_name);
    expect(tables).toEqual(expect.arrayContaining(["agents", "runs", "steps", "sessions", "team_keys", "questions", "agent_credentials"]));

    await db.exec(`CREATE ROLE host NOSUPERUSER; GRANT USAGE ON SCHEMA ${SERVER_SCHEMA} TO host; GRANT SELECT ON ${SERVER_SCHEMA}.host_runs, ${SERVER_SCHEMA}.host_agents TO host; SET ROLE host`);
    const runs = (await db.query(`SELECT * FROM ${SERVER_SCHEMA}.host_runs ORDER BY state DESC`)).rows;
    expect(runs).toEqual([
      { id: run, team_id: teamA, agent_id: agentA, state: "working", slice_ends_at: new Date("2026-11-23T09:15:00Z"), step_id: lastStep, session_id: session },
      { id: idle, team_id: teamA, agent_id: agentA, state: "completed", slice_ends_at: null, step_id: null, session_id: session },
    ]);
    expect((await db.query(`SELECT * FROM ${SERVER_SCHEMA}.host_agents ORDER BY team_id`)).rows).toEqual([
      { id: agentA, team_id: teamA, owner_user_id: null, removed_at: null },
      { id: agentB, team_id: teamB, owner_user_id: owner, removed_at: new Date("2026-11-22T10:00:00Z") },
    ]);
    // Negative: no table of the schema, the ledger included, is readable through the views' grant.
    for (const table of tables) await expect(db.query(`SELECT 1 FROM ${SERVER_SCHEMA}.${table} LIMIT 1`), table).rejects.toThrow(/permission denied/);
    await db.close();
  });
});
