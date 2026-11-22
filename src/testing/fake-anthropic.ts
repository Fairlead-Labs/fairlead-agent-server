import { signSigV4 } from "../model/sigv4.js";
import { refuse, stable, startFakeHttp, type FakeHttp, type RecordedRequest, type Reply } from "./fake-http.js";

/**
 * Test support (requirement 0001, RN14–RN17): Anthropic Messages over real
 * HTTP on 127.0.0.1, by its three ways in:
 *
 * - the Claude API, `POST /v1/messages` with `x-api-key` and
 *   `anthropic-version`, the model in the body;
 * - Vertex AI, `POST /v1/projects/{p}/locations/{r}/publishers/anthropic/models/{m}:rawPredict`
 *   with a bearer `vertexAdmits` accepts for that project, `anthropic_version`
 *   `vertex-2023-10-16` and no model; plus the metadata server's token;
 * - Bedrock, `POST /model/{id}/invoke` signed with SigV4 (service
 *   `bedrock`) by a key in `awsSecrets` that `bedrockAdmits` accepts for
 *   the model, `anthropic_version` `bedrock-2023-05-31`.
 *
 * It enforces what the real API refuses and what the adapter promises: a
 * forced `tool_choice` (Opus 5.5 and Sonnet 5.5 refuse it), a tool that is
 * not a plain function tool, a `tool_use` id outside `^[a-zA-Z0-9_-]+$`,
 * a `tool_use` without its `tool_result` first in the next message (or a
 * result for no call), tool blocks without tools, more than four cache
 * breakpoints, and an assistant message holding thinking that is not,
 * block for block, one this fake answered to that same model. Each
 * refusal is a 400 and the request's `problem`. Answers are scripted.
 */
export interface FakeAnthropic extends FakeHttp {
  readonly apiKey: string;
  /** The metadata server's access token. */
  readonly metadataToken: string;
  /** Whether a bearer may call Vertex AI in a project (default: the metadata token, any project). */
  vertexAdmits: (project: string, token: string) => boolean;
  /** Bedrock's keys: access key id → secret. */
  readonly awsSecrets: Map<string, string>;
  /** Whether a key may invoke a model (default: any known key). */
  bedrockAdmits: (accessKeyId: string, modelId: string) => boolean;
}

const VERTEX = /^\/v1\/projects\/([^/]+)\/locations\/([^/]+)\/publishers\/anthropic\/models\/([^/:]+):rawPredict$/;
const BEDROCK = /^\/model\/([^/]+)\/invoke$/;
const METADATA = "/computeMetadata/v1/instance/service-accounts/default/token";

function routeOf(_method: string, url: string): string {
  const path = url.split("?")[0]!;
  if (path === "/v1/messages") return "claude-api";
  if (VERTEX.test(path)) return "vertex";
  if (BEDROCK.test(path)) return "bedrock";
  if (path === METADATA) return "metadata";
  return "unknown";
}

