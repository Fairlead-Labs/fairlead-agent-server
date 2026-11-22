import type { RunState } from "./store.js";

/**
 * The tool service's read of a run (`AgentRunReader`, requirement 0002,
 * HK4): by id across teams, as a key is read by its hash. The work store
 * answers it (`PostgresRunStore.findRun`); this is only what the run's
 * sign-in needs.
 */

/** What the tool service needs of a run to admit a call: nothing of its content. */
export interface RunAdmission {
  id: string;
  teamId: string;
  agentId: string;
  sessionId: string;
  state: RunState;
  /** When the current slice began (the claim); `null` before the first claim. */
  sliceStartedAt: string | null;
}

/** A run by its id across teams (the one crossing), or `undefined`. */
export interface AgentRunReader {
  findRun(runId: string): Promise<RunAdmission | undefined>;
}
