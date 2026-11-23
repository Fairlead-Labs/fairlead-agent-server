import { inTeam, withSettings, type SqlDatabase, type TransactionalSqlDatabase } from "./db/sql-database.js";
import type { TeamScoped } from "./db/team-scoped.js";
import type { SealedValue } from "./keys.js";
import type { AgentRunReader, RunAdmission } from "./runs.js";

/**
 * The work store (requirements 0001 and 0004): sessions, the triggers they
 * took, runs and their steps, questions and usage, on Postgres. Every
 * operation runs in its team's transaction, so row-level security on
 * `team_id` admits only that team's rows; the one crossing is a run read
 * by its id (`AgentRunReader`). `test/stores.test.ts` holds it to its
 * contract on PGlite.
 */

export const RUN_STATES = ["queued", "working", "input_required", "auth_required", "completed", "cancelled", "failed"] as const;
export type RunState = (typeof RUN_STATES)[number];
/** A run that has not ended: one per session at most. */
export const OPEN_RUN_STATES: readonly RunState[] = ["queued", "working", "input_required", "auth_required"];
export const ENDED_RUN_STATES: readonly RunState[] = ["completed", "cancelled", "failed"];

/** The server's own slice (requirement 0001, *Limits*): a run works 15 minutes at most, then checkpoints and is queued again. Never *None*. */
export const RUN_SLICE_MS = 15 * 60_000;

/** Why the runner asks the session's owners itself (requirement 0001, *Runner questions*). */
export const RUNNER_QUESTION_CAUSES = ["injection", "repeated-call", "unknown-outcome", "runs-used"] as const;
export type RunnerQuestionCause = (typeof RUNNER_QUESTION_CAUSES)[number];

/** Why a run was made: new work, an answer to the runs-used question, or the same work going on after a limit. Fixed at creation. */
export type RunCause = "trigger" | "answer" | "continue";

export interface Session {
  id: string;
  teamId: string;
  agentId: string;
  state: "open" | "closed";
  closeReason: "closed" | "idle" | "agent-removed" | null;
  /** Users of the team; empty = the whole team. */
  ownerUserIds: string[];
  /** The user who started it through the API (the user its usage counts for), else null. */
  startedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  closedAt: string | null;
  /** Closes once its run has ended and no trigger waits (a trigger's `close`). */
  closeAfterRun: boolean;
  version: number;
}

export interface Trigger {
  id: string;
  teamId: string;
  sessionId: string;
  agentId: string;
  sender: "host" | "user";
  userId: string | null;
  event: string;
  reference: string;
  /** The trigger's body, data for the agent, sealed (`trigger`); null once purged. */
  body: SealedValue | null;
  receivedAt: string;
  /** The run it was handed to; null until then. */
  runId: string | null;
}

/** What a run in `input_required` or `auth_required` waits for. `connection` null is the host connection. */
export type WaitingOn =
  | { kind: "question"; callId: string; questionId: string }
  | { kind: "runner-question"; callId: string | null; questionId: string; cause: RunnerQuestionCause }
  /** `connection` is the team connection's name. */
  | {
      kind: "task";
      callId: string;
      tool: string;
      connection: string | null;
      taskId: string;
      status: string;
      /** The service's floor (`pollIntervalMs`), and the interval in use, doubling to 15 minutes. */
      floorMs: number;
      intervalMs: number;
      nextPollAt: string;
    }
  | { kind: "credential"; callId: string; connection: string };

/** One object a tool answered about: the call that read it and its version (the service's own, else a hash), never content. */
export interface ReadVersion {
  callId: string;
  tool: string;
  version: string;
}

export interface Run {
  id: string;
  teamId: string;
  sessionId: string;
  agentId: string;
  state: RunState;
  cause: RunCause;
  priority: "high" | "medium" | "low" | null;
  dueOn: string | null;
  queuedAt: string;
  claimedAt: string | null;
  sliceStartedAt: string | null;
  endedAt: string | null;
  stopReason: string | null;
  /** The one model of the run (decided at its first step). */
  model: { format: string; model: string } | null;
  steps: number;
  inputTokens: number;
  outputTokens: number;
  /** Runner state: a result carried `injectionSuspected`; no summary washes it out (RN12). */
  injectionSuspected: boolean;
  readVersions: ReadVersion[];
  waitingOn: WaitingOn | null;
  /** When the prompt cache its last step paid for goes cold. */
  cacheUntil: string | null;
  /** Sealed under the team key; null once purged (30 days after the end). */
  transcript: SealedValue | null;
  summary: SealedValue | null;
  /** The run's final answer, sealed (`result`). */
  result: SealedValue | null;
  version: number;
}

