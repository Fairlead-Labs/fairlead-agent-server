import { randomUUID } from "node:crypto";
import type { Agent, AgentStore } from "./agents.js";
import type { Directory } from "./directory/index.js";
import type { TeamSealer } from "./keys.js";
import { noNotifier, type Notifier } from "./notify.js";
import { agentHold } from "./runner.js";
import { dueRuns, newRun, OPEN_RUN_STATES, type Question, type Run, type RunStore, type Session, type TeamRunStore, type Trigger } from "./store.js";

/**
 * Work intake and the people's side of it (requirement 0004, *Sessions*,
 * *Work intake*): a trigger starts a session or continues one, and queues
 * its run where none is open; an answer resumes the run that waits on it;
 * owners close sessions and stop runs. The API and the host's triggers
 * both come through here; who may call what is the API's to judge.
 */

export class WorkError extends Error {
  constructor(readonly code: "not-found" | "invalid" | "closed" | "forbidden" | "conflict") {
    super(`Work: ${code}`);
    this.name = "WorkError";
  }
}

export interface TriggerInput {
  teamId: string;
  agentId: string;
  sender: Trigger["sender"];
  /** The person, for a trigger they sent through the API. */
  userId: string | null;
  event: string;
  reference: string;
  /** Data for the agent (a service's) or the person's message, as text. */
  body: string;
  sessionId?: string;
  ownerUserIds?: string[];
  priority?: Run["priority"];
  dueOn?: string;
  /** Close the session once this trigger's run has ended. */
  close?: boolean;
}

