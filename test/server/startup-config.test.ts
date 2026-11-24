import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { startPgliteServer } from "../support/pglite-server.js";

/**
 * The entry point (requirement 0002, HK2, HK3, HK6): its environment is
 * read only in `src/server/index.ts`, a missing or malformed value stops the
 * start naming the variable and never its value, and the database is
 * migrated before it listens. Run as a real child process against PGlite
 * over TCP, a fresh database for each start.
 */

const APP_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CANARY = `CANARY${randomUUID().replaceAll("-", "")}`;

const VALID: Record<string, string> = {
  DATABASE_URL: "",
  DATABASE_POOL_SIZE: "1",
  KMS_KEY: "projects/example-project/locations/europe-west3/keyRings/agents/cryptoKeys/teams",
  PUBLIC_URL: "https://agents.example.test",
  OIDC_ISSUER: "https://id.example.test",
  OIDC_AUDIENCE: "https://agents.example.test",
  HOST_MCP_URL: "https://host.example.test/mcp",
  HOST_MCP_AUDIENCE: "https://host.example.test",
  HOST_ISSUER: "https://accounts.example.test",
  HOST_AUDIENCE: "https://agents.example.test",
  HOST_SUBJECT: "host@example.test",
  HOST_WEBHOOK_URL: "https://host.example.test/hooks/agents",
  HOST_WEBHOOK_AUDIENCE: "https://host.example.test",
  PORT: "0",
};

type Probe = (baseUrl: string, db: PGlite) => Promise<void>;

async function start(env: Record<string, string | undefined>, probe?: Probe): Promise<{ code: number | null; output: string; tables: string[] }> {
  const db = new PGlite();
  await db.waitReady;
  const server = await startPgliteServer(db);
  try {
    const result = await run({ DATABASE_URL: server.url({ user: "agents", password: `pw-${CANARY}` }), ...env }, probe && ((url) => probe(url, db)));
    const { rows } = await db.query<{ name: string }>("SELECT table_schema || '.' || table_name AS name FROM information_schema.tables WHERE table_schema IN ('public', 'directory', 'agent_server') ORDER BY 1");
    return { ...result, tables: rows.map((row) => row.name) };
  } finally {
    await server.close();
    await db.close();
  }
}

function run(env: Record<string, string | undefined>, probe?: (baseUrl: string) => Promise<void>): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const merged = Object.fromEntries(Object.entries({ ...VALID, ...env }).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const child = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
      cwd: APP_ROOT,
      env: { PATH: process.env["PATH"] ?? "", ...merged },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let probing = false;
    const collect = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const port = /listening on port (\d+)/.exec(output)?.[1];
      if (port && !probing) {
        probing = true;
        void (probe ? probe(`http://127.0.0.1:${port}`) : Promise.resolve()).then(
          () => child.kill("SIGKILL"),
          (error: unknown) => { child.kill("SIGKILL"); reject(error); },
        );
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`entry point did not exit; output so far:\n${output}`));
    }, 20_000);
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

const PORTABLE: Record<string, string | undefined> = {
  KMS_KEY: undefined,
  HOST_MCP_AUDIENCE: undefined,
  HOST_ISSUER: undefined,
  HOST_AUDIENCE: undefined,
  HOST_SUBJECT: undefined,
  HOST_WEBHOOK_AUDIENCE: undefined,
  LOCAL_KEY: randomBytes(32).toString("base64"),
  HOST_MCP_TOKEN: `mcp-${CANARY}`,
  HOST_TOKEN: `host-${CANARY}`,
  HOST_WEBHOOK_SECRET: `whsec_${randomBytes(32).toString("base64")}`,
};
const NO_HOST: Record<string, undefined> = Object.fromEntries([...Object.keys(VALID), ...Object.keys(PORTABLE)].filter((name) => name.startsWith("HOST_")).map((name) => [name, undefined]));