export interface Step {
  id: string;
  runId: string;
  n: number;
  kind: "model" | "tool" | "summary";
  at: string;
  tool: string | null;
  toolCallId: string | null;
  inputTokens: number;
  outputTokens: number;
}

export interface Question {
  id: string;
  teamId: string;
  sessionId: string;
  runId: string;
  kind: "agent" | "runner";
  cause: RunnerQuestionCause | null;
  /** The question as asked, sealed (`question`). */
  body: SealedValue;
  state: "open" | "answered" | "withdrawn";
  /** The answer, sealed (`answer`). */
  answer: SealedValue | null;
  answeredBy: string | null;
  createdAt: string;
  answeredAt: string | null;
  version: number;
}

export interface UsageRow {
  day: string;
  agentId: string;
  userId: string;
  sessions: number;
  runs: number;
  inputTokens: number;
  outputTokens: number;
}

export type SessionChanges = Partial<Pick<Session, "state" | "closeReason" | "ownerUserIds" | "updatedAt" | "lastActivityAt" | "closedAt">>;
export type RunChanges = Partial<
  Pick<
    Run,
    | "state"
    | "cause"
    | "claimedAt"
    | "sliceStartedAt"
    | "endedAt"
    | "stopReason"
    | "model"
    | "steps"
    | "inputTokens"
    | "outputTokens"
    | "injectionSuspected"
    | "readVersions"
    | "waitingOn"
    | "cacheUntil"
    | "transcript"
    | "summary"
    | "result"
    | "queuedAt"
  >
>;
export type QuestionChanges = Partial<Pick<Question, "state" | "answer" | "answeredBy" | "answeredAt">>;

/** A team's sessions, triggers, runs, steps, questions and usage. */
export interface TeamRunStore {
  insertSession(session: Session): Promise<void>;
  findSession(id: string): Promise<Session | undefined>;
  listSessions(query?: { state?: Session["state"]; agentId?: string }): Promise<Session[]>;
  /** Compare-and-set on `version`; the new session, or undefined when it changed meanwhile. */
  updateSession(id: string, version: number, changes: SessionChanges): Promise<Session | undefined>;
  /** Closes open sessions without activity since `before` and without an open run (`idle`); answers how many. */
  closeIdleSessions(before: Date, at: Date): Promise<number>;
  /** Marks activity on an open session (a trigger, a run's end), whatever its version. */
  touchSession(id: string, at: string): Promise<void>;
  /** Marks an open session to close after its run; false when it is not open. */
  closeAfterRun(id: string): Promise<boolean>;
  /** Closes sessions marked to close that have no open run and no undelivered trigger (`closed`); answers how many. */
  closeFinishedSessions(at: Date): Promise<number>;

  /** `exists` (with the trigger stored before) when its sender already sent this reference for the agent. */
  insertTrigger(trigger: Trigger): Promise<{ stored: "ok" } | { stored: "exists"; trigger: Trigger }>;
  /** In the order they arrived. */
  listTriggers(sessionId: string, query?: { undelivered?: boolean }): Promise<Trigger[]>;
  findTriggerByReference(agentId: string, sender: Trigger["sender"], reference: string): Promise<Trigger | undefined>;
  /** Hands the triggers to a run (those still undelivered). */
  deliverTriggers(ids: readonly string[], runId: string): Promise<void>;

  insertRun(run: Run): Promise<void>;
  findRun(id: string): Promise<Run | undefined>;
  /** In the order they were made. */
  listRuns(query?: { states?: readonly RunState[]; sessionId?: string; agentId?: string }): Promise<Run[]>;
  /** Compare-and-set on `version`; undefined when it changed meanwhile, or would be a second open run of its session. */
  updateRun(id: string, version: number, changes: RunChanges): Promise<Run | undefined>;
  /** Queued → working at `now`, its slice starting; undefined when another claim won or its agent's working runs are at its cap of active sessions (requirement 0004). */
  claim(id: string, now: Date): Promise<Run | undefined>;

  /** Stored before the next; a step's number is unique in its run. */
  insertStep(step: Step): Promise<void>;
  listSteps(runId: string): Promise<Step[]>;

