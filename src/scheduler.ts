import type { AgentStore } from "./agents.js";
import type { Directory } from "./directory/index.js";
import { agentHold, SUMMARY_LEAD_MS, type Runner } from "./runner.js";
import { dueRuns, RUN_SLICE_MS, type RunStore } from "./store.js";

/**
 * The server's own scheduler (requirement 0001, *Decided*; requirement
 * 0004): each tick, per team, a run whose slice is long over goes back to
 * the queue from its checkpoint (its runner is gone), a run waiting on a
 * service's task is queued when its poll is due, a waiting run gets its
 * summary before the cache goes cold, sessions asked to close after their
 * run close once it has ended, and due runs are handed to the runner, per
 * agent as many as its cap of active sessions leaves, none of a paused or
 * disabled agent. A run waiting for a free session is so picked up at the
 * first tick after one stops working, a fresh process's first included. Hourly,
 * transcripts of runs ended longer ago than the team's retention
 * (`directory.teams.retention_days`, 30 days when none is set) are purged
 * and sessions idle for 7 days close.
 */

/** A team's retention when the directory names none. */
export const TRANSCRIPT_DAYS = 30;
export const IDLE_SESSION_DAYS = 7;
const DAY_MS = 86_400_000;
/** A working run this long past its slice has no runner any more. */
const LOST_AFTER_MS = RUN_SLICE_MS + 5 * 60_000;

export function createScheduler({
  store,
  agents,
  directory,
  runner,
  now = () => new Date(),
  concurrency = 4,
  onError = (error: unknown) => console.error("fairlead-agent-server: scheduler:", error instanceof Error ? error.name : "error"),
}: {
  store: RunStore;
  agents: AgentStore;
  directory: Pick<Directory, "allTeams" | "roleOf" | "retentionDays">;
  runner: Runner;
  now?: () => Date;
  concurrency?: number;
  onError?: (error: unknown) => void;
}) {
  const working = new Set<string>();
  let lastHourly = 0;

  async function team(teamId: string, started: Promise<unknown>[]) {
    const runs = store.forTeam(teamId);
    const at = now();
    const open = await runs.listRuns({ states: ["queued", "working", "input_required", "auth_required"] });
    for (const run of open) {
      if (run.state === "working" && !working.has(run.id) && run.sliceStartedAt && at.getTime() - Date.parse(run.sliceStartedAt) > LOST_AFTER_MS)
        await runs.updateRun(run.id, run.version, { state: "queued", queuedAt: at.toISOString(), sliceStartedAt: null });
      if (run.state === "input_required" && run.waitingOn?.kind === "task" && Date.parse(run.waitingOn.nextPollAt) <= at.getTime()) await runs.updateRun(run.id, run.version, { state: "queued", queuedAt: at.toISOString() });
      if ((run.state === "input_required" || run.state === "auth_required") && run.cacheUntil && Date.parse(run.cacheUntil) - at.getTime() <= SUMMARY_LEAD_MS)
        await runner.summarize(teamId, run.id).catch(onError);
    }
    await runs.closeFinishedSessions(at);
    const team = agents.forTeam(teamId);
    const caps = new Map((await team.listAgents()).map((agent) => [agent.id, agent.maxActiveSessions]));
    for (const run of dueRuns(await runs.listRuns({ states: ["queued", "working"] }), at, (agentId) => caps.get(agentId) ?? 1)) {
      if (working.size >= concurrency) return;
      if (working.has(run.id) || (await agentHold(await team.findAgent(run.agentId), directory)) !== undefined) continue;
      working.add(run.id);
      started.push(
        runner
          .work(teamId, run.id)
          .catch(onError)
          .finally(() => working.delete(run.id)),
      );
    }
  }

  async function hourly(teamId: string) {
    const at = now();
    const runs = store.forTeam(teamId);
    const days = (await directory.retentionDays(teamId)) ?? TRANSCRIPT_DAYS;
    await runs.purgeTranscripts(new Date(at.getTime() - days * DAY_MS));
    await runs.closeIdleSessions(new Date(at.getTime() - IDLE_SESSION_DAYS * DAY_MS), at);
  }

  /** One pass over every team; answers the runs it started, to await in tests. */
  async function tick(): Promise<Promise<unknown>[]> {
    const started: Promise<unknown>[] = [];
    const due = now().getTime() - lastHourly >= 3_600_000;
    if (due) lastHourly = now().getTime();
    // ponytail: every team each tick; a queue of teams with work when there are many.
    for (const { id } of await directory.allTeams()) {
      try {
        if (due) await hourly(id);
        await team(id, started);
      } catch (error) {
        onError(error);
      }
    }
    return started;
  }

  let timer: NodeJS.Timeout | undefined;
  return {
    tick,
    start(intervalMs = 5_000) {
      const loop = async () => {
        await tick().catch(onError);
        timer = setTimeout(loop, intervalMs);
      };
      timer = setTimeout(loop, 0);
    },
    stop() {
      if (timer) clearTimeout(timer);
    },
  };
}
