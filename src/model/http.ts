import { isJsonObject, ModelHttpError, ModelProtocolError, type JsonObject } from "./types.js";

/** `Retry-After` in seconds: a number of seconds or an HTTP date. */
export function retryAfterSeconds(value: string | null, now: number = Date.now()): number | undefined {
  if (value === null) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim());
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - now) / 1000));
}

/**
 * One POST of a JSON body; a 2xx answers its JSON object. Anything else is a
 * `ModelHttpError` with the provider's error type (Anthropic's
 * `error.type`, OpenAI's `error.code` / `error.type`). No retry here: a 429
 * is surfaced with its `Retry-After`, and the runner decides.
 */
export async function postJson(url: string, headers: Record<string, string>, body: string, signal: AbortSignal | undefined): Promise<JsonObject> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body, ...(signal ? { signal } : {}) });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!response.ok) {
    const error = isJsonObject(parsed) && isJsonObject(parsed["error"]) ? parsed["error"] : undefined;
    const type = error ? [error["type"], error["code"]].find((value): value is string => typeof value === "string") : undefined;
    const detail = error && typeof error["message"] === "string" ? error["message"] : undefined;
    throw new ModelHttpError(response.status, type, retryAfterSeconds(response.headers.get("retry-after")), detail);
  }
  if (!isJsonObject(parsed)) throw new ModelProtocolError("The model provider answered no JSON object");
  return parsed;
}

export const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);