  insertQuestion(question: Question): Promise<void>;
  findQuestion(id: string): Promise<Question | undefined>;
  listQuestions(query?: { state?: Question["state"]; sessionId?: string }): Promise<Question[]>;
  updateQuestion(id: string, version: number, changes: QuestionChanges): Promise<Question | undefined>;

  /** Adds to the day's counters of an agent and user. */
  addUsage(day: string, agentId: string, userId: string | null, delta: Partial<Omit<UsageRow, "day" | "agentId" | "userId">>): Promise<void>;
  listUsage(from: string, to: string): Promise<UsageRow[]>;

  /** Drops transcripts, summaries, results and delivered triggers' bodies of runs ended before `before`; answers how many runs. */
  purgeTranscripts(before: Date): Promise<number>;
}

export type RunStore = TeamScoped<TeamRunStore> & AgentRunReader;

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 } as const;
const rank = (run: Run) => (run.priority === null ? 3 : PRIORITY_RANK[run.priority]);

/**
 * The runs to hand to the runner now (requirement 0001, RN2): queued for
 * now or earlier (a run waiting on a service's task is queued for its next
 * poll), by priority, then due date (none last), then the oldest (a tie in
 * the order given, `listRuns`' order of making); per
 * agent as many as its cap of active sessions leaves beside its working
 * runs (requirement 0004).
 */
export function dueRuns(runs: readonly Run[], now: Date, capOf: (agentId: string) => number): Run[] {
  const active = new Map<string, number>();
  for (const run of runs) if (run.state === "working") active.set(run.agentId, (active.get(run.agentId) ?? 0) + 1);
  const queued = runs
    .filter((run) => run.state === "queued" && Date.parse(run.queuedAt) <= now.getTime())
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (a.dueOn ?? "9999-12-31").localeCompare(b.dueOn ?? "9999-12-31") ||
        a.queuedAt.localeCompare(b.queuedAt),
    );
  const picked: Run[] = [];
  for (const run of queued) {
    const count = active.get(run.agentId) ?? 0;
    if (count >= capOf(run.agentId)) continue;
    active.set(run.agentId, count + 1);
    picked.push(run);
  }
  return picked;
}

/** A queued run with nothing done yet. */
export function newRun(fields: Pick<Run, "id" | "teamId" | "sessionId" | "agentId" | "cause" | "queuedAt"> & Partial<Pick<Run, "priority" | "dueOn" | "state" | "waitingOn">>): Run {
  return {
    state: "queued",
    priority: null,
    dueOn: null,
    claimedAt: null,
    sliceStartedAt: null,
    endedAt: null,
    stopReason: null,
    model: null,
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
    injectionSuspected: false,
    readVersions: [],
    waitingOn: null,
    cacheUntil: null,
    transcript: null,
    summary: null,
    result: null,
    version: 1,
    ...fields,
  };
}

type Row = Record<string, unknown>;
const iso = (value: unknown) => (value === null || value === undefined ? null : new Date(value as string).toISOString());
const day = (value: unknown) => (value === null || value === undefined ? null : value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10));
const isUniqueViolation = (error: unknown) => typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const json = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));

const SESSION_COLUMNS = "id, team_id, agent_id, state, close_reason, owner_user_ids, started_by_user_id, created_at, updated_at, last_activity_at, closed_at, close_after_run, version";
const RUN_COLUMNS = `id, team_id, session_id, agent_id, state, cause, priority, due_on, queued_at, claimed_at, slice_started_at, ended_at, stop_reason, model,
  steps, input_tokens, output_tokens, injection_suspected, read_versions, waiting_on, cache_until, transcript, summary, result, version`;
const TRIGGER_COLUMNS = "id, team_id, session_id, agent_id, sender, user_id, event, reference, body, received_at, run_id";
const QUESTION_COLUMNS = "id, team_id, session_id, run_id, kind, cause, body, state, answer, answered_by, created_at, answered_at, version";

const sessionOf = (row: Row): Session => ({
  id: row["id"] as string,
  teamId: row["team_id"] as string,
  agentId: row["agent_id"] as string,
  state: row["state"] as Session["state"],
  closeReason: (row["close_reason"] as Session["closeReason"]) ?? null,
  ownerUserIds: [...(row["owner_user_ids"] as string[])],
  startedByUserId: (row["started_by_user_id"] as string | null) ?? null,
  createdAt: iso(row["created_at"])!,
  updatedAt: iso(row["updated_at"])!,
  lastActivityAt: iso(row["last_activity_at"])!,
  closedAt: iso(row["closed_at"]),
  closeAfterRun: row["close_after_run"] as boolean,
  version: Number(row["version"]),
});

