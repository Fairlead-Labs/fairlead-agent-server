import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

/** One request a fake provider received, as it came. */
export interface RecordedRequest {
  /** Which way in: `claude-api`, `vertex`, `bedrock`, `openai`, `azure`, or `metadata`. */
  readonly route: string;
  readonly method: string;
  /** The path and query as sent (still encoded). */
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly raw: string;
  /** The JSON body (undefined when none). */
  readonly body: any;
  /** Why the fake refused it (a wire rule the request broke), else undefined. */
  problem?: string;
}

/** An answer: a status with headers and a body. */
export type Reply = { readonly status?: number; readonly headers?: Record<string, string>; readonly body: unknown };
/** A scripted answer: a `Reply` (a numeric `status` and a `body`), any other object a 200's body, or a function of the request. */
export type Script = object | ((request: RecordedRequest) => Reply);

const asReply = (script: object): Reply =>
  "body" in script && typeof (script as { status?: unknown }).status === "number" ? (script as Reply) : { body: script };

export interface FakeHttp {
  /** `http://127.0.0.1:<port>`. */
  readonly url: string;
  readonly requests: RecordedRequest[];
  /** Queue the next answers, in order; a request with none queued is a 500. */
  script(...replies: Script[]): void;
  /** Drop the answers still queued (one test's leftovers are not the next one's). */
  reset(): void;
  close(): Promise<void>;
}

export type Handler = (request: RecordedRequest, next: () => Reply) => Reply;

const read = (request: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });

/** A loopback HTTP server: `route` names a request, `handle` checks it and answers (calling `next` for the scripted answer). */
export async function startFakeHttp(route: (method: string, url: string) => string, handle: Handler): Promise<FakeHttp> {
  const requests: RecordedRequest[] = [];
  const queue: Script[] = [];
  const server = createServer((incoming, outgoing) => {
    void read(incoming).then((raw) => {
      let body: unknown;
      try {
        body = raw === "" ? undefined : JSON.parse(raw);
      } catch {
        body = undefined;
      }
      const headers = Object.fromEntries(Object.entries(incoming.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(", ") : (value ?? "")]));
      const recorded: RecordedRequest = { route: route(incoming.method ?? "", incoming.url ?? ""), method: incoming.method ?? "", url: incoming.url ?? "", headers, raw, body };
      requests.push(recorded);
      const next = (): Reply => {
        const script = queue.shift();
        if (!script) return { status: 500, body: { error: { type: "api_error", message: "nothing scripted" } } };
        return typeof script === "function" ? (script as (request: RecordedRequest) => Reply)(recorded) : asReply(script);
      };
      let reply: Reply;
      try {
        reply = handle(recorded, next);
      } catch (error) {
        recorded.problem ??= String(error);
        reply = { status: 500, body: { error: { type: "api_error", message: "the fake failed" } } };
      }
      outgoing.writeHead(reply.status ?? 200, { "content-type": "application/json", ...reply.headers });
      outgoing.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    script: (...replies) => void queue.push(...replies),
    reset: () => void queue.splice(0),
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

/** A refusal in the provider's error shape, the problem recorded on the request. */
export function refuse(request: RecordedRequest, status: number, type: string, message: string, shape: "anthropic" | "openai"): Reply {
  request.problem ??= message;
  return { status, body: shape === "anthropic" ? { type: "error", error: { type, message } } : { error: { type, code: type, message } } };
}

export const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === "object" && !Array.isArray(inner) ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : 1))) : inner,
  );
