import { createHmac, randomUUID } from "node:crypto";

/**
 * What the server announces (requirement 0004, *Work intake*; ADR 0006):
 * a new question for a session's owners, an answered one, a run that
 * waits, a run that ended. Ids and kinds only, never content: a question's
 * text and its answer are read through the API by the people who may. The
 * destination is a port; the host webhook is one adapter, a webhook per
 * team a later one. Announcing never holds up the work: a destination that
 * fails is tried a few times, then left.
 */

export type WorkEvent =
  | {
      type: "question.created";
      teamId: string;
      agentId: string;
      sessionId: string;
      runId: string;
      questionId: string;
      kind: "agent" | "runner";
      /** The runner's reason, for a runner question. */
      cause: string | null;
      /** Users; empty = the whole team. */
      ownerUserIds: string[];
    }
  | { type: "question.answered"; teamId: string; agentId: string; sessionId: string; runId: string; questionId: string; kind: "agent" | "runner" }
  | { type: "run.waiting"; teamId: string; agentId: string; sessionId: string; runId: string; state: "input_required" | "auth_required"; waitingOn: string }
  | { type: "run.ended"; teamId: string; agentId: string; sessionId: string; runId: string; state: "completed" | "cancelled" | "failed"; stopReason: string | null };

export interface Notifier {
  /** Never throws. */
  notify(event: WorkEvent): void;
}

export const noNotifier: Notifier = { notify: () => {} };

/** A Standard Webhooks secret: `whsec_` and at least 24 bytes in base64. */
export const WEBHOOK_SECRET = /^whsec_[A-Za-z0-9+/]{32,}={0,2}$/;

/**
 * The host webhook: each event POSTed as JSON, signed by Standard Webhooks
 * (`webhook-id`, `webhook-timestamp`, `webhook-signature`) or carrying an
 * identity token. Three attempts, a second and four seconds apart.
 */
export function createWebhookNotifier({
  url,
  secret,
  token,
  fetch: fetchImpl = fetch,
  now = () => new Date(),
  delays = [1_000, 4_000],
}: {
  url: string;
  secret?: string;
  token?: () => Promise<string>;
  fetch?: typeof fetch;
  now?: () => Date;
  delays?: number[];
}): Notifier {
  const key = secret ? Buffer.from(secret.slice("whsec_".length), "base64") : undefined;
  // ponytail: in-process retries, no outbox; an event is lost when the process stops meanwhile or the host stays down.
  async function deliver(event: WorkEvent) {
    const id = `msg_${randomUUID()}`;
    const body = JSON.stringify({ ...event, at: now().toISOString() });
    for (let attempt = 0; ; attempt += 1) {
      try {
        const timestamp = Math.floor(now().getTime() / 1000).toString();
        const headers: Record<string, string> = { "Content-Type": "application/json", "webhook-id": id, "webhook-timestamp": timestamp };
        if (key) headers["webhook-signature"] = `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
        if (token) headers["Authorization"] = `Bearer ${await token()}`;
        const response = await fetchImpl(url, { method: "POST", redirect: "error", headers, body });
        await response.body?.cancel();
        if (response.ok) return;
      } catch {
        // tried again below
      }
      const delay = delays[attempt];
      if (delay === undefined) {
        console.error(`fairlead-agent-server: the webhook did not take a ${event.type} event`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  return { notify: (event) => void deliver(event) };
}