const runOf = (row: Row): Run => ({
  id: row["id"] as string,
  teamId: row["team_id"] as string,
  sessionId: row["session_id"] as string,
  agentId: row["agent_id"] as string,
  state: row["state"] as RunState,
  cause: row["cause"] as RunCause,
  priority: (row["priority"] as Run["priority"]) ?? null,
  dueOn: day(row["due_on"]),
  queuedAt: iso(row["queued_at"])!,
  claimedAt: iso(row["claimed_at"]),
  sliceStartedAt: iso(row["slice_started_at"]),
  endedAt: iso(row["ended_at"]),
  stopReason: (row["stop_reason"] as string | null) ?? null,
  model: (row["model"] as Run["model"]) ?? null,
  steps: Number(row["steps"]),
  inputTokens: Number(row["input_tokens"]),
  outputTokens: Number(row["output_tokens"]),
  injectionSuspected: row["injection_suspected"] as boolean,
  readVersions: (row["read_versions"] as Run["readVersions"]) ?? [],
  waitingOn: (row["waiting_on"] as Run["waitingOn"]) ?? null,
  cacheUntil: iso(row["cache_until"]),
  transcript: (row["transcript"] as Run["transcript"]) ?? null,
  summary: (row["summary"] as Run["summary"]) ?? null,
  result: (row["result"] as Run["result"]) ?? null,
  version: Number(row["version"]),
});

const triggerOf = (row: Row): Trigger => ({
  id: row["id"] as string,
  teamId: row["team_id"] as string,
  sessionId: row["session_id"] as string,
  agentId: row["agent_id"] as string,
  sender: row["sender"] as Trigger["sender"],
  userId: (row["user_id"] as string | null) ?? null,
  event: row["event"] as string,
  reference: row["reference"] as string,
  body: (row["body"] as SealedValue | null) ?? null,
  receivedAt: iso(row["received_at"])!,
  runId: (row["run_id"] as string | null) ?? null,
});

const questionOf = (row: Row): Question => ({
  id: row["id"] as string,
  teamId: row["team_id"] as string,
  sessionId: row["session_id"] as string,
  runId: row["run_id"] as string,
  kind: row["kind"] as Question["kind"],
  cause: (row["cause"] as RunnerQuestionCause | null) ?? null,
  body: row["body"] as SealedValue,
  state: row["state"] as Question["state"],
  answer: (row["answer"] as SealedValue | null) ?? null,
  answeredBy: (row["answered_by"] as string | null) ?? null,
  createdAt: iso(row["created_at"])!,
  answeredAt: iso(row["answered_at"]),
  version: Number(row["version"]),
});

const identity = (v: unknown) => v;
const SESSION_FIELDS: Record<keyof SessionChanges, [string, (value: unknown) => unknown]> = {
  state: ["state", identity],
  closeReason: ["close_reason", identity],
  ownerUserIds: ["owner_user_ids", identity],
  updatedAt: ["updated_at", identity],
  lastActivityAt: ["last_activity_at", identity],
  closedAt: ["closed_at", identity],
};
const RUN_FIELDS: Record<keyof RunChanges, [string, (value: unknown) => unknown]> = {
  state: ["state", identity],
  cause: ["cause", identity],
  queuedAt: ["queued_at", identity],
  claimedAt: ["claimed_at", identity],
  sliceStartedAt: ["slice_started_at", identity],
  endedAt: ["ended_at", identity],
  stopReason: ["stop_reason", identity],
  model: ["model", json],
  steps: ["steps", identity],
  inputTokens: ["input_tokens", identity],
  outputTokens: ["output_tokens", identity],
  injectionSuspected: ["injection_suspected", identity],
  readVersions: ["read_versions", json],
  waitingOn: ["waiting_on", json],
  cacheUntil: ["cache_until", identity],
  transcript: ["transcript", json],
  summary: ["summary", json],
  result: ["result", json],
};
const QUESTION_FIELDS: Record<keyof QuestionChanges, [string, (value: unknown) => unknown]> = {
  state: ["state", identity],
  answer: ["answer", json],
  answeredBy: ["answered_by", identity],
  answeredAt: ["answered_at", identity],
};