export async function startFakeAnthropic({ apiKey = "sk-ant-fake-key", metadataToken = "ya29.fake-metadata" }: { apiKey?: string; metadataToken?: string } = {}): Promise<FakeAnthropic> {
  /** Every assistant content array answered that holds thinking, by model. */
  const issued = new Map<string, Set<string>>();
  let fake: FakeAnthropic;

  const problemOf = (request: RecordedRequest, model: string): string | undefined => {
    const body = request.body;
    if (!body || typeof body !== "object") return "no JSON body";
    if (typeof body.max_tokens !== "number") return "max_tokens required";
    const choice = body.tool_choice;
    if (choice !== undefined && choice.type !== "auto" && choice.type !== "none") return "tool_choice: type \"tool\" and \"any\" are not supported for this model.";
    const allowed = new Set(["model", "anthropic_version", "max_tokens", "system", "messages", "tools", "tool_choice", "output_config"]);
    for (const key of Object.keys(body)) if (!allowed.has(key)) return `unexpected field ${key}`;
    const tools: any[] = body.tools ?? [];
    for (const tool of tools) {
      const keys = Object.keys(tool).sort().join(",");
      if (keys !== "description,input_schema,name" && keys !== "cache_control,description,input_schema,name") return "only plain function tools";
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name)) return "invalid tool name";
    }
    let breakpoints = 0;
    const countBreakpoints = (blocks: unknown) => {
      if (Array.isArray(blocks)) for (const block of blocks) if (block && typeof block === "object" && "cache_control" in block) breakpoints += 1;
    };
    countBreakpoints(body.system);
    countBreakpoints(tools);
    const messages: any[] = body.messages;
    if (!Array.isArray(messages) || messages.length === 0 || messages[0].role !== "user") return "messages must start with a user message";
    const used = new Set<string>();
    for (const [index, message] of messages.entries()) {
      const content: any[] = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
      countBreakpoints(content);
      if (message.role === "assistant") {
        if (content.some((block) => block.type === "thinking" || block.type === "redacted_thinking") && !issued.get(model)?.has(stable(content)))
          return "thinking blocks must be passed back unchanged, in order, to the model that wrote them";
        const ids = content.filter((block) => block.type === "tool_use").map((block) => block.id as string);
        for (const id of ids) if (typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id)) return "tool_use id does not match ^[a-zA-Z0-9_-]+$";
        if (ids.length > 0) {
          const next: any[] = messages[index + 1]?.role === "user" ? messages[index + 1].content : [];
          const results = Array.isArray(next) ? next.filter((block) => block.type === "tool_result").map((block) => block.tool_use_id) : [];
          if (!Array.isArray(next) || next.slice(0, ids.length).some((block) => block.type !== "tool_result")) return "tool_result blocks must come first";
          if (stable([...results].sort()) !== stable([...ids].sort())) return "each tool_use needs exactly its tool_result in the next message";
          ids.forEach((id) => used.add(id));
        }
      } else if (Array.isArray(content)) {
        for (const block of content) if (block.type === "tool_result" && !used.has(block.tool_use_id)) return "tool_result for no tool_use";
      }
    }
    if (used.size > 0 && tools.length === 0) return "Requests which include tool_use or tool_result blocks must define tools.";
    if (breakpoints > 4) return "A maximum of 4 blocks with cache_control may be provided.";
    return undefined;
  };

  const answer = (request: RecordedRequest, model: string, next: () => Reply): Reply => {
    const problem = problemOf(request, model);
    if (problem) return refuse(request, 400, "invalid_request_error", problem, "anthropic");
    const reply = next();
    const content = (reply.body as { content?: unknown } | undefined)?.content;
    if ((reply.status ?? 200) === 200 && Array.isArray(content) && content.some((block) => block?.type === "thinking" || block?.type === "redacted_thinking")) {
      if (!issued.has(model)) issued.set(model, new Set());
      issued.get(model)!.add(stable(content));
    }
    return reply;
  };

  const http = await startFakeHttp(routeOf, (request, next) => {
    const path = request.url.split("?")[0]!;
    const body = request.body ?? {};
    switch (request.route) {
      case "metadata":
        return request.headers["metadata-flavor"] === "Google" ? { body: { access_token: fake.metadataToken, expires_in: 3599, token_type: "Bearer" } } : { status: 403, body: {} };
      case "claude-api":
        if (request.headers["x-api-key"] !== fake.apiKey) return refuse(request, 401, "authentication_error", "invalid x-api-key", "anthropic");
        if (request.headers["anthropic-version"] !== "2023-06-01") return refuse(request, 400, "invalid_request_error", "anthropic-version required", "anthropic");
        if (typeof body.model !== "string" || body.anthropic_version !== undefined) return refuse(request, 400, "invalid_request_error", "model required", "anthropic");
        return answer(request, body.model, next);
      case "vertex": {
        const [, project, , model] = VERTEX.exec(path)!;
        const token = /^Bearer (.+)$/.exec(request.headers["authorization"] ?? "")?.[1];
        if (!token || !fake.vertexAdmits(decodeURIComponent(project!), token)) return refuse(request, 403, "PERMISSION_DENIED", "permission denied on the project", "openai");
        if (body.anthropic_version !== "vertex-2023-10-16" || body.model !== undefined) return refuse(request, 400, "invalid_request_error", "vertex body", "anthropic");
        return answer(request, decodeURIComponent(model!), next);
      }
      case "bedrock": {
        const modelId = decodeURIComponent(BEDROCK.exec(path)![1]!);
        const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/bedrock\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(request.headers["authorization"] ?? "");
        const secret = match ? fake.awsSecrets.get(match[1]!) : undefined;
        const amzDate = request.headers["x-amz-date"] ?? "";
        if (!match || !secret || !/^\d{8}T\d{6}Z$/.test(amzDate)) return refuse(request, 403, "UnrecognizedClientException", "The security token included in the request is invalid.", "anthropic");
        const signed = Object.fromEntries(match[4]!.split(";").filter((name) => name !== "host" && name !== "x-amz-date" && name !== "x-amz-security-token").map((name) => [name, request.headers[name] ?? ""]));
        const at = new Date(`${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`);
        const token = request.headers["x-amz-security-token"];
        const expected = signSigV4(
          { method: request.method, url: new URL(`http://${request.headers["host"]}${request.url}`), headers: signed, body: request.raw, region: match[3]!, service: "bedrock" },
          { accessKeyId: match[1]!, secretAccessKey: secret, ...(token ? { sessionToken: token } : {}) },
          at,
        );
        if (expected["authorization"] !== request.headers["authorization"]) return refuse(request, 403, "InvalidSignatureException", "The request signature we calculated does not match.", "anthropic");
        if (!fake.bedrockAdmits(match[1]!, modelId)) return refuse(request, 403, "AccessDeniedException", "not authorized to invoke the model", "anthropic");
        if (body.anthropic_version !== "bedrock-2023-05-31" || body.model !== undefined) return refuse(request, 400, "ValidationException", "bedrock body", "anthropic");
        return answer(request, modelId, next);
      }
      default:
        return refuse(request, 404, "not_found_error", "no such route", "anthropic");
    }
  });
  fake = Object.assign(http, {
    apiKey,
    metadataToken,
    vertexAdmits: (_project: string, token: string) => token === fake.metadataToken,
    awsSecrets: new Map<string, string>(),
    bedrockAdmits: (accessKeyId: string) => fake.awsSecrets.has(accessKeyId),
  });
  return fake;
}
