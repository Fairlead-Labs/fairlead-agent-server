import { PGlite } from "@electric-sql/pglite";
import { randomBytes, randomUUID } from "node:crypto";
import { DEFAULT_LIMITS, type Agent } from "../../src/agents.js";
import { createTeamSealer, localKeyWrapper, PostgresTeamKeyStore } from "../../src/keys.js";
import { migrateDatabase, SERVER_SCHEMA } from "../../src/migrations.js";
import type { Profile } from "../../src/profiles.js";

/**
 * A migrated database (PGlite: real Postgres semantics, in process), used as
 * a role that is neither superuser nor owner, so row-level security applies
 * as it does to the server in production.
 */
export async function database(): Promise<PGlite> {
  const db = new PGlite();
  await migrateDatabase(db);
  await db.exec(`
    CREATE ROLE app NOSUPERUSER;
    GRANT USAGE ON SCHEMA ${SERVER_SCHEMA}, directory TO app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${SERVER_SCHEMA}, directory TO app;
    SET search_path TO ${SERVER_SCHEMA};
    SET ROLE app;`);
  return db;
}

export const sealerFor = (db: PGlite) => createTeamSealer({ store: new PostgresTeamKeyStore(db), wrapper: localKeyWrapper(randomBytes(32)) });

export const T0 = "2026-11-21T12:00:00.000Z";

export function newAgent(teamId: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id: randomUUID(),
    teamId,
    name: "Clerk",
    description: "",
    ownerUserId: null,
    profileId: null,
    askOwners: true,
    limits: { ...DEFAULT_LIMITS },
    playbook: null,
    defaultOwnerUserIds: [],
    timeZone: "UTC",
    language: "en",
    paused: false,
    maxActiveSessions: 3,
    createdAt: T0,
    updatedAt: T0,
    removedAt: null,
    version: 1,
    ...overrides,
  };
}

export function newProfile(teamId: string, overrides: Partial<Profile> = {}): Profile {
  return {
    id: randomUUID(),
    teamId,
    name: "Claude",
    provider: "claude-api",
    model: "claude-sonnet-5-5",
    effort: null,
    cacheWindow: null,
    region: null,
    project: null,
    roleArn: null,
    endpoint: null,
    tenantId: null,
    clientId: null,
    apiKey: null,
    createdAt: T0,
    updatedAt: T0,
    version: 1,
    ...overrides,
  };
}