describe("the entry point", () => {
  it("starts without any cloud provider (requirement 0002, HK2): a local key and shared tokens, none echoed; the database migrated first", async () => {
    const { output, tables } = await start(PORTABLE);
    expect(output).toContain("fairlead-agent-server listening on port");
    for (const secret of [CANARY, PORTABLE["LOCAL_KEY"]!, PORTABLE["HOST_WEBHOOK_SECRET"]!]) expect(output).not.toContain(secret);
    expect(tables).toEqual(expect.arrayContaining(["directory.teams", "agent_server.runs", "agent_server.schema_migrations"]));
  });

  it("finds its own tables in the schema agent_server through its connections (requirement 0002, HK12): a trigger for an unknown agent is a 404, not a missing table", async () => {
    let status = 0;
    await start(PORTABLE, async (baseUrl, db) => {
      const teamId = randomUUID();
      await db.query("INSERT INTO directory.teams (id, name, created_at) VALUES ($1, 'Ops', now())", [teamId]);
      const answer = await fetch(`${baseUrl}/triggers`, {
        method: "POST",
        headers: { Authorization: `Bearer ${PORTABLE["HOST_TOKEN"]}`, "Content-Type": "application/json" },
        body: JSON.stringify({ teamId, agentId: randomUUID(), event: "task.assigned", reference: "t-1" }),
      });
      status = answer.status;
    });
    expect(status).toBe(404);
  });

  it("starts with a complete configuration, naming no secret", async () => {
    const { output } = await start({});
    expect(output).toContain("fairlead-agent-server listening on port");
    expect(output).toContain("host triggers by tokens of https://accounts.example.test");
    expect(output).not.toContain(CANARY);
  });

  it("starts with no host at all (requirement 0004: a host is optional)", async () => {
    const { output } = await start({ ...PORTABLE, ...NO_HOST });
    expect(output).toContain("fairlead-agent-server listening on port");
    expect(output).toContain("host tools none; host triggers none; host webhook none");
  });

  it.each([
    ["KMS_KEY", "LOCAL_KEY"],
    ["HOST_MCP_AUDIENCE", "HOST_MCP_TOKEN"],
    ["HOST_WEBHOOK_AUDIENCE", "HOST_WEBHOOK_SECRET"],
    ["HOST_ISSUER", "HOST_TOKEN"],
  ])("negative (HK6): %s and %s both set stops the start (one way, never a silent pick)", async (google, portable) => {
    const { code, output } = await start({ [portable]: PORTABLE[portable] });
    expect(code).toBe(1);
    expect(output).toContain(`either ${google} or ${portable}`);
    expect(output).not.toContain(CANARY);
    expect(output).not.toContain(PORTABLE["LOCAL_KEY"]);
  });

  it.each([
    ["HOST_MCP_TOKEN", "HOST_MCP_URL"],
    ["HOST_WEBHOOK_SECRET", "HOST_WEBHOOK_URL"],
    ["HOST_SUBJECT", "HOST_ISSUER"],
  ])("negative (HK6): %s without %s stops the start", async (given, needed) => {
    const { code, output } = await start({ ...PORTABLE, ...NO_HOST, [given]: PORTABLE[given] ?? "host@example.test" });
    expect(code).toBe(1);
    expect(output).toContain(needed);
    expect(output).not.toContain(CANARY);
  });

  it("DL4: ACCOUNT_DELETION_* name the sign-in service's identity at POST /users/deleted; one of the three alone stops the start", async () => {
    const deletion = { ACCOUNT_DELETION_ISSUER: "https://accounts.example.test", ACCOUNT_DELETION_AUDIENCE: "https://agents.example.test/users/deleted", ACCOUNT_DELETION_SUBJECT: "sign-in@example.test" };
    expect((await start({ ...PORTABLE, ...deletion })).output).toContain("deleted accounts told by tokens of https://accounts.example.test");
    expect((await start({ ...PORTABLE })).output).toContain("deleted accounts not taken");
    const { code, output } = await start({ ...PORTABLE, ACCOUNT_DELETION_SUBJECT: deletion.ACCOUNT_DELETION_SUBJECT });
    expect(code).toBe(1);
    expect(output).toContain("ACCOUNT_DELETION_ISSUER, ACCOUNT_DELETION_AUDIENCE and ACCOUNT_DELETION_SUBJECT");
    expect((await start({ ...PORTABLE, ...deletion, ACCOUNT_DELETION_ISSUER: `http://accounts.example.test/${CANARY}` })).output).not.toContain(CANARY);
  }, 30_000);

  it.each([
    ["LOCAL_KEY", randomBytes(16).toString("base64")],
    ["LOCAL_KEY", `not base64 ${CANARY}`],
    ["HOST_MCP_TOKEN", "short"],
    ["HOST_MCP_TOKEN", `with space ${CANARY}`],
    ["HOST_TOKEN", "short"],
    ["HOST_WEBHOOK_SECRET", `whsec_short${CANARY.slice(0, 4)}`],
    ["HOST_WEBHOOK_SECRET", randomBytes(32).toString("base64")],
  ])("negative (HK3): a malformed %s stops the start, its value never echoed", async (name, value) => {
    const { code, output } = await start({ ...PORTABLE, [name]: value });
    expect(code).toBe(1);
    expect(output).toContain(name);
    expect(output).not.toContain(value);
    expect(output).not.toContain("listening");
  });

  const missing = ["OIDC_ISSUER", "OIDC_AUDIENCE", "DATABASE_URL", "KMS_KEY", "PUBLIC_URL", "HOST_MCP_AUDIENCE", "HOST_AUDIENCE", "HOST_SUBJECT"];
  it.each(missing)("negative (HK3): %s missing stops the start", async (name) => {
    const { code, output } = await start({ [name]: undefined });
    expect(code).toBe(1);
    expect(output).toContain(name);
    expect(output).not.toContain("listening");
  });

  it.each([
    ["DATABASE_URL", `mysql://u:pw-${CANARY}@h/db`],
    ["KMS_KEY", `teams-${CANARY}`],
    ["KMS_ENDPOINT", `http://kms.example.test/${CANARY}`],
    ["PUBLIC_URL", `http://agents.example.test/${CANARY}`],
    ["HOST_MCP_URL", `http://host.example.test/mcp?${CANARY}`],
    ["HOST_MCP_AUDIENCE", `not a url ${CANARY}`],
    ["HOST_ISSUER", `http://accounts.example.test/${CANARY}`],
    ["HOST_WEBHOOK_URL", `http://host.example.test/${CANARY}`],
    ["OIDC_ISSUER", `http://id.example.test/${CANARY}`],
    ["OIDC_AUDIENCE", `two words ${CANARY}`],
    ["OIDC_ROLES_CLAIM", `no spaces ${CANARY}`],
    ["OIDC_ADMIN_ROLE", `no spaces ${CANARY}`],
    ["TEAM_CREATION", `everyone-${CANARY}`],
    ["PORT", "70000"],
  ])("negative (HK3): a malformed %s stops the start, its value never echoed", async (name, value) => {
    const { code, output } = await start({ [name]: value });
    expect(code).toBe(1);
    expect(output).toContain(name);
    expect(output).not.toContain(CANARY);
    expect(output).not.toContain("listening");
  });

  it("HK13: CORS_ORIGINS names the origins whose browsers may call; another origin gets no CORS header", async () => {
    const answers: Record<string, string | null> = {};
    const { output } = await start({ ...PORTABLE, CORS_ORIGINS: "https://ui.example.test, http://localhost:5173" }, async (baseUrl) => {
      for (const origin of ["https://ui.example.test", "http://localhost:5173", "https://evil.example.test"]) {
        const answer = await fetch(`${baseUrl}/me`, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "GET" } });
        answers[origin] = answer.headers.get("access-control-allow-origin");
      }
    });
    expect(output).toContain("browsers from 2 origins");
    expect(answers).toEqual({ "https://ui.example.test": "https://ui.example.test", "http://localhost:5173": "http://localhost:5173", "https://evil.example.test": null });
  });

  it.each([
    `http://ui.example.test/${CANARY}`,
    `http://ui-${CANARY}.example.test`,
    `https://ui.example.test/${CANARY}`,
    `https://ui.example.test/`,
    `https://ui.example.test?${CANARY}`,
    `https://ui.example.test,,https://${CANARY}.example.test`,
    `garbage-${CANARY}`,
    `*`,
  ])("negative (HK13): a malformed CORS_ORIGINS (%s) stops the start, its value never echoed", async (value) => {
    const { code, output } = await start({ ...PORTABLE, CORS_ORIGINS: value });
    expect(code).toBe(1);
    expect(output).toContain("CORS_ORIGINS");
    expect(output).not.toContain(CANARY);
    expect(output).not.toContain("listening");
  });

  it("negative (HK3): a database that cannot be reached stops the start, its URL never echoed", async () => {
    const { code, output } = await run({ ...PORTABLE, DATABASE_URL: `postgres://agents:pw-${CANARY}@127.0.0.1:1/agents` });
    expect(code).toBe(1);
    expect(output).toContain("could not be migrated");
    expect(output).not.toContain(CANARY);
  });
});
