import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { inTeam, type TransactionalSqlDatabase } from "./db/sql-database.js";
import { kmsDecrypt, kmsEncrypt, type CloudKmsKey } from "./google.js";

/**
 * The per-team key (requirement 0002, HK7–HK10; ADR 0001 §3): 32 random
 * bytes per team, wrapped by the installation's
 * `KeyWrapper` (a key service such as Cloud KMS, or a local key) and kept
 * in `team_keys`. It seals a team's transcripts, summaries, results, model
 * API keys, triggers, questions, answers and service credentials with AES-256-GCM bound to the team and the value's purpose, so a
 * sealed value opens only for its team and purpose.
 */

export interface TeamKeyRecord {
  teamId: string;
  keyId: string;
  /** The key as the wrapper wrapped it, base64. */
  wrapped: string;
  /** The wrapper's version that wrapped it (a KMS key version, or `local`). */
  kmsVersion: string;
  createdAt: string;
}

/** One key per team, created once and never changed (the runner's role may only insert and read). */
export interface TeamKeyStore {
  find(teamId: string): Promise<TeamKeyRecord | undefined>;
  /** `exists` when the team has one already (a concurrent first use): the caller reads that one. */
  insert(record: TeamKeyRecord): Promise<"inserted" | "exists">;
}

export class InMemoryTeamKeyStore implements TeamKeyStore {
  private readonly keys = new Map<string, TeamKeyRecord>();

  async find(teamId: string): Promise<TeamKeyRecord | undefined> {
    const record = this.keys.get(teamId);
    return record && { ...record };
  }

  async insert(record: TeamKeyRecord): Promise<"inserted" | "exists"> {
    if (this.keys.has(record.teamId)) return "exists";
    this.keys.set(record.teamId, { ...record });
    return "inserted";
  }
}

interface KeyRow {
  team_id: string;
  key_id: string;
  wrapped: string;
  kms_version: string;
  created_at: Date | string;
}

export class PostgresTeamKeyStore implements TeamKeyStore {
  constructor(private readonly db: TransactionalSqlDatabase) {}

  find(teamId: string): Promise<TeamKeyRecord | undefined> {
    return inTeam(this.db, teamId, async (tx) => {
      const { rows } = await tx.query<KeyRow>("SELECT team_id, key_id, wrapped, kms_version, created_at FROM team_keys WHERE team_id = $1", [teamId]);
      const row = rows[0];
      return row && { teamId: row.team_id, keyId: row.key_id, wrapped: row.wrapped, kmsVersion: row.kms_version, createdAt: new Date(row.created_at).toISOString() };
    });
  }

  insert(record: TeamKeyRecord): Promise<"inserted" | "exists"> {
    return inTeam(this.db, record.teamId, async (tx) => {
      const { rows } = await tx.query<{ team_id: string }>(
        `INSERT INTO team_keys (team_id, key_id, wrapped, kms_version, created_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (team_id) DO NOTHING RETURNING team_id`,
        [record.teamId, record.keyId, record.wrapped, record.kmsVersion, record.createdAt],
      );
      return rows.length === 1 ? "inserted" : "exists";
    });
  }
}

/** A sealed value as stored: the team key's id and nonce ‖ ciphertext ‖ tag, base64. */
export interface SealedValue {
  keyId: string;
  sealed: string;
}

/** What a value is for: its AAD's last part, so a transcript never opens as a model key. */
export type SealPurpose = "transcript" | "summary" | "result" | "model-key" | "trigger" | "question" | "answer" | "connection-credential";

/** A sealed value that does not open: another team's or purpose's, changed, or its key unavailable. Never says which. */
export class SealError extends Error {
  constructor() {
    super("Sealed value unavailable");
    this.name = "SealError";
  }
}

const NONCE = 12;
const TAG = 16;
const keyAad = (teamId: string, keyId: string) => Buffer.from(`fairlead.team-key.v1:${teamId}:${keyId}`, "utf8");
const valueAad = (teamId: string, purpose: SealPurpose) => Buffer.from(JSON.stringify(["fairlead.team-sealed.v1", teamId, purpose]), "utf8");

/**
 * What wraps the teams' keys (requirement 0002, HK8): a port, so no cloud
 * provider is required. `aad` binds a wrapped key to its team and key id.
 */
export interface KeyWrapper {
  wrap(key: Buffer, aad: Buffer): Promise<{ wrapped: Buffer; version: string }>;
  unwrap(wrapped: Buffer, aad: Buffer): Promise<Buffer>;
}

