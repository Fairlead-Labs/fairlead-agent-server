import { describe, expect, it } from "vitest";
import { signSigV4, wireCallId } from "../../src/index.js";

/**
 * RN14: Bedrock's SigV4, held to AWS's own test vectors (the fake Bedrock
 * server checks a signature with the same signer, so the vectors are what
 * keep it honest), and the call-id mapping's rules.
 */
const EXAMPLE = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
const AT = new Date("2015-08-30T12:36:00Z");

describe("signSigV4", () => {
  it("AWS's post-vanilla vector", () => {
    const signed = signSigV4({ method: "POST", url: new URL("https://example.amazonaws.com/"), headers: {}, body: "", region: "us-east-1", service: "service" }, EXAMPLE, AT);
    expect(signed).toEqual({
      "x-amz-date": "20150830T123600Z",
      authorization:
        "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b",
    });
  });

  it("AWS's IAM ListUsers example: a query and a signed content type", () => {
    const signed = signSigV4(
      {
        method: "GET",
        url: new URL("https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08"),
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
        body: "",
        region: "us-east-1",
        service: "iam",
      },
      EXAMPLE,
      AT,
    );
    expect(signed["authorization"]).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
    );
  });

  it("temporary credentials sign their session token; a model id's encoded path is encoded again", () => {
    const url = new URL(`https://bedrock-runtime.eu-central-1.amazonaws.com/model/${encodeURIComponent("arn:aws:bedrock:eu-central-1:1:inference-profile/eu.anthropic.x")}/invoke`);
    const signed = signSigV4({ method: "POST", url, headers: {}, body: "{}", region: "eu-central-1", service: "bedrock" }, { ...EXAMPLE, sessionToken: "token" }, AT);
    expect(signed["x-amz-security-token"]).toBe("token");
    expect(signed["authorization"]).toMatch(/SignedHeaders=host;x-amz-date;x-amz-security-token,/);
    const other = signSigV4({ method: "POST", url, headers: {}, body: "{}", region: "eu-central-1", service: "bedrock" }, { ...EXAMPLE, sessionToken: "other" }, AT);
    expect(other["authorization"]).not.toBe(signed["authorization"]);
  });
});

describe("wireCallId", () => {
  it("fits ^[a-zA-Z0-9_-]{1,64}$, keeps two ids apart, and hashes a long one", () => {
    const ids = ["run-1:step-2/call#3", "run-1_step-2/call#3", "run-1:step-2:call#3", "a".repeat(200), "b".repeat(200)];
    const mapped = ids.map((id) => wireCallId("ag_", id));
    for (const id of mapped) expect(id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(new Set(mapped).size).toBe(ids.length);
    expect(wireCallId("ag_", "0b1c2d3e-0000-4000-8000-000000000000")).toBe("ag_0b1c2d3e-0000-4000-8000-000000000000");
  });
});