const EVENT = /^[\x21-\x7e]{1,200}$/;
export const MAX_BODY = 64 * 1024;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function createWork({
  store,
  agents,
  directory,
  sealer,
  notifier = noNotifier,
  now = () => new Date(),
}: {
  store: RunStore;
  agents: AgentStore;
  directory: Pick<Directory, "roleOf">;
  sealer: TeamSealer;
  notifier?: Notifier;
  now?: () => Date;
}) {
  const at = () => now().toISOString();

  /** The open run of a session, if any. */
  const openRun = async (runs: TeamRunStore, sessionId: string) => (await runs.listRuns({ sessionId, states: OPEN_RUN_STATES }))[0];

  /** Queues the session's next run unless one is open (a second open run is refused by the database). */
  async function queueRun(runs: TeamRunStore, session: Session, fields: Pick<Run, "priority" | "dueOn">) {
    if (await openRun(runs, session.id)) return;
    await runs
      .insertRun(newRun({ id: randomUUID(), teamId: session.teamId, sessionId: session.id, agentId: session.agentId, cause: "trigger", queuedAt: at(), ...fields }))
      .catch((error: unknown) => {
        if ((error as { code?: unknown }).code !== "23505") throw error;
      });
  }

  /** Whether the session's run waits for a free session: queued, and not among the agent's runs its cap lets start now. */
  async function waitsForCap(runs: TeamRunStore, agent: Agent, sessionId: string) {
    const live = await runs.listRuns({ agentId: agent.id, states: ["queued", "working"] });
    const mine = live.find((run) => run.sessionId === sessionId);
    return mine?.state === "queued" && Date.parse(mine.queuedAt) <= now().getTime() && !dueRuns(live, now(), () => agent.maxActiveSessions).some((run) => run.id === mine.id);
  }

  async function members(teamId: string, userIds: readonly string[]) {
    for (const id of userIds) if ((await directory.roleOf(teamId, id)) === undefined) throw new WorkError("invalid");
  }

  /** The owners of a new session: the agent's owner for a personal agent (with any named), else those named, else its starter, else its default owners. */
  const firstOwners = (agent: Agent, named: string[] | undefined, starter: string | null) =>
    agent.ownerUserId !== null ? [...new Set([agent.ownerUserId, ...(named ?? [])])] : (named ?? (starter ? [starter] : [...agent.defaultOwnerUserIds]));

  /** A run's state changed by compare-and-set, tried again while the runner saves meanwhile. */
  async function changeRun(runs: TeamRunStore, runId: string, change: (run: Run) => Parameters<TeamRunStore["updateRun"]>[2] | undefined): Promise<Run | undefined> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const run = await runs.findRun(runId);
      const changes = run && change(run);
      if (!run || !changes) return undefined;
      const next = await runs.updateRun(run.id, run.version, changes);
      if (next) return next;
    }
    throw new WorkError("conflict");
  }

  async function withdrawQuestions(runs: TeamRunStore, runId: string) {
    for (const question of await runs.listQuestions({ state: "open" })) if (question.runId === runId) await runs.updateQuestion(question.id, question.version, { state: "withdrawn" });
  }

  return {
    /**
     * A trigger in: the session it started or continued, whether its sender
     * had sent this reference before (then nothing new is queued), and
     * whether its session's run waits for a free session (the agent's cap of
     * active sessions). Never refused for the cap.
     */
    async receive(input: TriggerInput): Promise<{ sessionId: string; triggerId: string; duplicate: boolean; queued: boolean }> {
      if (!EVENT.test(input.event) || !EVENT.test(input.reference) || Buffer.byteLength(input.body) > MAX_BODY) throw new WorkError("invalid");
      if (input.dueOn !== undefined && (!DAY.test(input.dueOn) || Number.isNaN(Date.parse(input.dueOn)))) throw new WorkError("invalid");
      const agent = await agents.forTeam(input.teamId).findAgent(input.agentId);
      if ((await agentHold(agent, directory)) === "removed") throw new WorkError("not-found");
      const runs = store.forTeam(input.teamId);
      if (input.ownerUserIds) {
        if (input.ownerUserIds.length > 50) throw new WorkError("invalid");
        await members(input.teamId, input.ownerUserIds);
      }

      // A reference its sender sent before starts nothing new.
      const known = await runs.findTriggerByReference(agent!.id, input.sender, input.reference);
      if (known) return { sessionId: known.sessionId, triggerId: known.id, duplicate: true, queued: await waitsForCap(runs, agent!, known.sessionId) };

      let session: Session | undefined;
      if (input.sessionId !== undefined) {
        session = await runs.findSession(input.sessionId);
        if (!session || session.agentId !== agent!.id) throw new WorkError("not-found");
        if (session.state !== "open") throw new WorkError("closed");
      } else {
        const stamp = at();
        session = {
          id: randomUUID(),
          teamId: input.teamId,
          agentId: agent!.id,
          state: "open",
          closeReason: null,
          ownerUserIds: firstOwners(agent!, input.ownerUserIds, input.userId),
          startedByUserId: input.userId,
          createdAt: stamp,
          updatedAt: stamp,
          lastActivityAt: stamp,
          closedAt: null,
          closeAfterRun: false,
          version: 1,
        };
        // ponytail: two first sends of one reference at once may leave an empty session, closed as idle after 7 days.
        await runs.insertSession(session);
        await runs.addUsage(stamp.slice(0, 10), agent!.id, input.userId, { sessions: 1 });
      }

      const trigger: Trigger = {
        id: randomUUID(),
        teamId: input.teamId,
        sessionId: session.id,
        agentId: agent!.id,
        sender: input.sender,
        userId: input.userId,
        event: input.event,
        reference: input.reference,
        body: await sealer.seal(input.teamId, "trigger", input.body),
        receivedAt: at(),
        runId: null,
      };
      const stored = await runs.insertTrigger(trigger);
      if (stored.stored === "exists")
        return { sessionId: stored.trigger.sessionId, triggerId: stored.trigger.id, duplicate: true, queued: await waitsForCap(runs, agent!, stored.trigger.sessionId) };
      await runs.touchSession(session.id, trigger.receivedAt);
      await queueRun(runs, session, { priority: input.priority ?? null, dueOn: input.dueOn ?? null });
      if (input.close === true) await runs.closeAfterRun(session.id);
      return { sessionId: session.id, triggerId: trigger.id, duplicate: false, queued: await waitsForCap(runs, agent!, session.id) };
    },

    /** An answer to a question by one of its session's owners (any member while the session has none): the run that waits on it goes on, or, for a runner question answered `stop`, ends. */
    async answer(teamId: string, questionId: string, userId: string, answer: string): Promise<Question> {
      const runs = store.forTeam(teamId);
      const question = await runs.findQuestion(questionId);
      if (!question) throw new WorkError("not-found");
      const session = await runs.findSession(question.sessionId);
      if (!session || (session.ownerUserIds.length > 0 && !session.ownerUserIds.includes(userId))) throw new WorkError("forbidden");
      if (question.state !== "open") throw new WorkError("closed");
      const text = answer.trim();
      if (question.kind === "runner" ? text !== "continue" && text !== "stop" : text.length < 1 || text.length > 4000) throw new WorkError("invalid");
      const answered = await runs.updateQuestion(question.id, question.version, { state: "answered", answer: await sealer.seal(teamId, "answer", text), answeredBy: userId, answeredAt: at() });
      if (!answered) throw new WorkError("conflict");
      const stop = question.kind === "runner" && text === "stop";
      const run = await changeRun(runs, question.runId, (r) =>
        r.state === "input_required" && r.waitingOn && "questionId" in r.waitingOn && r.waitingOn.questionId === question.id
          ? stop
            ? { state: "cancelled", endedAt: at(), stopReason: "stopped-by-owner", waitingOn: null }
            : { state: "queued", queuedAt: at() }
          : undefined,
      );
      if (run && stop) notifier.notify({ type: "run.ended", teamId, agentId: run.agentId, sessionId: run.sessionId, runId: run.id, state: "cancelled", stopReason: "stopped-by-owner" });
      await runs.touchSession(session.id, at());
      return answered;
    },

    /** Stops an open run (`cancelled`); its open question is withdrawn. The runner's next save fails, and the host refuses the run from its next call. */
    async stopRun(teamId: string, runId: string): Promise<Run> {
      const runs = store.forTeam(teamId);
      const run = await changeRun(runs, runId, (r) => (OPEN_RUN_STATES.includes(r.state) ? { state: "cancelled", endedAt: at(), stopReason: "stopped", sliceStartedAt: null, waitingOn: null } : undefined));
      if (!run) throw new WorkError((await runs.findRun(runId)) ? "closed" : "not-found");
      await withdrawQuestions(runs, run.id);
      notifier.notify({ type: "run.ended", teamId, agentId: run.agentId, sessionId: run.sessionId, runId: run.id, state: "cancelled", stopReason: "stopped" });
      return run;
    },

    /** Closes a session: its open run stopped, no more triggers taken. */
    async closeSession(teamId: string, sessionId: string, reason: "closed" | "agent-removed" = "closed"): Promise<Session> {
      const runs = store.forTeam(teamId);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const session = await runs.findSession(sessionId);
        if (!session) throw new WorkError("not-found");
        if (session.state === "closed") return session;
        const open = await openRun(runs, sessionId);
        if (open) await this.stopRun(teamId, open.id).catch(() => undefined);
        const closed = await runs.updateSession(session.id, session.version, { state: "closed", closeReason: reason, closedAt: at(), updatedAt: at() });
        if (closed) return closed;
      }
      throw new WorkError("conflict");
    },

    async changeOwners(teamId: string, sessionId: string, version: number, ownerUserIds: string[]): Promise<Session> {
      if (ownerUserIds.length > 50) throw new WorkError("invalid");
      await members(teamId, ownerUserIds);
      const runs = store.forTeam(teamId);
      const session = await runs.updateSession(sessionId, version, { ownerUserIds: [...new Set(ownerUserIds)], updatedAt: at() });
      if (!session) throw new WorkError((await runs.findSession(sessionId)) ? "conflict" : "not-found");
      return session;
    },

    /** The agent was signed in again at a connection: its runs waiting on that go on. */
    async reconnected(teamId: string, agentId: string, connection: string): Promise<number> {
      const runs = store.forTeam(teamId);
      let resumed = 0;
      for (const run of await runs.listRuns({ agentId, states: ["auth_required"] })) {
        if (run.waitingOn?.kind !== "credential" || run.waitingOn.connection !== connection) continue;
        if (await runs.updateRun(run.id, run.version, { state: "queued", queuedAt: at() })) resumed += 1;
      }
      return resumed;
    },
  };
}

export type Work = ReturnType<typeof createWork>;