/** `SET a = $4, b = $5 …` for the changes given, after the three key parameters. */
function assignments(changes: object, fields: Record<string, [string, (value: unknown) => unknown]>) {
  const sets: string[] = ["version = version + 1"];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    const [column, convert] = fields[key]!;
    values.push(convert(value));
    sets.push(`${column} = $${3 + values.length}`);
  }
  return { sets: sets.join(", "), values };
}

class PostgresTeamRunStore implements TeamRunStore {
  constructor(
    private readonly db: TransactionalSqlDatabase,
    private readonly teamId: string,
  ) {}

  private tx<T>(work: (tx: SqlDatabase) => Promise<T>) {
    return inTeam(this.db, this.teamId, work);
  }

  private async update<T>(table: string, columns: string, fields: Record<string, [string, (value: unknown) => unknown]>, of: (row: Row) => T, id: string, version: number, changes: object) {
    if (!UUID.test(id)) return undefined;
    const { sets, values } = assignments(changes, fields);
    try {
      const { rows } = await this.tx((tx) => tx.query<Row>(`UPDATE ${table} SET ${sets} WHERE team_id = $1 AND id = $2 AND version = $3 RETURNING ${columns}`, [this.teamId, id, version, ...values]));
      return rows[0] && of(rows[0]);
    } catch (error) {
      if (isUniqueViolation(error)) return undefined;
      throw error;
    }
  }

  async insertSession(value: Session) {
    await this.tx((tx) =>
      tx.query(`INSERT INTO sessions (${SESSION_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`, [
        value.id,
        this.teamId,
        value.agentId,
        value.state,
        value.closeReason,
        value.ownerUserIds,
        value.startedByUserId,
        value.createdAt,
        value.updatedAt,
        value.lastActivityAt,
        value.closedAt,
        value.closeAfterRun,
        value.version,
      ]),
    );
  }

