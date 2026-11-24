import { createHash, randomUUID } from "node:crypto";
import { mayUseProfile, type Agent, type AgentStore, type ModelChoice } from "./agents.js";
import type { Directory } from "./directory/index.js";
import type { TeamSealer } from "./keys.js";
import { McpAuthError, McpError, McpUnavailableError, TERMINAL_TASK_STATUSES, type McpTask, type ToolResult } from "./mcp/client.js";
import {
  createModelClient,
  ModelHttpError,
  type AssistantPart,
  type ClientContext,
  type FunctionTool,
  type JsonObject,
  type Message,
  type ModelClient,
  type ModelTurn,
  type TeamIdentity,
  type ToolCallPart,
  type UserPart,
} from "./model/index.js";
import { noNotifier, type Notifier } from "./notify.js";
import { modelTargetOf } from "./profiles.js";
import { ASK_PERSON, ASK_PERSON_TOOL, ASKING_PLAYBOOK, envelope, loadPlaybooks, READ_PLAYBOOK, READ_PLAYBOOK_TOOL, systemPrompt, WORK_PLAYBOOK, type Playbook, type PlaybookLanguage } from "./prompt.js";
import {
  newRun,
  OPEN_RUN_STATES,
  RUN_SLICE_MS,
  type Question,
  type ReadVersion,
  type Run,
  type RunChanges,
  type RunnerQuestionCause,
  type RunStore,
  type Session,
  type TeamRunStore,
  type Trigger,
  type WaitingOn,
} from "./store.js";
import { CredentialNeededError, RunRefusedError, type RecordedOutcome, type RunCallLog, type RunTool, type RunTools, type ToolHub } from "./tools.js";

/**
 * The loop (requirement 0001, *The loop*, *Limits*, *Parking and resuming*,
 * *Runner questions*; requirement 0004): a claimed run's steps, each one
 * model call whose tool calls go to the agent's services as the agent.
 * A run starts from the session's last summary and the triggers it has not
 * seen; triggers that arrive meanwhile reach it at its next step. It waits
 * (in Postgres, holding nothing) for an answer to its question, a service's
 * task or a person signing it in again, and resumes with the outcome as
 * the result of the call that waited. Each step is stored before the next;
 * transcript, summary and result are sealed under the team key; the
 * injection mark is runner state. The runner's own questions are raised
 * only by the runner, never by a playbook or the model.
 */

export interface RunnerDependencies {
  store: RunStore;
  agents: AgentStore;
  directory: Pick<Directory, "roleOf" | "findTeam">;
  sealer: TeamSealer;
  tools: ToolHub;
  /** The host's record of calls; without one a cut-off write is an unknown outcome. */
  calls?: RunCallLog;
  identity: TeamIdentity;
  notifier?: Notifier;
  now?: () => Date;
  /** Characters of one tool answer the model sees (RN5). */
  answerBudget?: number;
  maxOutputTokens?: number;
  /** The model client for a run; default the adapters over `fetch`. */
  client?: (choice: ModelChoice, context: ClientContext) => ModelClient;
}

export type WorkOutcome = "not-claimed" | "completed" | "waiting" | "queued" | "stopped" | "failed" | "cancelled";

/** The transcript as sealed: what the model saw, append-only. */
interface Transcript {
  system: string[];
  messages: Message[];
  /** With a summary made while waiting: the model sees the first message, the summary, then the messages from here on. */
  summaryAt?: number;
  language: PlaybookLanguage;
}

/** A slice ends with a minute to spare, so the host never refuses a call mid-step. */
const SLICE_MARGIN_MS = 60_000;
const DEFAULT_BUDGET = 20_000;
const POLL_FIRST_MS = 10_000;
const POLL_MAX_MS = 15 * 60_000;
const UNAVAILABLE_RETRY_MS = 60_000;

const SUMMARY_INSTRUCTION =
  "Write where this work stands, for yourself, to continue from in a later run. Hold: what was asked, by whom; what is done; the decisions taken; " +
  "the facts found, each with the ids it came from; what is open, and what you wait for, with any open question word for word. " +
  "Keep what an earlier summary held that still matters. Plain text, no tool calls.";

/** A summary while waiting is due this long before the paid cache window closes … */
export const SUMMARY_LEAD_MS = 90_000;
/** … and only above this conversation size (where a cold resume costs about the same). */
export const SUMMARY_MIN_TOKENS = 30_000;

class RunStopped extends Error {}

