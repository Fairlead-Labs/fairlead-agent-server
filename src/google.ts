/**
 * Google Cloud over `fetch`, with no Google SDK: Cloud KMS's REST
 * `encrypt` / `decrypt` (each call bound by its AAD and checked by CRC32C
 * both ways; errors name KMS's status, never a key's bytes or a
 * ciphertext) and the metadata server's tokens.
 */

export const CLOUD_KMS_URL = "https://cloudkms.googleapis.com";
/** A Cloud KMS crypto key's resource name (`KMS_KEY`). */
export const KMS_CRYPTO_KEY_PATTERN = /^projects\/[^/:]+\/locations\/[^/:]+\/keyRings\/[^/:]+\/cryptoKeys\/[^/:]+$/;
const DEADLINE_MS = 10_000;

const CRC32C_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1;
  return c >>> 0;
});

/** CRC32C (Castagnoli), as Cloud KMS checks its requests and answers. */
export function crc32c(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32C_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A Cloud KMS call that failed: its status (`403 PERMISSION_DENIED`), a failed check or no answer in time. Never a value. */
export class KmsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KmsError";
  }
}

export interface CloudKmsKey {
  /** The crypto key's resource name, `projects/…/locations/…/keyRings/…/cryptoKeys/…` (`KMS_KEY`). */
  cryptoKey: string;
  /** An OAuth access token: the metadata server's on Cloud Run, the operator's ADC in a CLI, a fake's in tests. */
  accessToken: () => Promise<string>;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const sameCrc = (value: unknown, bytes: Uint8Array) => (typeof value === "string" || typeof value === "number") && String(value) === String(crc32c(bytes));

async function call(kms: CloudKmsKey, method: "encrypt" | "decrypt", body: Record<string, string>): Promise<Record<string, unknown>> {
  const timeoutMs = kms.timeoutMs ?? DEADLINE_MS;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new KmsError(`Cloud KMS gave no answer within ${timeoutMs / 1000} s`)), timeoutMs);
  });
  const work = (async () => {
    const token = await kms.accessToken().catch(() => {
      throw new KmsError("no access token for Cloud KMS");
    });
    let response: Response;
    try {
      response = await (kms.fetch ?? fetch)(`${kms.baseUrl ?? CLOUD_KMS_URL}/v1/${kms.cryptoKey}:${method}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new KmsError("Cloud KMS could not be reached");
    }
    const answer = (await response.json().catch(() => ({}))) as Record<string, unknown> & { error?: { status?: unknown } };
    if (!response.ok) {
      const status = typeof answer.error?.status === "string" && /^[A-Z_]{1,40}$/.test(answer.error.status) ? ` ${answer.error.status}` : "";
      throw new KmsError(`Cloud KMS answered ${response.status}${status}`);
    }
    return answer;
  })();
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Cloud KMS's `encrypt` under the crypto key's primary version, bound to
 * `aad`, CRC32C checked both ways: the ciphertext and the key version that
 * made it. The team keys' wrap (requirement 0002) uses it.
 */
export async function kmsEncrypt(kms: CloudKmsKey, plaintext: Uint8Array, aad: Uint8Array): Promise<{ ciphertext: Buffer; version: string }> {
  const answer = await call(kms, "encrypt", {
    plaintext: Buffer.from(plaintext).toString("base64"),
    plaintextCrc32c: String(crc32c(plaintext)),
    additionalAuthenticatedData: Buffer.from(aad).toString("base64"),
    additionalAuthenticatedDataCrc32c: String(crc32c(aad)),
  });
  const ciphertext = typeof answer["ciphertext"] === "string" ? Buffer.from(answer["ciphertext"], "base64") : undefined;
  const version = typeof answer["name"] === "string" && answer["name"].startsWith(`${kms.cryptoKey}/cryptoKeyVersions/`) ? /\/(\d+)$/.exec(answer["name"])?.[1] : undefined;
  if (answer["verifiedPlaintextCrc32c"] !== true || answer["verifiedAdditionalAuthenticatedDataCrc32c"] !== true || !ciphertext || !sameCrc(answer["ciphertextCrc32c"], ciphertext)) {
    throw new KmsError("Cloud KMS's answer failed its CRC32C check");
  }
  if (!version) throw new KmsError("Cloud KMS answered no key version of the crypto key");
  return { ciphertext, version };
}

/** Cloud KMS's `decrypt` of what `kmsEncrypt` made under the same `aad`; KMS reads the version from the ciphertext. */
export async function kmsDecrypt(kms: CloudKmsKey, ciphertext: Uint8Array, aad: Uint8Array): Promise<Buffer> {
  const answer = await call(kms, "decrypt", {
    ciphertext: Buffer.from(ciphertext).toString("base64"),
    ciphertextCrc32c: String(crc32c(ciphertext)),
    additionalAuthenticatedData: Buffer.from(aad).toString("base64"),
    additionalAuthenticatedDataCrc32c: String(crc32c(aad)),
  });
  const plaintext = typeof answer["plaintext"] === "string" ? Buffer.from(answer["plaintext"], "base64") : undefined;
  if (!plaintext || !sameCrc(answer["plaintextCrc32c"], plaintext)) throw new KmsError("Cloud KMS's answer failed its CRC32C check");
  return plaintext;
}


/**
 * The service account's access token from the metadata server (Cloud Run),
 * kept until a minute before it expires; one read at a time.
 */
export function metadataAccessToken({
  baseUrl = "http://metadata.google.internal",
  fetch: fetchImpl = fetch,
  now = Date.now,
}: { baseUrl?: string; fetch?: typeof fetch; now?: () => number } = {}): () => Promise<string> {
  let cached: { token: string; until: number } | undefined;
  let pending: Promise<string> | undefined;
  const read = async () => {
    const response = await fetchImpl(`${baseUrl}/computeMetadata/v1/instance/service-accounts/default/token`, { headers: { "metadata-flavor": "Google" } });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`The metadata server answered ${response.status}`);
    }
    const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string" || typeof body.expires_in !== "number") throw new Error("The metadata server answered no token");
    cached = { token: body.access_token, until: now() + (body.expires_in - 60) * 1000 };
    return body.access_token;
  };
  return async () => {
    if (cached && now() < cached.until) return cached.token;
    pending ??= read().finally(() => (pending = undefined));
    return pending;
  };
}

/**
 * An identity token for `audience` from the metadata server (Cloud Run's
 * service account), which a private Cloud Run service's IAM checks; kept
 * until five minutes before it expires, one request in flight.
 */
export function metadataIdentityToken(
  audience: string,
  { baseUrl = "http://metadata.google.internal", fetch: fetchImpl = fetch, now = Date.now }: { baseUrl?: string; fetch?: typeof fetch; now?: () => number } = {},
): () => Promise<string> {
  let cached: { token: string; until: number } | undefined;
  let pending: Promise<string> | undefined;
  const read = async () => {
    const query = new URLSearchParams({ audience, format: "full" });
    const response = await fetchImpl(`${baseUrl}/computeMetadata/v1/instance/service-accounts/default/identity?${query}`, { headers: { "metadata-flavor": "Google" } });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`The metadata server answered ${response.status}`);
    }
    const token = (await response.text()).trim();
    const payload = token.split(".")[1];
    const { exp, iat } = (payload === undefined ? {} : JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))) as { exp?: unknown; iat?: unknown };
    if (typeof exp !== "number" || typeof iat !== "number") throw new Error("The metadata server answered no token");
    // Its lifetime from our clock (the token's own clock may differ).
    cached = { token, until: now() + (exp - iat) * 1000 - 300_000 };
    return token;
  };
  return async () => {
    if (cached && now() < cached.until) return cached.token;
    pending ??= read().finally(() => (pending = undefined));
    return pending;
  };
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** An https URL, or http on loopback. */
export function isSecureUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  } catch {
    return false;
  }
}