/** Google Cloud KMS as the wrapper: the key never leaves KMS, the process needs only encrypt and decrypt on it. */
export function cloudKmsKeyWrapper(kms: CloudKmsKey): KeyWrapper {
  return {
    wrap: async (key, aad) => {
      const { ciphertext, version } = await kmsEncrypt(kms, key, aad);
      return { wrapped: ciphertext, version };
    },
    unwrap: (wrapped, aad) => kmsDecrypt(kms, wrapped, aad),
  };
}

/**
 * A 32-byte key from the configuration as the wrapper (AES-256-GCM): for
 * self-hosting without a key service. Whoever reads the configuration reads
 * every team's values.
 */
// ponytail: one local key, no rotation; add a key id and previous keys when someone needs to rotate one.
export function localKeyWrapper(key: Buffer): KeyWrapper {
  if (key.length !== 32) throw new Error("A local wrapping key is 32 bytes");
  return {
    wrap: async (plain, aad) => {
      const nonce = randomBytes(NONCE);
      const gcm = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG });
      gcm.setAAD(aad);
      return { wrapped: Buffer.concat([nonce, gcm.update(plain), gcm.final(), gcm.getAuthTag()]), version: "local" };
    },
    unwrap: async (wrapped, aad) => {
      const gcm = createDecipheriv("aes-256-gcm", key, wrapped.subarray(0, NONCE), { authTagLength: TAG });
      gcm.setAAD(aad);
      gcm.setAuthTag(wrapped.subarray(wrapped.length - TAG));
      return Buffer.concat([gcm.update(wrapped.subarray(NONCE, wrapped.length - TAG)), gcm.final()]);
    },
  };
}

export interface TeamSealer {
  seal(teamId: string, purpose: SealPurpose, plaintext: string): Promise<SealedValue>;
  open(teamId: string, purpose: SealPurpose, value: SealedValue): Promise<string>;
}

/**
 * Seals and opens a team's values under its team key, made at the
 * team's first seal and unwrapped once per process.
 */
export function createTeamSealer({ store, wrapper, now = () => new Date() }: { store: TeamKeyStore; wrapper: KeyWrapper; now?: () => Date }): TeamSealer {
  // ponytail: unwrapped keys held for the process's life; evict when a team's key can be destroyed (the gone team's purge).
  const unwrapped = new Map<string, Promise<{ keyId: string; key: Buffer }>>();

  const unwrap = async (record: TeamKeyRecord) => ({ keyId: record.keyId, key: await wrapper.unwrap(Buffer.from(record.wrapped, "base64"), keyAad(record.teamId, record.keyId)) });

  const teamKey = (teamId: string, create: boolean) => {
    const cached = unwrapped.get(teamId);
    if (cached) return cached;
    const loading = (async () => {
      const existing = await store.find(teamId);
      if (existing) return unwrap(existing);
      if (!create) throw new SealError();
      const keyId = randomUUID();
      const key = randomBytes(32);
      const { wrapped, version } = await wrapper.wrap(key, keyAad(teamId, keyId));
      const record = { teamId, keyId, wrapped: wrapped.toString("base64"), kmsVersion: version, createdAt: now().toISOString() };
      if ((await store.insert(record)) === "inserted") return { keyId, key };
      const winner = await store.find(teamId);
      if (!winner) throw new SealError();
      return unwrap(winner);
    })();
    unwrapped.set(teamId, loading);
    loading.catch(() => unwrapped.delete(teamId));
    return loading;
  };

  return {
    async seal(teamId, purpose, plaintext) {
      const { keyId, key } = await teamKey(teamId, true);
      const nonce = randomBytes(NONCE);
      const gcm = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG });
      gcm.setAAD(valueAad(teamId, purpose));
      return { keyId, sealed: Buffer.concat([nonce, gcm.update(plaintext, "utf8"), gcm.final(), gcm.getAuthTag()]).toString("base64") };
    },
    async open(teamId, purpose, value) {
      try {
        const { keyId, key } = await teamKey(teamId, false);
        const frame = Buffer.from(value.sealed, "base64");
        if (keyId !== value.keyId || frame.length < NONCE + TAG) throw new SealError();
        const gcm = createDecipheriv("aes-256-gcm", key, frame.subarray(0, NONCE), { authTagLength: TAG });
        gcm.setAAD(valueAad(teamId, purpose));
        gcm.setAuthTag(frame.subarray(frame.length - TAG));
        return Buffer.concat([gcm.update(frame.subarray(NONCE, frame.length - TAG)), gcm.final()]).toString("utf8");
      } catch {
        throw new SealError();
      }
    },
  };
}
