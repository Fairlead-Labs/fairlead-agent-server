import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { crc32c } from "../google.js";

/**
 * Test support: Cloud KMS's symmetric REST shape over
 * real HTTP on 127.0.0.1, `POST /v1/{cryptoKey}:encrypt` and `:decrypt`
 * behind a bearer token, plus the metadata server's access token (so
 * `GCE_METADATA_HOST` can point at it). Its ciphertext is the version and
 * AES-256-GCM under a key of its own with the request's AAD, so another
 * AAD fails as KMS's does (400 INVALID_ARGUMENT). It checks the request's
 * CRC32C fields. `answer` replaces every KMS answer with that status,
 * `disabled` holds versions that refuse (400 FAILED_PRECONDITION),
 * `primary` is the version `encrypt` uses, `delayMs` holds each answer,
 * `badChecksum` answers wrong CRC32C values; `requests` records each call's
 * method and AAD.
 */
export interface FakeSymmetricKms {
  url: string;
  /** `host:port` for `GCE_METADATA_HOST`. */
  metadataHost: string;
  cryptoKey: string;
  token: string;
  primary: number;
  disabled: Set<number>;
  answer: number | undefined;
  delayMs: number;
  badChecksum: boolean;
  readonly requests: { method: string; aad: string; checksums: boolean }[];
  close(): Promise<void>;
}

const STATUS: Record<number, string> = { 400: "INVALID_ARGUMENT", 401: "UNAUTHENTICATED", 403: "PERMISSION_DENIED", 404: "NOT_FOUND", 500: "INTERNAL", 503: "UNAVAILABLE" };

export async function startFakeSymmetricKms({
  cryptoKey = "projects/fake/locations/global/keyRings/test-keys/cryptoKeys/master",
  token = randomBytes(12).toString("hex"),
}: { cryptoKey?: string; token?: string } = {}): Promise<FakeSymmetricKms> {
  const secret = randomBytes(32);
  const json = (res: ServerResponse, status: number, body: unknown) => {
    if (!res.destroyed) res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  };
  const refuse = (res: ServerResponse, status: number, statusName = STATUS[status] ?? "UNKNOWN") => json(res, status, { error: { code: status, status: statusName } });
  const crc = (bytes: Buffer) => String(fake.badChecksum ? crc32c(bytes) ^ 1 : crc32c(bytes));

  const handle = (req: IncomingMessage, body: Buffer, res: ServerResponse) => {
    if (req.url === "/computeMetadata/v1/instance/service-accounts/default/token") {
      if (req.headers["metadata-flavor"] !== "Google") return refuse(res, 403);
      return json(res, 200, { access_token: fake.token, expires_in: 3600, token_type: "Bearer" });
    }
    const method = req.method === "POST" && req.url === `/v1/${cryptoKey}:encrypt` ? "encrypt" : req.method === "POST" && req.url === `/v1/${cryptoKey}:decrypt` ? "decrypt" : undefined;
    if (!method) return refuse(res, 404);
    if (req.headers.authorization !== `Bearer ${fake.token}`) return refuse(res, 401);
    let request: Record<string, unknown>;
    try {
      request = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
    } catch {
      return refuse(res, 400);
    }
    const bytes = (field: string) => Buffer.from(typeof request[field] === "string" ? request[field] : "", "base64");
    const aad = bytes("additionalAuthenticatedData");
    const checked = (field: string, value: Buffer) => request[field] === undefined || request[field] === String(crc32c(value));
    const data = bytes(method === "encrypt" ? "plaintext" : "ciphertext");
    fake.requests.push({ method, aad: aad.toString("utf8"), checksums: request["additionalAuthenticatedDataCrc32c"] !== undefined && request[`${method === "encrypt" ? "plaintext" : "ciphertext"}Crc32c`] !== undefined });
    setTimeout(() => {
      if (fake.answer !== undefined) return refuse(res, fake.answer);
      if (!checked("additionalAuthenticatedDataCrc32c", aad) || !checked(method === "encrypt" ? "plaintextCrc32c" : "ciphertextCrc32c", data)) return refuse(res, 400);
      if (method === "encrypt") {
        const version = Buffer.alloc(4);
        version.writeUInt32BE(fake.primary);
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", secret, iv).setAAD(Buffer.concat([version, aad]));
        const ct = Buffer.concat([cipher.update(data), cipher.final()]);
        const ciphertext = Buffer.concat([version, iv, cipher.getAuthTag(), ct]);
        return json(res, 200, {
          name: `${cryptoKey}/cryptoKeyVersions/${fake.primary}`,
          ciphertext: ciphertext.toString("base64"),
          ciphertextCrc32c: crc(ciphertext),
          verifiedPlaintextCrc32c: request["plaintextCrc32c"] !== undefined,
          verifiedAdditionalAuthenticatedDataCrc32c: request["additionalAuthenticatedDataCrc32c"] !== undefined,
          protectionLevel: "SOFTWARE",
        });
      }
      if (data.length < 33) return refuse(res, 400);
      const version = data.readUInt32BE(0);
      if (version < 1 || version > fake.primary) return refuse(res, 400);
      if (fake.disabled.has(version)) return refuse(res, 400, "FAILED_PRECONDITION");
      try {
        const decipher = createDecipheriv("aes-256-gcm", secret, data.subarray(4, 16)).setAAD(Buffer.concat([data.subarray(0, 4), aad]));
        decipher.setAuthTag(data.subarray(16, 32));
        const plaintext = Buffer.concat([decipher.update(data.subarray(32)), decipher.final()]);
        json(res, 200, { plaintext: plaintext.toString("base64"), plaintextCrc32c: crc(plaintext), usedPrimary: version === fake.primary, protectionLevel: "SOFTWARE" });
      } catch {
        refuse(res, 400);
      }
    }, fake.delayMs);
  };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => handle(req, Buffer.concat(chunks), res));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const fake: FakeSymmetricKms = {
    url: `http://127.0.0.1:${port}`,
    metadataHost: `127.0.0.1:${port}`,
    cryptoKey,
    token,
    primary: 1,
    disabled: new Set(),
    answer: undefined,
    delayMs: 0,
    badChecksum: false,
    requests: [],
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  return fake;
}
