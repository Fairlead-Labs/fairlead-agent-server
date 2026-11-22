import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeSymmetricKms, type FakeSymmetricKms } from "../src/testing/index.js";
import { randomBytes } from "node:crypto";
import { cloudKmsKeyWrapper, createTeamSealer, localKeyWrapper, type KeyWrapper, SealError, InMemoryTeamKeyStore } from "../src/index.js";

/**
 * Requirement 0002, HK7 (ADR 0001 §3): one key per team, wrapped
 * by the server's own Cloud KMS key (the fake's REST shape over real HTTP),
 * sealing a team's transcripts, summaries and model API keys. A sealed
 * value opens only for its team and purpose.
 */

const WRAPPING_KEY = "projects/fake/locations/global/keyRings/test-keys/cryptoKeys/teams";

let fake: FakeSymmetricKms;
let wrapper: KeyWrapper;

beforeAll(async () => {
  fake = await startFakeSymmetricKms({ cryptoKey: WRAPPING_KEY });
  wrapper = cloudKmsKeyWrapper({ cryptoKey: fake.cryptoKey, accessToken: async () => fake.token, baseUrl: fake.url });
});
afterAll(async () => {
  await fake.close();
});

describe("the team keys (HK7)", () => {
  it("a team's first seal makes its key, wrapped by the server's KMS key under an AAD naming team and key; later seals reuse it", async () => {
    const store = new InMemoryTeamKeyStore();
    const sealer = createTeamSealer({ store, wrapper, now: () => new Date("2026-11-02T12:00:00.000Z") });
    const before = fake.requests.length;
    const first = await sealer.seal("team-a", "transcript", "the run's transcript");
    const record = (await store.find("team-a"))!;
    expect(record).toMatchObject({ teamId: "team-a", keyId: first.keyId, kmsVersion: String(fake.primary), createdAt: "2026-11-02T12:00:00.000Z" });
    expect(Buffer.from(record.wrapped, "base64")).toHaveLength(4 + 12 + 32 + 16);
    expect(fake.requests.slice(before)).toEqual([{ method: "encrypt", aad: `fairlead.team-key.v1:team-a:${first.keyId}`, checksums: true }]);
    const second = await sealer.seal("team-a", "summary", "a summary");
    expect(second.keyId).toBe(first.keyId);
    expect(fake.requests).toHaveLength(before + 1);
    expect(await sealer.open("team-a", "transcript", first)).toBe("the run's transcript");
    expect(await sealer.open("team-a", "summary", second)).toBe("a summary");
    // Each seal its own nonce.
    expect((await sealer.seal("team-a", "transcript", "the run's transcript")).sealed).not.toBe(first.sealed);
  });

  it("another process opens what one sealed: the stored key unwrapped once by KMS", async () => {
    const store = new InMemoryTeamKeyStore();
    const sealed = await createTeamSealer({ store, wrapper }).seal("team-a", "model-key", "sk-test-not-a-secret");
    const other = createTeamSealer({ store, wrapper });
    const before = fake.requests.length;
    expect(await other.open("team-a", "model-key", sealed)).toBe("sk-test-not-a-secret");
    expect(await other.open("team-a", "model-key", sealed)).toBe("sk-test-not-a-secret");
    expect(fake.requests.slice(before).map((request) => request.method)).toEqual(["decrypt"]);
  });

  it("negative: a value opens only for its team and purpose, untouched, under its key", async () => {
    const store = new InMemoryTeamKeyStore();
    const sealer = createTeamSealer({ store, wrapper });
    const sealed = await sealer.seal("team-a", "transcript", "team A's transcript");
    await sealer.seal("team-b", "transcript", "team B's");
    await expect(sealer.open("team-b", "transcript", sealed)).rejects.toBeInstanceOf(SealError);
    await expect(sealer.open("team-a", "summary", sealed)).rejects.toBeInstanceOf(SealError);
    await expect(sealer.open("team-a", "model-key", sealed)).rejects.toBeInstanceOf(SealError);
    const bytes = Buffer.from(sealed.sealed, "base64");
    bytes[bytes.length - 1]! ^= 1;
    await expect(sealer.open("team-a", "transcript", { ...sealed, sealed: bytes.toString("base64") })).rejects.toBeInstanceOf(SealError);
    await expect(sealer.open("team-a", "transcript", { ...sealed, keyId: "another" })).rejects.toBeInstanceOf(SealError);
    await expect(sealer.open("team-a", "transcript", { ...sealed, sealed: "" })).rejects.toBeInstanceOf(SealError);
    // A team without a key opens nothing, and opening makes none.
    await expect(sealer.open("team-c", "transcript", sealed)).rejects.toBeInstanceOf(SealError);
    expect(await store.find("team-c")).toBeUndefined();
  });

  it("negative: a team's wrapped key moved to another team's row does not unwrap (the AAD names the team)", async () => {
    const store = new InMemoryTeamKeyStore();
    const sealed = await createTeamSealer({ store, wrapper }).seal("team-a", "transcript", "x");
    const moved = new InMemoryTeamKeyStore();
    await moved.insert({ ...(await store.find("team-a"))!, teamId: "team-b" });
    await expect(createTeamSealer({ store: moved, wrapper }).open("team-b", "transcript", sealed)).rejects.toBeInstanceOf(SealError);
  });

  it("negative: KMS refusing leaves no key stored and nothing sealed; the next seal tries again", async () => {
    const store = new InMemoryTeamKeyStore();
    const sealer = createTeamSealer({ store, wrapper });
    fake.answer = 403;
    try {
      await expect(sealer.seal("team-a", "transcript", "x")).rejects.toThrow(/403 PERMISSION_DENIED/);
    } finally {
      fake.answer = undefined;
    }
    expect(await store.find("team-a")).toBeUndefined();
    expect(await sealer.open("team-a", "transcript", await sealer.seal("team-a", "transcript", "x"))).toBe("x");
  });

  it("two first seals at once: one key stored, both seal under it", async () => {
    const store = new InMemoryTeamKeyStore();
    const [one, two] = await Promise.all([createTeamSealer({ store, wrapper }).seal("team-a", "transcript", "1"), createTeamSealer({ store, wrapper }).seal("team-a", "transcript", "2")]);
    expect(one.keyId).toBe(two.keyId);
    const reader = createTeamSealer({ store, wrapper });
    expect([await reader.open("team-a", "transcript", one), await reader.open("team-a", "transcript", two)]).toEqual(["1", "2"]);
  });
});

