import { createHash, createHmac } from "node:crypto";

export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Temporary credentials' token (an assumed role), signed as `x-amz-security-token`. */
  readonly sessionToken?: string;
}

const sha256 = (data: string) => createHash("sha256").update(data, "utf8").digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data, "utf8").digest();
/** RFC 3986's unreserved characters kept, everything else percent-encoded (SigV4's `UriEncode`). */
const uriEncode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

export interface SigV4Request {
  readonly method: string;
  /** The URL as sent: its path already encoded once. */
  readonly url: URL;
  /** Every header to sign (names in any case); `host` is added. */
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly region: string;
  readonly service: string;
}

/**
 * AWS Signature Version 4, written here over `node:crypto` (no AWS SDK):
 * the headers to add, `authorization`,
 * `x-amz-date` and, for temporary credentials, `x-amz-security-token`.
 * Every service but S3 encodes each path segment once more for the
 * canonical request.
 */
export function signSigV4(request: SigV4Request, credentials: AwsCredentials, at: Date): Record<string, string> {
  const amzDate = at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const added: Record<string, string> = { "x-amz-date": amzDate, ...(credentials.sessionToken ? { "x-amz-security-token": credentials.sessionToken } : {}) };
  const headers = new Map<string, string>();
  for (const [name, value] of Object.entries({ host: request.url.host, ...request.headers, ...added })) headers.set(name.toLowerCase(), value.trim().replace(/\s+/g, " "));
  const names = [...headers.keys()].sort();
  const path = request.url.pathname.split("/").map(uriEncode).join("/") || "/";
  const query = [...request.url.searchParams]
    .map(([key, value]) => [uriEncode(key), uriEncode(value)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const canonical = [request.method, path, query, ...names.map((name) => `${name}:${headers.get(name)}`), "", names.join(";"), sha256(request.body)].join("\n");
  const scope = `${day}/${request.region}/${request.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, day), request.region), request.service), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign, "utf8").digest("hex");
  return { ...added, authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
}