  async findSession(id: string) {
    if (!UUID.test(id)) return undefined;
    const { rows } = await this.tx((tx) => tx.query<Row>(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE team_id = $1 AND id = $2`, [this.teamId, id]));
    return rows[0] && sessionOf(rows[0]);
  }

  async listSessions(query: { state?: Session["state"]; agentId?: string } = {}) {
    if (query.agentId !== undefined && !UUID.test(query.agentId)) return [];
    const { rows } = await this.tx((tx) =>
      tx.query<Row>(
        `SELECT ${SESSION_COLUMNS} FROM sessions WHERE team_id = $1 AND ($2::text IS NULL OR state = $2) AND ($3::uuid IS NULL OR agent_id = $3) ORDER BY last_activity_at DESC, id`,
        [this.teamId, query.state ?? null, query.agentId ?? null],
      ),
    );
    return rows.map(sessionOf);
  }

  updateSession(id: string, version: number, changes: SessionChanges) {
    return this.update("sessions", SESSION_COLUMNS, SESSION_FIELDS, sessionOf, id, version, changes);
  }

  async closeIdleSessions(before: Date, at: Date) {
    const { rows } = await this.tx((tx) =>
      tx.query(
        `UPDATE sessions s SET state = 'closed', close_reason = 'idle', closed_at = $3, updated_at = $3, version = version + 1
         WHERE s.team_id = $1 AND s.state = 'open' AND s.last_activity_at < $2
           AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.team_id = $1 AND r.session_id = s.id AND r.state IN ('queued', 'working', 'input_required', 'auth_required'))
         RETURNING s.id`,
        [this.teamId, before.toISOString(), at.toISOString()],
      ),
    );
    return rows.length;
  }

  async touchSession(id: string, at: string) {
    if (!UUID.test(id)) return;
    await this.tx((tx) => tx.query("UPDATE sessions SET last_activity_at = GREATEST(last_activity_at, $3) WHERE team_id = $1 AND id = $2 AND state = 'open'", [this.teamId, id, at]));
  }

  async closeAfterRun(id: string) {
    if (!UUID.test(id)) return false;
    const { rows } = await this.tx((tx) =>
      tx.query("UPDATE sessions SET close_after_run = true, version = version + 1 WHERE team_id = $1 AND id = $2 AND state = 'open' RETURNING id", [this.teamId, id]),
    );
    return rows.length === 1;
  }

  async closeFinishedSessions(at: Date) {
    const { rows } = await this.tx((tx) =>
      tx.query(
        `UPDATE sessions s SET state = 'closed', close_reason = 'closed', closed_at = $2, updated_at = $2, version = version + 1
         WHERE s.team_id = $1 AND s.state = 'open' AND s.close_after_run
           AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.team_id = $1 AND r.session_id = s.id AND r.state IN ('queued', 'working', 'input_required', 'auth_required'))
           AND NOT EXISTS (SELECT 1 FROM triggers t WHERE t.team_id = $1 AND t.session_id = s.id AND t.run_id IS NULL)
         RETURNING s.id`,
        [this.teamId, at.toISOString()],
      ),
    );
    return rows.length;
  }

  async insertTrigger(value: Trigger): Promise<{ stored: "ok" } | { stored: "exists"; trigger: Trigger }> {
    return this.tx(async (tx) => {
      const { rows } = await tx.query<Row>(
        `INSERT INTO triggers (${TRIGGER_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (team_id, agent_id, sender, reference) DO NOTHING RETURNING id`,
        [value.id, this.teamId, value.sessionId, value.agentId, value.sender, value.userId, value.event, value.reference, json(value.body), value.receivedAt, value.runId],
      );
      if (rows.length === 1) return { stored: "ok" as const };
      const before = await tx.query<Row>(`SELECT ${TRIGGER_COLUMNS} FROM triggers WHERE team_id = $1 AND agent_id = $2 AND sender = $3 AND reference = $4`, [
        this.teamId,
        value.agentId,
        value.sender,
        value.reference,
      ]);
      return { stored: "exists" as const, trigger: triggerOf(before.rows[0]!) };
    });
  }

  async listTriggers(sessionId: string, query: { undelivered?: boolean } = {}) {
    if (!UUID.test(sessionId)) return [];
    const { rows } = await this.tx((tx) =>
      tx.query<Row>(`SELECT ${TRIGGER_COLUMNS} FROM triggers WHERE team_id = $1 AND session_id = $2 AND (NOT $3 OR run_id IS NULL) ORDER BY seq`, [
        this.teamId,
        sessionId,
        query.undelivered === true,
      ]),
    );
    return rows.map(triggerOf);
  }

  async findTriggerByReference(agentId: string, sender: Trigger["sender"], reference: string) {
    if (!UUID.test(agentId)) return undefined;
    const { rows } = await this.tx((tx) =>
      tx.query<Row>(`SELECT ${TRIGGER_COLUMNS} FROM triggers WHERE team_id = $1 AND agent_id = $2 AND sender = $3 AND reference = $4`, [this.teamId, agentId, sender, reference]),
    );
    return rows[0] && triggerOf(rows[0]);
  }

  async deliverTriggers(ids: readonly string[], runId: string) {
    if (ids.length === 0) return;
    await this.tx((tx) => tx.query("UPDATE triggers SET run_id = $3 WHERE team_id = $1 AND id = ANY($2::uuid[]) AND run_id IS NULL", [this.teamId, [...ids], runId]));
  }

  async insertRun(value: Run) {
    await this.tx((tx) =>
      tx.query(
        `INSERT INTO runs (${RUN_COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)`,
        [
          value.id,
          this.teamId,
          value.sessionId,
          value.agentId,
          value.state,
          value.cause,
          value.priority,
          value.dueOn,
          value.queuedAt,
          value.claimedAt,
          value.sliceStartedAt,
          value.endedAt,
          value.stopReason,
          json(value.model),
          value.steps,
          value.inputTokens,
          value.outputTokens,
          value.injectionSuspected,
          JSON.stringify(value.readVersions),
          json(value.waitingOn),
          value.cacheUntil,
          json(value.transcript),
          json(value.summary),
          json(value.result),
          value.version,
        ],
      ),
    );
  }

  async findRun(id: string) {
    if (!UUID.test(id)) return undefined;
    const { rows } = await this.tx((tx) => tx.query<Row>(`SELECT ${RUN_COLUMNS} FROM runs WHERE team_id = $1 AND id = $2`, [this.teamId, id]));
    return rows[0] && runOf(rows[0]);
  }

  async listRuns(query: { states?: readonly RunState[]; sessionId?: string; agentId?: string } = {}) {
    if ((query.sessionId !== undefined && !UUID.test(query.sessionId)) || (query.agentId !== undefined && !UUID.test(query.agentId))) return [];
    const { rows } = await this.tx((tx) =>
      tx.query<Row>(
        `SELECT ${RUN_COLUMNS} FROM runs WHERE team_id = $1 AND ($2::text[] IS NULL OR state = ANY($2)) AND ($3::uuid IS NULL OR session_id = $3)
           AND ($4::uuid IS NULL OR agent_id = $4) ORDER BY seq`,
        [this.teamId, query.states ? [...query.states] : null, query.sessionId ?? null, query.agentId ?? null],
      ),
    );
    return rows.map(runOf);
  }

  updateRun(id: string, version: number, changes: RunChanges) {
    return this.update("runs", RUN_COLUMNS, RUN_FIELDS, runOf, id, version, changes);
  }

  async claim(id: string, now: Date) {
    if (!UUID.test(id)) return undefined;
    return this.tx(async (tx) => {
      const queued = (await tx.query<{ agent_id: string }>("SELECT agent_id FROM runs WHERE team_id = $1 AND id = $2 AND state = 'queued'", [this.teamId, id])).rows[0];
      if (!queued) return undefined;
      // One claim per agent at a time: the count below then sees every working run committed before it.
      await tx.query("SELECT 1 FROM agents WHERE team_id = $1 AND id = $2 FOR UPDATE", [this.teamId, queued.agent_id]);
      const { rows } = await tx.query<Row>(
        `UPDATE runs SET state = 'working', claimed_at = $3, slice_started_at = $3, version = version + 1
         WHERE team_id = $1 AND id = $2 AND state = 'queued'
           AND (SELECT count(*) FROM runs w WHERE w.team_id = $1 AND w.agent_id = $4 AND w.state = 'working')
             < (SELECT a.max_active_sessions FROM agents a WHERE a.team_id = $1 AND a.id = $4)
         RETURNING ${RUN_COLUMNS}`,
        [this.teamId, id, now.toISOString(), queued.agent_id],
      );
      return rows[0] && runOf(rows[0]);
    });
  }

  async insertStep(step: Step) {
    await this.tx((tx) =>
      tx.query(
        `INSERT INTO steps (id, team_id, run_id, n, kind, at, tool, tool_call_id, input_tokens, output_tokens)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [step.id, this.teamId, step.runId, step.n, step.kind, step.at, step.tool, step.toolCallId, step.inputTokens, step.outputTokens],
      ),
    );
  }

  async listSteps(runId: string) {
    if (!UUID.test(runId)) return [];
    const { rows } = await this.tx((tx) =>
      tx.query<Row>("SELECT id, run_id, n, kind, at, tool, tool_call_id, input_tokens, output_tokens FROM steps WHERE team_id = $1 AND run_id = $2 ORDER BY n", [this.teamId, runId]),
    );
    return rows.map((row) => ({
      id: row["id"] as string,
      runId: row["run_id"] as string,
      n: Number(row["n"]),
      kind: row["kind"] as Step["kind"],
      at: iso(row["at"])!,
      tool: (row["tool"] as string | null) ?? null,
      toolCallId: (row["tool_call_id"] as string | null) ?? null,
      inputTokens: Number(row["input_tokens"]),
      outputTokens: Number(row["output_tokens"]),
    }));
  }

  async insertQuestion(value: Question) {
    await this.tx((tx) =>
      tx.query(`INSERT INTO questions (${QUESTION_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`, [
        value.id,
        this.teamId,
        value.sessionId,
        value.runId,
        value.kind,
        value.cause,
        json(value.body),
        value.state,
        json(value.answer),
        value.answeredBy,
        value.createdAt,
        value.answeredAt,
        value.version,
      ]),
    );
  }

  async findQuestion(id: string) {
    if (!UUID.test(id)) return undefined;
    const { rows } = await this.tx((tx) => tx.query<Row>(`SELECT ${QUESTION_COLUMNS} FROM questions WHERE team_id = $1 AND id = $2`, [this.teamId, id]));
    return rows[0] && questionOf(rows[0]);
  }

  async listQuestions(query: { state?: Question["state"]; sessionId?: string } = {}) {
    if (query.sessionId !== undefined && !UUID.test(query.sessionId)) return [];
    const { rows } = await this.tx((tx) =>
      tx.query<Row>(`SELECT ${QUESTION_COLUMNS} FROM questions WHERE team_id = $1 AND ($2::text IS NULL OR state = $2) AND ($3::uuid IS NULL OR session_id = $3) ORDER BY created_at, id`, [
        this.teamId,
        query.state ?? null,
        query.sessionId ?? null,
      ]),
    );
    return rows.map(questionOf);
  }

  updateQuestion(id: string, version: number, changes: QuestionChanges) {
    return this.update("questions", QUESTION_COLUMNS, QUESTION_FIELDS, questionOf, id, version, changes);
  }

  async addUsage(on: string, agentId: string, userId: string | null, delta: Partial<Omit<UsageRow, "day" | "agentId" | "userId">>) {
    await this.tx((tx) =>
      tx.query(
        `INSERT INTO usage (team_id, day, agent_id, user_id, sessions, runs, input_tokens, output_tokens) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (team_id, day, agent_id, user_id) DO UPDATE SET sessions = usage.sessions + EXCLUDED.sessions, runs = usage.runs + EXCLUDED.runs,
           input_tokens = usage.input_tokens + EXCLUDED.input_tokens, output_tokens = usage.output_tokens + EXCLUDED.output_tokens`,
        [this.teamId, on, agentId, userId ?? "", delta.sessions ?? 0, delta.runs ?? 0, delta.inputTokens ?? 0, delta.outputTokens ?? 0],
      ),
    );
  }

  async listUsage(from: string, to: string) {
    const { rows } = await this.tx((tx) =>
      tx.query<Row>(
        "SELECT day, agent_id, user_id, sessions, runs, input_tokens, output_tokens FROM usage WHERE team_id = $1 AND day BETWEEN $2 AND $3 ORDER BY day, agent_id, user_id",
        [this.teamId, from, to],
      ),
    );
    return rows.map((row) => ({
      day: day(row["day"])!,
      agentId: row["agent_id"] as string,
      userId: row["user_id"] as string,
      sessions: Number(row["sessions"]),
      runs: Number(row["runs"]),
      inputTokens: Number(row["input_tokens"]),
      outputTokens: Number(row["output_tokens"]),
    }));
  }

  async purgeTranscripts(before: Date) {
    return this.tx(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `UPDATE runs SET transcript = NULL, summary = NULL, result = NULL, version = version + 1
         WHERE team_id = $1 AND state IN ('completed', 'cancelled', 'failed') AND ended_at < $2 AND (transcript IS NOT NULL OR summary IS NOT NULL OR result IS NOT NULL)
         RETURNING id`,
        [this.teamId, before.toISOString()],
      );
      await tx.query(
        `UPDATE triggers t SET body = NULL FROM runs r
         WHERE t.team_id = $1 AND r.team_id = $1 AND r.id = t.run_id AND r.state IN ('completed', 'cancelled', 'failed') AND r.ended_at < $2 AND t.body IS NOT NULL`,
        [this.teamId, before.toISOString()],
      );
      await tx.query(
        `UPDATE questions q SET body = '{"purged":true}'::jsonb, answer = NULL FROM runs r
         WHERE q.team_id = $1 AND r.team_id = $1 AND r.id = q.run_id AND q.state <> 'open' AND r.state IN ('completed', 'cancelled', 'failed') AND r.ended_at < $2`,
        [this.teamId, before.toISOString()],
      );
      return rows.length;
    });
  }
}

interface AdmissionRow {
  id: string;
  team_id: string;
  agent_id: string;
  session_id: string;
  state: RunState;
  slice_started_at: Date | string | null;
}

export class PostgresRunStore implements RunStore {
  constructor(private readonly db: TransactionalSqlDatabase) {}

  forTeam(teamId: string): TeamRunStore {
    if (teamId === "") throw new Error("A team id is required");
    return new PostgresTeamRunStore(this.db, teamId);
  }

  /** The host's read of a run by its id, across teams, through the crossing policy on `app.run_id`: six columns, no content. */
  async findRun(runId: string): Promise<RunAdmission | undefined> {
    if (!UUID.test(runId)) return undefined;
    const row = await withSettings(this.db, { "app.run_id": runId }, async (tx) => {
      const { rows } = await tx.query<AdmissionRow>("SELECT id, team_id, agent_id, session_id, state, slice_started_at FROM runs WHERE id = $1", [runId]);
      return rows[0];
    });
    if (!row) return undefined;
    return {
      id: row.id,
      teamId: row.team_id,
      agentId: row.agent_id,
      sessionId: row.session_id,
      state: row.state,
      sliceStartedAt: row.slice_started_at === null ? null : new Date(row.slice_started_at).toISOString(),
    };
  }
}
