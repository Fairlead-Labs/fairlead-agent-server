import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { migrate, MigrationError } from "../src/index.js";
import { migrateDatabase, MIGRATIONS, SERVER_SCHEMA } from "../src/migrations.js";
import { DIRECTORY_MIGRATIONS } from "../src/directory/migrations.js";

/** Requirement 0002 (HK11, HK12): the migrations the server applies at every start. */

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
});
