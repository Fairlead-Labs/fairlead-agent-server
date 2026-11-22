import { refuse, stable, startFakeHttp, type FakeHttp, type RecordedRequest, type Reply } from "./fake-http.js";

/**
 * Test support (requirement 0001, RN14–RN17): OpenAI Responses over real
 * HTTP on 127.0.0.1: OpenAI's `POST /v1/responses` with a bearer key, and
 * Azure OpenAI's `POST /openai/v1/responses` with `api-key` or an Entra
 * bearer `azureAdmits` accepts.
 *
 * It keeps nothing, as `store: false` promises, and so refuses what would
 * need stored state: `previous_response_id`, `conversation`, a request
 * without `store: false`, and a reasoning item that is not, field for
 * field (its encrypted content included), one this fake answered to that
 * same model. It also refuses a tool that is not a function tool, a forced
 * `tool_choice`, a `function_call` without its `function_call_output` or
 * an output for no call. Each refusal is a 400 and the request's
 * `problem`. Answers are scripted.
 */
export interface FakeOpenAI extends FakeHttp {
  readonly apiKey: string;
  readonly azureKey: string;
  /** Whether an Entra bearer may call the Azure resource (default: none). */
  azureAdmits: (token: string) => boolean;
}

export async function startFakeOpenAI({ apiKey = "sk-proj-fake-key", azureKey = "azure-fake-key" }: { apiKey?: string; azureKey?: string } = {}): Promise<FakeOpenAI> {
  const issued = new Map<string, Set<string>>();
  let fake: FakeOpenAI;

  const problemOf = (request: RecordedRequest): string | undefined => {
    const body = request.body;
    if (!body || typeof body !== "object" || typeof body.model !== "string") return "model required";
    if ("previous_response_id" in body) return "Previous response not found: nothing is stored.";
    if ("conversation" in body) return "Conversation not found: nothing is stored.";
    if (body.store !== false) return "store: false required";
    if ("background" in body) return "background needs storage";
    const allowed = new Set(["model", "instructions", "input", "tools", "tool_choice", "store", "include", "max_output_tokens", "reasoning", "prompt_cache_key"]);
    for (const key of Object.keys(body)) if (!allowed.has(key)) return `unexpected field ${key}`;
    if (body.tool_choice !== undefined && body.tool_choice !== "auto" && body.tool_choice !== "none") return "forced tool_choice";
    for (const tool of body.tools ?? []) {
      if (tool.type !== "function") return "only function tools";
      if (Object.keys(tool).sort().join(",") !== "description,name,parameters,strict,type") return "unexpected tool field";
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name)) return "invalid function name";
    }
    const input: any[] = body.input;
    if (!Array.isArray(input)) return "input must be a list";
    const calls = new Set<string>();
    const answered = new Set<string>();
    for (const item of input) {
      if (item.type === "reasoning") {
        if (typeof item.encrypted_content !== "string" || !issued.get(body.model)?.has(stable(item)))
          return "reasoning item not found: with store false it must come back unchanged, with its encrypted content, to its model";
      } else if (item.type === "function_call") {
        if (typeof item.call_id !== "string" || typeof item.arguments !== "string") return "function_call needs call_id and arguments";
        calls.add(item.call_id);
      } else if (item.type === "function_call_output") {
        if (!calls.has(item.call_id)) return `No tool call found for function call output with call_id ${item.call_id}.`;
        answered.add(item.call_id);
      }
    }
    for (const id of calls) if (!answered.has(id)) return `No tool output found for function call ${id}.`;
    return undefined;
  };

  const answer = (request: RecordedRequest, next: () => Reply): Reply => {
    const problem = problemOf(request);
    if (problem) return refuse(request, 400, "invalid_request_error", problem, "openai");
    const reply = next();
    const output = (reply.body as { output?: unknown } | undefined)?.output;
    if ((reply.status ?? 200) === 200 && Array.isArray(output)) {
      const model = request.body.model as string;
      if (!issued.has(model)) issued.set(model, new Set());
      for (const item of output) if (item?.type === "reasoning") issued.get(model)!.add(stable(item));
    }
    return reply;
  };

  const http = await startFakeHttp(
    (_method, url) => {
      const path = url.split("?")[0];
      return path === "/v1/responses" ? "openai" : path === "/openai/v1/responses" ? "azure" : "unknown";
    },
    (request, next) => {
      if (request.route === "openai") {
        if (request.headers["authorization"] !== `Bearer ${fake.apiKey}`) return refuse(request, 401, "invalid_api_key", "Incorrect API key provided.", "openai");
        return answer(request, next);
      }
      if (request.route === "azure") {
        const token = /^Bearer (.+)$/.exec(request.headers["authorization"] ?? "")?.[1];
        const keyed = request.headers["api-key"] === fake.azureKey;
        if (!keyed && !(token && fake.azureAdmits(token))) return refuse(request, 401, "PermissionDenied", "Access denied due to invalid subscription key or wrong API endpoint.", "openai");
        return answer(request, next);
      }
      return refuse(request, 404, "not_found", "no such route", "openai");
    },
  );
  fake = Object.assign(http, { apiKey, azureKey, azureAdmits: (_token: string) => false });
  return fake;
}