const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value !== null && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
          .join(",")}}`
      : JSON.stringify(value);

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const withoutEnvelopes = (text: string) => text.replace(/<\/?untrusted-[a-z2-7]{6}>/g, "");
const dayOf = (at: Date) => at.toISOString().slice(0, 10);

/** Does any field `injectionSuspected` say true (a service's prompt-injection mark)? */
function marked(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(marked);
  if (value !== null && typeof value === "object") return Object.entries(value).some(([key, v]) => (key === "injectionSuspected" && v === true) || marked(v));
  return false;
}

/** The service's own version where the answer carries one, else a hash of what the agent saw. */
function versionOf(answer: ToolResult): string {
  const look = (value: unknown, depth: number): string | undefined => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    for (const key of ["updatedAt", "etag", "version"]) if (typeof record[key] === "string" || typeof record[key] === "number") return `${key}:${record[key]}`;
    if (typeof record["uidValidity"] === "number" && typeof record["uid"] === "number") return `uid:${record["uidValidity"]}/${record["uid"]}`;
    if (depth > 0) for (const v of Object.values(record)) if (look(v, depth - 1)) return look(v, depth - 1);
    return undefined;
  };
  return look(answer.structured, 1) ?? `sha256:${sha(withoutEnvelopes(answer.text))}`;
}

const cut = (text: string, budget: number) => (text.length <= budget ? text : `${text.slice(0, budget)}\n[cut: ${text.length - budget} more characters]`);
const textOf = (parts: readonly AssistantPart[]) =>
  parts
    .filter((p): p is Extract<AssistantPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n");

/** Why the agent may not run now: removed, paused, or a personal agent whose owner left the team. */
export async function agentHold(agent: Agent | undefined, directory: Pick<Directory, "roleOf">): Promise<"removed" | "paused" | "owner-left" | undefined> {
  if (!agent || agent.removedAt !== null) return "removed";
  if (agent.paused) return "paused";
  if (agent.ownerUserId !== null && (await directory.roleOf(agent.teamId, agent.ownerUserId)) === undefined) return "owner-left";
  return undefined;
}

export function createRunner(deps: RunnerDependencies) {
  const now = deps.now ?? (() => new Date());
  const notifier = deps.notifier ?? noNotifier;
  const budget = deps.answerBudget ?? DEFAULT_BUDGET;
  const maxOutputTokens = deps.maxOutputTokens ?? 8192;
  const playbooks: Record<PlaybookLanguage, Playbook[]> = { en: loadPlaybooks("en"), de: loadPlaybooks("de") };
  const clientFor = deps.client ?? ((choice: ModelChoice, context: ClientContext) => createModelClient(choice.target, context));

  /** The agent's model: its profile, if it may use it, its API key opened. */
  async function modelOf(teamId: string, agent: Agent): Promise<ModelChoice | undefined> {
    if (agent.profileId === null) return undefined;
    const profile = await deps.agents.forTeam(teamId).findProfile(agent.profileId);
    if (!profile || !mayUseProfile(agent, profile)) return undefined;
    const apiKey = profile.apiKey === null ? undefined : await deps.sealer.open(teamId, "model-key", profile.apiKey);
    const target = modelTargetOf(profile, apiKey);
    if (!target) return undefined;
    return { target, ...(profile.effort ? { effort: profile.effort } : {}), ...(profile.cacheWindow ? { cacheTtl: profile.cacheWindow } : {}) };
  }

  /** Claims a queued run and works it until it ends, waits, reaches the end of its slice or is stopped. */
  async function work(teamId: string, runId: string): Promise<WorkOutcome> {
    const runs = deps.store.forTeam(teamId);
    const claimed = await runs.claim(runId, now());
    if (!claimed) return "not-claimed";
    const session = await runs.findSession(claimed.sessionId);
    const agent = await deps.agents.forTeam(teamId).findAgent(claimed.agentId);
    const hold = await agentHold(agent, deps.directory);
    const stop = async (state: "cancelled" | "queued", reason: string) => {
      await runs.updateRun(claimed.id, claimed.version, state === "queued" ? { state, sliceStartedAt: null } : { state, endedAt: now().toISOString(), stopReason: reason, sliceStartedAt: null });
      return state === "queued" ? ("queued" as const) : ("cancelled" as const);
    };
    if (!session || session.state !== "open") return stop("cancelled", "session-closed");
    if (hold === "removed") return stop("cancelled", "agent-removed");
    if (hold) return stop("queued", hold);
    if (claimed.transcript === null && claimed.steps === 0) await runs.addUsage(dayOf(now()), claimed.agentId, session.startedByUserId, { runs: 1 });
    try {
      return await new Work(teamId, runs, claimed, session, agent!).go();
    } catch (error) {
      if (error instanceof RunStopped || error instanceof RunRefusedError) return "stopped";
      throw error;
    }
  }

  class Work {
    private transcript!: Transcript;
    private tools!: RunTools;
    private client!: ModelClient;
    private n = 0;
    private summaryText: string | undefined;

    constructor(
      private readonly teamId: string,
      private readonly runs: TeamRunStore,
      private run: Run,
      private readonly session: Session,
      private agent: Agent,
    ) {}

    async go(): Promise<WorkOutcome> {
      const choice = await modelOf(this.teamId, this.agent);
      if (!choice) return this.end("failed", "no-profile");
      this.client = clientFor(choice, { teamId: this.teamId, identity: deps.identity, cacheKey: this.run.id, ...(choice.cacheTtl ? { cacheTtl: choice.cacheTtl } : {}) });
      // One model per run (RN5): a changed profile ends this run; the work goes on in a new one on the new model.
      if (this.run.model && (this.run.model.format !== this.client.format || this.run.model.model !== this.client.model)) {
        await this.end("completed", "model-changed");
        await this.queueNext("continue");
        return "completed";
      }
      this.n = (await this.runs.listSteps(this.run.id)).length;
      try {
        this.tools = await deps.tools.open(this.teamId, this.agent.id, this.run.id, [ASK_PERSON, READ_PLAYBOOK]);
      } catch (error) {
        if (error instanceof McpUnavailableError || error instanceof McpError || error instanceof McpAuthError) return this.later(UNAVAILABLE_RETRY_MS);
        throw error;
      }

      if (this.run.transcript) {
        this.transcript = JSON.parse(await deps.sealer.open(this.teamId, "transcript", this.run.transcript)) as Transcript;
        if (this.run.summary) this.summaryText = await deps.sealer.open(this.teamId, "summary", this.run.summary);
        const waited = await this.resume();
        if (waited) return waited;
      } else {
        await this.begin();
      }
      return this.loop();
    }

    private get modelTools(): FunctionTool[] {
      const own = this.agent.askOwners ? [ASK_PERSON_TOOL, READ_PLAYBOOK_TOOL] : [READ_PLAYBOOK_TOOL];
      return [...this.tools.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })), ...own];
    }

    // ---- the start: the system prompt, the playbooks, the last summary and the new work (RN3)

    private async begin() {
      const team = await deps.directory.findTeam(this.teamId);
      const language = this.agent.language;
      const system = systemPrompt({
        agentName: this.agent.name,
        teamName: team?.kind === "personal" ? null : (team?.name ?? null),
        timeZone: this.agent.timeZone,
        now: now(),
        playbooks: playbooks[language],
        loaded: [WORK_PLAYBOOK, ...(this.agent.askOwners ? [ASKING_PLAYBOOK] : [])],
        agentPlaybook: this.agent.playbook,
      });
      const parts: string[] = [];
      const summary = await this.lastSummary();
      if (summary) parts.push(`Where this work stands (your own summary from the session's last run, written from what you read):\n${envelope(summary)}`);
      const fresh = await this.takeTriggers();
      if (fresh) parts.push(fresh);
      else parts.push("Nothing new arrived: continue the work from where it stands.");
      if (this.tools.unavailable.length > 0)
        parts.push(`Not available in this run: ${this.tools.unavailable.map((u) => `${u.connection} (${u.reason === "needs-auth" ? "a person has to sign you in again" : "it did not answer"})`).join(", ")}.`);
      this.transcript = { system, messages: [{ role: "user", content: [{ type: "text", text: parts.join("\n\n") }] }], language };
      await this.save({ model: { format: this.client.format, model: this.client.model }, waitingOn: null });
    }

    /** The newest summary of an earlier run of the session. */
    private async lastSummary(): Promise<string | undefined> {
      const earlier = (await this.runs.listRuns({ sessionId: this.session.id })).filter((r) => r.id !== this.run.id && r.summary !== null);
      const last = earlier.at(-1);
      return last ? deps.sealer.open(this.teamId, "summary", last.summary!) : undefined;
    }

    /** The session's triggers no run has seen, handed to this run, as one text; undefined when none. */
    private async takeTriggers(): Promise<string | undefined> {
      const triggers = await this.runs.listTriggers(this.session.id, { undelivered: true });
      if (triggers.length === 0) return undefined;
      const texts: string[] = [];
      for (const trigger of triggers) texts.push(await this.triggerText(trigger));
      await this.runs.deliverTriggers(
        triggers.map((t) => t.id),
        this.run.id,
      );
      return texts.join("\n\n");
    }

    private async triggerText(trigger: Trigger): Promise<string> {
      const body = trigger.body ? await deps.sealer.open(this.teamId, "trigger", trigger.body) : "";
      if (trigger.sender === "user") return `A message from a person of the team (${trigger.receivedAt}):\n${cut(body, budget)}`;
      // From a service: data, never instructions of their own.
      return `New work: ${trigger.event} (reference ${trigger.reference}, ${trigger.receivedAt}). What it carries:\n${envelope(cut(body, budget))}`;
    }

    // ---- the steps

    private async loop(): Promise<WorkOutcome> {
      for (;;) {
        const started = Date.parse(this.run.sliceStartedAt!);
        if (now().getTime() >= started + RUN_SLICE_MS - SLICE_MARGIN_MS) {
          // The 15-minute slice (RN7): checkpointed, queued again, never ended.
          await this.save({ state: "queued", queuedAt: now().toISOString(), sliceStartedAt: null });
          return "queued";
        }
        const hold = await agentHold(await deps.agents.forTeam(this.teamId).findAgent(this.agent.id), deps.directory);
        if (hold === "removed") return this.end("cancelled", "agent-removed");
        if (hold) {
          await this.save({ state: "queued", queuedAt: now().toISOString(), sliceStartedAt: null });
          return "queued";
        }
        const { steps, inputTokens } = this.agent.limits;
        const over = steps !== null && this.run.steps >= steps ? "steps-limit" : inputTokens !== null && this.run.inputTokens >= inputTokens ? "tokens-limit" : undefined;
        if (over) return this.atLimit(over);
        if (this.run.steps > 0) {
          const fresh = await this.takeTriggers();
          if (fresh) this.appendUserText(`New since your last step:\n\n${fresh}`);
        }

        const turn = await this.step();
        if (typeof turn === "string") return turn;
        const calls = turn.parts.filter((part): part is ToolCallPart => part.type === "tool_call");
        if (calls.length === 0) return this.finish(turn);
        const waited = await this.answerCalls(calls, []);
        if (waited) return waited;
      }
    }

    /** One model call, stored before anything it asks for is done; the run's outcome when it cannot go on. */
    private async step(): Promise<ModelTurn | WorkOutcome> {
      let turn: ModelTurn;
      try {
        turn = await this.client.complete({ system: this.transcript.system, messages: this.visible(), tools: this.modelTools, maxOutputTokens });
      } catch (error) {
        if (error instanceof ModelHttpError && (error.status === 429 || error.status >= 500)) return this.later((error.retryAfterSeconds ?? 0) * 1000);
        return this.end("failed", error instanceof ModelHttpError ? `model-${error.status}` : "model-error");
      }
      this.transcript.messages.push({ role: "assistant", parts: turn.parts });
      await this.addStep("model", null, null, turn.usage.input, turn.usage.output);
      await this.runs.addUsage(dayOf(now()), this.agent.id, this.session.startedByUserId, { inputTokens: turn.usage.input, outputTokens: turn.usage.output });
      await this.save({
        steps: this.run.steps + 1,
        inputTokens: this.run.inputTokens + turn.usage.input,
        outputTokens: this.run.outputTokens + turn.usage.output,
        cacheUntil: new Date(now().getTime() + turn.cacheWindowSeconds * 1000).toISOString(),
      });
      return turn;
    }

    /** The tool calls of the last turn, in order; a call that waits stops there, the rest answered as not run. */
    private async answerCalls(calls: readonly ToolCallPart[], results: UserPart[], allowed?: string): Promise<WorkOutcome | undefined> {
      for (const [index, call] of calls.entries()) {
        const outcome = await this.answer(call, call.id === allowed);
        if ("wait" in outcome) {
          for (const rest of calls.slice(index + 1)) results.push({ type: "tool_result", callId: rest.id, content: "Not run: the run stopped at an earlier call. Call it again later if it is still needed.", isError: true });
          this.appendResults(results);
          return this.wait(outcome.wait);
        }
        results.push(outcome.result);
      }
      this.appendResults(results);
      await this.save({});
      return undefined;
    }

    private async answer(call: ToolCallPart, allowed: boolean): Promise<{ result: UserPart } | { wait: Waiting }> {
      const fail = (content: string) => ({ result: { type: "tool_result" as const, callId: call.id, content, isError: true } });
      if (call.malformed) return fail("Not run: the arguments were not a JSON object.");
      if (call.name === READ_PLAYBOOK) {
        const playbook = playbooks[this.transcript.language].find((p) => p.name === call.input["name"]);
        return playbook ? { result: { type: "tool_result", callId: call.id, content: `${playbook.title}\n${playbook.body}` } } : fail("No playbook of that name.");
      }
      const tool = call.name === ASK_PERSON && this.agent.askOwners ? ASK_PERSON : this.tools.tools.find((t) => t.name === call.name);
      if (!tool) return fail("Unknown tool: it is not in your tool list.");
      if (!allowed) {
        // Runner questions (RN13): a write after a suspected injection (asking counts as one), and the same call a third time.
        if ((tool === ASK_PERSON || !tool.readOnly) && this.run.injectionSuspected) return this.runnerQuestion("injection", call);
        if (this.priorCalls(call) >= 2) return this.runnerQuestion("repeated-call", call);
      }
      if (tool === ASK_PERSON) {
        const text = typeof call.input["question"] === "string" ? call.input["question"].trim() : "";
        if (text.length < 1 || text.length > 4000) return fail("Not asked: the question is 1 to 4,000 characters.");
        return { wait: { question: { kind: "agent", cause: null, text, callId: call.id } } };
      }
      const answered = await this.callTool(tool, call.input, call.id);
      if ("wait" in answered) return answered;
      return { result: { type: "tool_result", callId: call.id, content: cut(answered.result.text, budget), ...(answered.result.isError ? { isError: true } : {}) } };
    }

    /**
     * One call to a service, its step stored first (RN9). A call cut off is
     * looked up in the host's record by its step id: a read is made again,
     * a write without a recorded outcome is a runner question, never
     * repeated. A task waits; a refused credential waits for a person.
     */
    private async callTool(tool: RunTool, args: JsonObject, callId: string): Promise<{ result: ToolResult } | { wait: Waiting }> {
      for (let attempt = 0; ; attempt += 1) {
        const stepId = await this.addStep("tool", tool.name, callId);
        try {
          const outcome = await this.tools.call(tool, args, stepId);
          if (outcome.kind === "task") return { wait: { task: { tool, callId, task: outcome.task } } };
          return { result: await this.took(tool, callId, outcome.result) };
        } catch (error) {
          if (error instanceof CredentialNeededError) return { wait: { credential: { connection: error.connection, callId } } };
          if (error instanceof McpError) return { result: { text: `The service refused the call: ${error.message}`, isError: true } };
          if (error instanceof McpAuthError) return { result: { text: "The service refused the call (403): your grants there do not allow it.", isError: true } };
          if (!(error instanceof McpUnavailableError)) throw error;
          const recorded = await this.recorded(tool, stepId);
          if (recorded === "not-received" || tool.readOnly) {
            if (attempt === 0) continue;
            return { result: { text: "The service did not answer; try later.", isError: true } };
          }
          if (recorded === "no-outcome") return this.runnerQuestion("unknown-outcome", { id: callId });
          return { result: { text: `This call was cut off; the service recorded its answer's status ${recorded.status}. Do not repeat it: check its effect with a read.`, isError: recorded.status >= 400 } };
        }
      }
    }

    /** A result as it came: its injection mark kept, its version noted for a read. */
    private async took(tool: RunTool, callId: string, result: ToolResult): Promise<ToolResult> {
      if (result.structured !== undefined && marked(result.structured)) this.run.injectionSuspected = true;
      if (tool.readOnly && !result.isError) this.run.readVersions = [...this.run.readVersions.filter((r) => r.callId !== callId), { callId, tool: tool.name, version: versionOf(result) }];
      return result;
    }

    private recorded(tool: RunTool, stepId: string): Promise<RecordedOutcome> {
      if (tool.connection === null && deps.calls) return deps.calls.outcome(this.teamId, this.run.id, stepId);
      return Promise.resolve("no-outcome");
    }

    private runnerQuestion(cause: RunnerQuestionCause, call: Pick<ToolCallPart, "id"> & Partial<ToolCallPart>): { wait: Waiting } {
      const what = call.name ? `${call.name} ${cut(canonical(call.input ?? {}), 2000)}` : "a call";
      const text = {
        injection: `Something the agent read may carry instructions from outside. It now wants to make this call, which writes: ${what}. Continue lets this one call through; Stop ends the run.`,
        "repeated-call": `The agent is making the same call a third time: ${what}. Continue lets it through; Stop ends the run.`,
        "unknown-outcome": `A call was cut off and may or may not have been carried out: ${what}. Continue tells the agent the outcome is unknown and never repeats it; Stop ends the run.`,
        "runs-used": "This work has used the runs it may take. Continue allows another round of runs; Stop ends it.",
      }[cause];
      return { wait: { question: { kind: "runner", cause, text, callId: call.id } } };
    }

    private priorCalls(call: ToolCallPart): number {
      const key = `${call.name} ${canonical(call.input)}`;
      return this.transcript.messages
        .flatMap((message) => (message.role === "assistant" ? message.parts : []))
        .filter((part): part is ToolCallPart => part.type === "tool_call" && part.id !== call.id && `${part.name} ${canonical(part.input)}` === key).length;
    }

    // ---- waiting: a question, a service's task, a credential

    private async wait(waiting: Waiting): Promise<WorkOutcome> {
      if ("question" in waiting) {
        const { kind, cause, text, callId } = waiting.question;
        const question = await this.ask(kind, cause, text);
        await this.save({ state: "input_required", waitingOn: kind === "agent" ? { kind: "question", callId: callId!, questionId: question.id } : { kind: "runner-question", callId, questionId: question.id, cause: cause! }, sliceStartedAt: null }, () =>
          this.runs.updateQuestion(question.id, question.version, { state: "withdrawn" }),
        );
        notifier.notify({ type: "question.created", teamId: this.teamId, agentId: this.agent.id, sessionId: this.session.id, runId: this.run.id, questionId: question.id, kind, cause, ownerUserIds: this.session.ownerUserIds });
        this.notifyWaiting();
        return "waiting";
      }
      if ("credential" in waiting) {
        await this.save({ state: "auth_required", waitingOn: { kind: "credential", callId: waiting.credential.callId, connection: waiting.credential.connection }, sliceStartedAt: null });
        this.notifyWaiting();
        return "waiting";
      }
      const { tool, callId, task } = waiting.task;
      return this.waitOnTask({ kind: "task", callId, tool: tool.name, connection: tool.connection, taskId: task.taskId, status: task.status, floorMs: task.pollIntervalMs ?? 0, intervalMs: 0, nextPollAt: "" });
    }

    /** Waits for the task's next poll: `input_required` while a person decides at the service, else queued for the poll. */
    private async waitOnTask(on: Extract<WaitingOn, { kind: "task" }>): Promise<WorkOutcome> {
      const intervalMs = Math.max(on.floorMs, on.intervalMs === 0 ? POLL_FIRST_MS : Math.min(on.intervalMs * 2, POLL_MAX_MS));
      const nextPollAt = new Date(now().getTime() + intervalMs).toISOString();
      const waitingOn = { ...on, intervalMs, nextPollAt };
      if (on.status === "input_required") {
        const first = !(this.run.waitingOn?.kind === "task" && this.run.waitingOn.status === "input_required");
        await this.save({ state: "input_required", waitingOn, sliceStartedAt: null });
        if (first) this.notifyWaiting();
      } else await this.save({ state: "queued", queuedAt: nextPollAt, waitingOn, sliceStartedAt: null });
      return "waiting";
    }

    private async ask(kind: Question["kind"], cause: RunnerQuestionCause | null, text: string): Promise<Question> {
      const question: Question = {
        id: randomUUID(),
        teamId: this.teamId,
        sessionId: this.session.id,
        runId: this.run.id,
        kind,
        cause,
        body: await deps.sealer.seal(this.teamId, "question", text),
        state: "open",
        answer: null,
        answeredBy: null,
        createdAt: now().toISOString(),
        answeredAt: null,
        version: 1,
      };
      await this.runs.insertQuestion(question);
      return question;
    }

    private notifyWaiting() {
      if (this.run.state !== "input_required" && this.run.state !== "auth_required") return;
      notifier.notify({ type: "run.waiting", teamId: this.teamId, agentId: this.agent.id, sessionId: this.session.id, runId: this.run.id, state: this.run.state, waitingOn: this.run.waitingOn?.kind ?? "" });
    }

    // ---- resuming (RN8–RN12)

    /** A run claimed again: what it waited for answered, its cut-off calls looked up. A new wait answers its outcome. */
    private async resume(): Promise<WorkOutcome | undefined> {
      const pending = this.danglingCalls();
      const on = this.run.waitingOn;
      const results: UserPart[] = [];
      let allowed: string | undefined;
      if (on?.kind === "task") {
        const call = pending.find((c) => c.id === on.callId);
        if (call) {
          const done = await this.pollTask(on);
          if (typeof done === "string") return done;
          results.push({ type: "tool_result", callId: call.id, content: cut(done.text, budget), ...(done.isError ? { isError: true } : {}) });
        }
      } else if (on?.kind === "question" || on?.kind === "runner-question") {
        const question = await this.runs.findQuestion(on.questionId);
        const answer = question?.answer ? await deps.sealer.open(this.teamId, "answer", question.answer) : undefined;
        if (on.kind === "question") {
          results.push({ type: "tool_result", callId: on.callId, content: answer !== undefined ? `The answer from the session's owners:\n${answer}` : "The question was withdrawn without an answer." });
        } else if (on.callId !== null) {
          if (on.cause === "unknown-outcome")
            results.push({
              type: "tool_result",
              callId: on.callId,
              content: "This call's outcome is unknown: it may have been carried out. A person chose to continue. Do not repeat it; check its effect with a read first.",
              isError: true,
            });
          else allowed = on.callId;
        }
      }
      // Calls cut off when the runner stopped (RN9): looked up by their step id.
      const steps = await this.runs.listSteps(this.run.id);
      for (const call of pending) {
        if (call.id === on?.callId || results.some((r) => r.type === "tool_result" && r.callId === call.id)) continue;
        const tool = this.tools.tools.find((t) => t.name === call.name);
        const sent = steps.filter((step) => step.toolCallId === call.id).at(-1);
        if (!tool || tool.readOnly || !sent) continue;
        const recorded = await this.recorded(tool, sent.id);
        if (recorded === "not-received") continue;
        if (recorded === "no-outcome") {
          // Never repeated: a write that may have gone out is a runner question.
          for (const other of pending)
            if (other.id !== call.id && !results.some((r) => r.type === "tool_result" && r.callId === other.id))
              results.push({ type: "tool_result", callId: other.id, content: "Not run: the run stopped at an earlier call.", isError: true });
          this.appendResults(results);
          return this.wait(this.runnerQuestion("unknown-outcome", call).wait);
        }
        results.push({ type: "tool_result", callId: call.id, content: `This call was cut off; the service recorded its answer's status ${recorded.status}. Do not repeat it: check its effect with a read.`, ...(recorded.status >= 400 ? { isError: true } : {}) });
      }
      const notes = this.run.summary ? await this.checkVersions() : [];
      await this.save({ waitingOn: null });
      // The rest: a call a person let through, a call waiting for a credential, and cut-off calls never received or reads, made again.
      const rest = pending.filter((call) => !results.some((r) => r.type === "tool_result" && r.callId === call.id));
      const outcome = await this.answerCalls(rest, results, allowed);
      if (outcome) return outcome;
      const fresh = await this.takeTriggers();
      if (notes.length > 0 || fresh) this.appendUserText([...notes, ...(fresh ? [`New while you waited:\n\n${fresh}`] : [])].join("\n\n"));
      return undefined;
    }

    /** The task's state: its outcome once it ended, else the run waits again. */
    private async pollTask(on: Extract<WaitingOn, { kind: "task" }>): Promise<ToolResult | WorkOutcome> {
      const tool = this.tools.tools.find((t) => t.name === on.tool);
      let state;
      try {
        state = await this.tools.getTask(on.connection, on.taskId, await this.addStep("tool", "tasks/get", on.callId));
      } catch (error) {
        if (error instanceof CredentialNeededError) {
          await this.save({ state: "auth_required", waitingOn: { kind: "credential", callId: on.callId, connection: error.connection }, sliceStartedAt: null });
          return "waiting";
        }
        if (error instanceof McpError) return { text: `The service no longer knows this action's task: ${error.message}. Check its effect with a read.`, isError: true };
        if (error instanceof McpUnavailableError) return this.waitOnTask(on);
        throw error;
      }
      if (!TERMINAL_TASK_STATUSES.includes(state.task.status)) return this.waitOnTask({ ...on, status: state.task.status, floorMs: state.task.pollIntervalMs ?? on.floorMs });
      const message = state.task.statusMessage ? ` (${state.task.statusMessage})` : "";
      if (state.task.status === "completed" && state.result) return tool ? this.took(tool, on.callId, state.result) : state.result;
      if (state.task.status === "failed") return { text: `The action failed at the service: ${state.error ?? "no reason given"}${message}.`, isError: true };
      return { text: `The action was not carried out: the service cancelled it${message}, for example because a person declined it. Do not repeat it unless the reason is resolved.`, isError: true };
    }

    /** After a summary (RN11): every object read checked again; changed ones read again, gone ones named. */
    private async checkVersions(): Promise<string[]> {
      const notes: string[] = [];
      const calls = new Map(
        this.transcript.messages
          .flatMap((m) => (m.role === "assistant" ? m.parts : []))
          .filter((p): p is ToolCallPart => p.type === "tool_call")
          .map((p) => [p.id, p]),
      );
      const kept: ReadVersion[] = [];
      for (const read of this.run.readVersions) {
        const call = calls.get(read.callId);
        const tool = this.tools.tools.find((t) => t.name === read.tool);
        if (!call || !tool) {
          notes.push(`No longer granted since the summary: ${read.tool} ${canonical(call?.input ?? {})}.`);
          continue;
        }
        let again: ToolResult | undefined;
        try {
          const outcome = await this.tools.call(tool, call.input, await this.addStep("tool", tool.name, null));
          again = outcome.kind === "result" ? outcome.result : undefined;
        } catch (error) {
          if (!(error instanceof McpUnavailableError || error instanceof McpError || error instanceof McpAuthError || error instanceof CredentialNeededError)) throw error;
        }
        if (again?.structured !== undefined && marked(again.structured)) this.run.injectionSuspected = true;
        if (!again || again.isError) {
          notes.push(`Gone or no longer granted since the summary: ${read.tool} ${canonical(call.input)}${again ? ` (${again.text.split("\n")[0]})` : ""}.`);
          continue;
        }
        const version = versionOf(again);
        kept.push({ ...read, version });
        if (version !== read.version) notes.push(`Changed since the summary: ${read.tool} ${canonical(call.input)} now answers:\n${cut(again.text, budget)}`);
      }
      this.run.readVersions = kept;
      return notes;
    }

    /** The last assistant message's calls without a result after it. */
    private danglingCalls(): ToolCallPart[] {
      const messages = this.transcript.messages;
      const lastAssistant = messages.map((m) => m.role).lastIndexOf("assistant");
      if (lastAssistant < 0) return [];
      const answered = new Set(
        messages
          .slice(lastAssistant + 1)
          .flatMap((m) => (m.role === "user" ? m.content : []))
          .flatMap((p) => (p.type === "tool_result" ? [p.callId] : [])),
      );
      const assistant = messages[lastAssistant]!;
      return assistant.role === "assistant" ? assistant.parts.filter((p): p is ToolCallPart => p.type === "tool_call" && !answered.has(p.id)) : [];
    }

    /** The summary's view (RN10, RN12): the first message, a summary made while waiting in an envelope, then the messages since. */
    private visible(): Message[] {
      const { messages, summaryAt } = this.transcript;
      if (summaryAt === undefined || !this.summaryText) return messages;
      const first = messages[0] as Extract<Message, { role: "user" }>;
      return [{ role: "user", content: [...first.content, { type: "text", text: `A summary of this run so far (your own, written from what you read):\n${envelope(this.summaryText)}` }] }, ...messages.slice(summaryAt)];
    }

    // ---- the end: a result, a summary for the next run, and the next run where work is left

    private async finish(turn: ModelTurn): Promise<WorkOutcome> {
      const reason = turn.stop === "refusal" ? "refusal" : turn.stop === "cut_off" ? "cut-off" : "final";
      const result = await deps.sealer.seal(this.teamId, "result", textOf(turn.parts));
      await this.writeSummary();
      await this.end("completed", reason, { result });
      // Triggers that came while the run ended get a run of their own.
      if ((await this.runs.listTriggers(this.session.id, { undelivered: true })).length > 0) await this.queueNext("trigger");
      return "completed";
    }

    /** Out of steps or tokens (RN6): the run ends with a summary, and the work goes on in a new run until it used its runs. */
    private async atLimit(reason: "steps-limit" | "tokens-limit"): Promise<WorkOutcome> {
      await this.writeSummary();
      await this.end("completed", reason);
      await this.queueNext("continue");
      return "completed";
    }

    /** The next run of the session; the runs one piece of work may take used, it waits on a runner question instead. */
    private async queueNext(cause: "continue" | "trigger") {
      const runs = await this.runs.listRuns({ sessionId: this.session.id });
      if (runs.some((r) => OPEN_RUN_STATES.includes(r.state))) return;
      // The runs of this piece of work: the newest back to the one a trigger or an answer started.
      let chain = 0;
      for (const r of [...runs].reverse()) {
        chain += 1;
        if (r.cause !== "continue") break;
      }
      const limit = this.agent.limits.runsPerTrigger;
      const run = newRun({ id: randomUUID(), teamId: this.teamId, sessionId: this.session.id, agentId: this.agent.id, cause, queuedAt: now().toISOString(), priority: this.run.priority, dueOn: this.run.dueOn });
      if (cause === "continue" && limit !== null && chain >= limit) {
        const text = "This work has used the runs it may take. Continue allows another round of runs; Stop ends it.";
        const question: Question = {
          id: randomUUID(),
          teamId: this.teamId,
          sessionId: this.session.id,
          runId: run.id,
          kind: "runner",
          cause: "runs-used",
          body: await deps.sealer.seal(this.teamId, "question", text),
          state: "open",
          answer: null,
          answeredBy: null,
          createdAt: now().toISOString(),
          answeredAt: null,
          version: 1,
        };
        await this.runs.insertRun({ ...run, cause: "answer", state: "input_required", waitingOn: { kind: "runner-question", callId: null, questionId: question.id, cause: "runs-used" } });
        await this.runs.insertQuestion(question);
        notifier.notify({ type: "question.created", teamId: this.teamId, agentId: this.agent.id, sessionId: this.session.id, runId: run.id, questionId: question.id, kind: "runner", cause: "runs-used", ownerUserIds: this.session.ownerUserIds });
        return;
      }
      // ponytail: the run's end and the next run are two writes; a crash between leaves the session idle until its next trigger.
      await this.runs.insertRun(run).catch((error: unknown) => {
        if ((error as { code?: unknown }).code !== "23505") throw error;
      });
    }

    /** One call without tools (the tools still declared) at the cache price, sealed as the run's summary; none when the call fails. */
    private async writeSummary() {
      const messages = [...this.visible()];
      const last = messages.at(-1);
      const instruction: UserPart = { type: "text", text: SUMMARY_INSTRUCTION };
      if (last?.role === "user") messages[messages.length - 1] = { role: "user", content: [...last.content, instruction] };
      else messages.push({ role: "user", content: [instruction] });
      try {
        const turn = await this.client.complete({ system: this.transcript.system, messages, tools: this.modelTools, toolChoice: "none", maxOutputTokens });
        await this.addStep("summary", null, null, turn.usage.input, turn.usage.output);
        await this.runs.addUsage(dayOf(now()), this.agent.id, this.session.startedByUserId, { inputTokens: turn.usage.input, outputTokens: turn.usage.output });
        this.run.inputTokens += turn.usage.input;
        this.run.outputTokens += turn.usage.output;
        await this.save({ summary: await deps.sealer.seal(this.teamId, "summary", textOf(turn.parts)), inputTokens: this.run.inputTokens, outputTokens: this.run.outputTokens });
      } catch (error) {
        if (error instanceof RunStopped) throw error;
        // ponytail: no summary when the call fails; the next run starts from the last one there is.
      }
    }

    // ---- helpers

    private appendResults(results: UserPart[]) {
      if (results.length === 0) return;
      const last = this.transcript.messages.at(-1);
      if (last?.role === "user") this.transcript.messages[this.transcript.messages.length - 1] = { role: "user", content: [...last.content, ...results] };
      else this.transcript.messages.push({ role: "user", content: results });
    }

    private appendUserText(text: string) {
      this.appendResults([{ type: "text", text }]);
    }

    /** Stores a step before it is taken (RN9); its id is the host call's `Fairlead-Run-Step`. */
    private async addStep(kind: "model" | "tool" | "summary", tool: string | null, toolCallId: string | null, inputTokens = 0, outputTokens = 0): Promise<string> {
      this.n += 1;
      const id = randomUUID();
      await this.runs.insertStep({ id, runId: this.run.id, n: this.n, kind, at: now().toISOString(), tool, toolCallId, inputTokens, outputTokens });
      return id;
    }

    /** The run's changes with the sealed transcript, by compare-and-set: a run stopped or paused meanwhile ends the work. */
    private async save(changes: RunChanges, onStopped?: () => Promise<unknown>) {
      const transcript = this.transcript ? await deps.sealer.seal(this.teamId, "transcript", JSON.stringify(this.transcript)) : this.run.transcript;
      const next = await this.runs.updateRun(this.run.id, this.run.version, {
        injectionSuspected: this.run.injectionSuspected,
        readVersions: this.run.readVersions,
        ...changes,
        transcript,
      });
      if (!next) {
        await onStopped?.();
        throw new RunStopped();
      }
      this.run = next;
    }

    /** Back in the queue after `ms`, its slice given up (a provider's 429 or 5xx, a service that did not answer). */
    private async later(ms: number): Promise<WorkOutcome> {
      await this.save({ state: "queued", queuedAt: new Date(now().getTime() + ms).toISOString(), sliceStartedAt: null });
      return "queued";
    }

    private async end(state: "completed" | "failed" | "cancelled", reason: string, changes: RunChanges = {}): Promise<WorkOutcome> {
      await this.save({ ...changes, state, stopReason: reason, endedAt: now().toISOString(), sliceStartedAt: null, waitingOn: null });
      await this.runs.touchSession(this.session.id, now().toISOString());
      notifier.notify({ type: "run.ended", teamId: this.teamId, agentId: this.agent.id, sessionId: this.session.id, runId: this.run.id, state, stopReason: reason });
      return state;
    }
  }

  /**
   * The summary while waiting (RN10, RN12): a run waiting on a person whose
   * paid cache window closes within `SUMMARY_LEAD_MS` and whose last model
   * step read more than `SUMMARY_MIN_TOKENS`, one call without tools at
   * the cache price; sealed, the waiting call kept as it is, the run still
   * waiting, its injection mark kept. Any other run: false, no call.
   */
  async function summarize(teamId: string, runId: string): Promise<boolean> {
    const runs = deps.store.forTeam(teamId);
    const run = await runs.findRun(runId);
    if (!run || (run.state !== "input_required" && run.state !== "auth_required") || run.summary || !run.transcript || !run.waitingOn?.callId || run.cacheUntil === null) return false;
    const left = Date.parse(run.cacheUntil) - now().getTime();
    if (left <= 0 || left > SUMMARY_LEAD_MS) return false;
    const lastModel = (await runs.listSteps(run.id)).filter((step) => step.kind === "model").at(-1);
    if (!lastModel || lastModel.inputTokens <= SUMMARY_MIN_TOKENS) return false;
    const agent = await deps.agents.forTeam(teamId).findAgent(run.agentId);
    const choice = agent ? await modelOf(teamId, agent) : undefined;
    if (!choice) return false;
    const client = clientFor(choice, { teamId, identity: deps.identity, cacheKey: run.id, ...(choice.cacheTtl ? { cacheTtl: choice.cacheTtl } : {}) });
    if (run.model && (run.model.format !== client.format || run.model.model !== client.model)) return false;
    const transcript = JSON.parse(await deps.sealer.open(teamId, "transcript", run.transcript)) as Transcript;
    const tools = [...((await deps.tools.open(teamId, run.agentId, run.id, [ASK_PERSON, READ_PLAYBOOK]).catch(() => undefined))?.tools ?? []).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })), ...(agent!.askOwners ? [ASK_PERSON_TOOL] : []), READ_PLAYBOOK_TOOL];
    // The waiting call still waits: for this one request only, its result says so, so the conversation is well formed.
    const waiting: UserPart = { type: "tool_result", callId: run.waitingOn.callId, content: "Waiting for a person's decision." };
    const last = transcript.messages.at(-1);
    const instruction: UserPart = { type: "text", text: SUMMARY_INSTRUCTION };
    const messages: Message[] =
      last?.role === "user" ? [...transcript.messages.slice(0, -1), { role: "user", content: [...last.content, waiting, instruction] }] : [...transcript.messages, { role: "user", content: [waiting, instruction] }];
    const turn = await client.complete({ system: transcript.system, messages, tools, toolChoice: "none", maxOutputTokens });
    const steps = await runs.listSteps(run.id);
    await runs.insertStep({ id: randomUUID(), runId: run.id, n: steps.length + 1, kind: "summary", at: now().toISOString(), tool: null, toolCallId: null, inputTokens: turn.usage.input, outputTokens: turn.usage.output });
    transcript.summaryAt = transcript.messages.map((m) => m.role).lastIndexOf("assistant");
    const updated = await runs.updateRun(run.id, run.version, {
      summary: await deps.sealer.seal(teamId, "summary", textOf(turn.parts)),
      transcript: await deps.sealer.seal(teamId, "transcript", JSON.stringify(transcript)),
      inputTokens: run.inputTokens + turn.usage.input,
      outputTokens: run.outputTokens + turn.usage.output,
      cacheUntil: null,
    });
    return updated !== undefined;
  }

  return { work, summarize };
}

/** What a run stops to wait for. */
type Waiting =
  | { question: { kind: Question["kind"]; cause: RunnerQuestionCause | null; text: string; callId: string | null } }
  | { task: { tool: RunTool; callId: string; task: McpTask } }
  | { credential: { connection: string; callId: string } };

export type Runner = ReturnType<typeof createRunner>;