/** Requirement 0002, HK8–HK10: the key that wraps the teams' keys is a port; a local key needs no cloud. */
describe("a local wrapping key (requirement 0002, HK9)", () => {
  it("wraps a team's key without any service: another process with the same key opens what one sealed", async () => {
    const key = randomBytes(32);
    const store = new InMemoryTeamKeyStore();
    const before = fake.requests.length;
    const sealed = await createTeamSealer({ store, wrapper: localKeyWrapper(key) }).seal("team-a", "model-key", "sk-test-not-a-secret");
    expect((await store.find("team-a"))!.kmsVersion).toBe("local");
    expect(await createTeamSealer({ store, wrapper: localKeyWrapper(key) }).open("team-a", "model-key", sealed)).toBe("sk-test-not-a-secret");
    expect(fake.requests).toHaveLength(before);
  });

  it("negative: another local key, or the wrapped key moved to another team's row, opens nothing", async () => {
    const key = randomBytes(32);
    const store = new InMemoryTeamKeyStore();
    const sealed = await createTeamSealer({ store, wrapper: localKeyWrapper(key) }).seal("team-a", "transcript", "x");
    await expect(createTeamSealer({ store, wrapper: localKeyWrapper(randomBytes(32)) }).open("team-a", "transcript", sealed)).rejects.toBeInstanceOf(SealError);
    const moved = new InMemoryTeamKeyStore();
    await moved.insert({ ...(await store.find("team-a"))!, teamId: "team-b" });
    await expect(createTeamSealer({ store: moved, wrapper: localKeyWrapper(key) }).open("team-b", "transcript", sealed)).rejects.toBeInstanceOf(SealError);
  });

  it("negative: a key that is not 32 bytes is refused", () => {
    expect(() => localKeyWrapper(randomBytes(16))).toThrow("32 bytes");
  });
});
