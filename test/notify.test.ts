import { createHmac, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWebhookNotifier, type WorkEvent } from "../src/index.js";
import { startFakeHttp, type FakeHttp } from "../src/testing/index.js";

/** Requirement 0004, AS12: the host webhook, over a real loopback receiver. */

let receiver: FakeHttp;
beforeAll(async () => {
  receiver = await startFakeHttp(
    () => "webhook",
    (_request, next) => next(),
  );
});
afterAll(() => receiver.close());

const event: WorkEvent = { type: "run.ended", teamId: "t1", agentId: "a1", sessionId: "s1", runId: "r1", state: "completed", stopReason: "final" };
const settled = async (count: number) => {
  for (let i = 0; i < 200 && receiver.requests.length < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  await new Promise((resolve) => setTimeout(resolve, 20));
};

describe("the host webhook (requirement 0004)", () => {
  it("AS12: each event is POSTed signed by Standard Webhooks; a failed delivery is tried again, three times in all", async () => {
    receiver.requests.splice(0);
    const secret = `whsec_${randomBytes(32).toString("base64")}`;
    const notifier = createWebhookNotifier({ url: `${receiver.url}/hooks`, secret, delays: [0, 0] });
    receiver.script({ status: 500, body: {} }, { status: 200, body: {} });
    notifier.notify(event);
    await settled(2);
    expect(receiver.requests).toHaveLength(2);
    const [first, second] = receiver.requests;
    expect(second!.headers["webhook-id"]).toBe(first!.headers["webhook-id"]);
    const { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": signature } = second!.headers;
    const expected = createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${id}.${timestamp}.${second!.raw}`).digest("base64");
    expect(signature).toBe(`v1,${expected}`);
    expect(second!.body).toMatchObject({ ...event, at: expect.any(String) });

    receiver.requests.splice(0);
    receiver.script({ status: 500, body: {} }, { status: 503, body: {} }, { status: 502, body: {} }, { status: 200, body: {} });
    notifier.notify(event);
    await settled(3);
    expect(receiver.requests, "three attempts, then left").toHaveLength(3);
    receiver.reset();
  });

  it("AS12: with an identity, each delivery carries a fresh token instead of a signature", async () => {
    receiver.requests.splice(0);
    const notifier = createWebhookNotifier({ url: `${receiver.url}/hooks`, token: async () => "id-token", delays: [] });
    receiver.script({ status: 200, body: {} });
    notifier.notify(event);
    await settled(1);
    expect(receiver.requests[0]!.headers).toMatchObject({ authorization: "Bearer id-token" });
    expect(receiver.requests[0]!.headers["webhook-signature"]).toBeUndefined();
  });
});
