// The presigned POST policy, checked offline: signing needs no network.

import { test } from "node:test";
import assert from "node:assert/strict";

import { ArtifactStorage } from "../../src/storage/s3.ts";

const KEY = "uploads/tinyorbit-cloud/upl_" + "d".repeat(32);

function storage() {
  return new ArtifactStorage({
    endpoint: "http://rgw.invalid",
    bucket: "mcp-artifacts",
    region: "us-east-1",
    forcePathStyle: true,
    publicBaseUrl: "https://s3.example/mcp-artifacts",
    signedUrlTtlSeconds: 60,
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "not-a-real-secret",
  });
}

test("the POST goes to the public bucket URL, not the in-cluster endpoint", async () => {
  const p = await storage().presignUpload(KEY, "image/png", 1000, 900);
  assert.equal(p.url, "https://s3.example/mcp-artifacts");
  assert.equal(p.fields.key, KEY);
  assert.equal(p.fields["Content-Type"], "image/png");
});

test("the signed policy caps the size, pins key and type, and expires on time", async () => {
  const p = await storage().presignUpload(KEY, "image/webp", 1000, 900);
  const policy = JSON.parse(Buffer.from(p.fields.Policy!, "base64").toString("utf8")) as {
    expiration: string;
    conditions: unknown[];
  };
  const has = (c: unknown) => policy.conditions.some((x) => JSON.stringify(x) === JSON.stringify(c));
  assert.ok(has(["content-length-range", 1, 1000]), "size cap");
  assert.ok(has({ bucket: "mcp-artifacts" }), "bucket");
  assert.ok(has({ key: KEY }), "key");
  assert.ok(has(["eq", "$Content-Type", "image/webp"]), "content type");
  const ttl = Date.parse(policy.expiration) - Date.now();
  assert.ok(ttl > 890_000 && ttl <= 900_000, `expires in ${ttl} ms`);
});
