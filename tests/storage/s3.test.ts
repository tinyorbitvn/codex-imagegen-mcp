// The presigned POST policy, checked offline: signing needs no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";

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
  // An object belongs to whoever wrote it: without this ACL the bucket owner (the worker) gets 403.
  assert.ok(has(["eq", "$acl", "bucket-owner-full-control"]), "acl");
  assert.equal(p.fields.acl, "bucket-owner-full-control");
  const ttl = Date.parse(policy.expiration) - Date.now();
  assert.ok(ttl > 890_000 && ttl <= 900_000, `expires in ${ttl} ms`);
});

test("a bucket that refuses CORS still gets the rule that expires uploads", async () => {
  // MinIO, for one, has no per-bucket CORS: that must not keep uploads forever.
  const seen: string[] = [];
  const stub = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      seen.push(`${req.method} ${req.url}`);
      if (req.url?.includes("cors")) {
        res.writeHead(403, { "content-type": "application/xml" });
        res.end("<Error><Code>AccessDenied</Code><Message>no</Message></Error>");
      } else {
        res.writeHead(200);
        res.end();
      }
    });
  });
  stub.listen(0);
  await once(stub, "listening");
  try {
    const s = new ArtifactStorage({
      endpoint: `http://127.0.0.1:${(stub.address() as AddressInfo).port}`,
      bucket: "mcp-artifacts",
      region: "us-east-1",
      forcePathStyle: true,
      publicBaseUrl: "https://s3.example/mcp-artifacts",
      signedUrlTtlSeconds: 60,
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "not-a-real-secret",
    });
    await assert.rejects(s.configureUploads({ corsOrigins: ["*"], retentionDays: 1 }), /CORS/);
    assert.ok(seen.some((r) => r.startsWith("PUT") && r.includes("lifecycle")), seen.join(", "));
  } finally {
    stub.close();
  }
});

test("CORS and lifecycle are set one after the other, never at once", async () => {
  // RGW refused one of two concurrent bucket-config PUTs with ConcurrentModification (0.8.0, 2026-10-29).
  let inFlight = 0;
  let most = 0;
  const stub = createServer((req, res) => {
    inFlight++;
    most = Math.max(most, inFlight);
    req.resume();
    req.on("end", () =>
      setTimeout(() => {
        inFlight--;
        res.writeHead(200);
        res.end();
      }, 50),
    );
  });
  stub.listen(0);
  await once(stub, "listening");
  try {
    const s = new ArtifactStorage({
      endpoint: `http://127.0.0.1:${(stub.address() as AddressInfo).port}`,
      bucket: "mcp-artifacts",
      region: "us-east-1",
      forcePathStyle: true,
      publicBaseUrl: "https://s3.example/mcp-artifacts",
      signedUrlTtlSeconds: 60,
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "not-a-real-secret",
    });
    await s.configureUploads({ corsOrigins: ["*"], retentionDays: 1 });
    assert.equal(most, 1);
  } finally {
    stub.close();
  }
});

test("an inline upload is written readable by the bucket owner", async () => {
  const acl: Array<string | undefined> = [];
  const stub = createServer((req, res) => {
    acl.push(req.headers["x-amz-acl"] as string | undefined);
    req.resume();
    req.on("end", () => {
      res.writeHead(200);
      res.end();
    });
  });
  stub.listen(0);
  await once(stub, "listening");
  try {
    const s = new ArtifactStorage({
      endpoint: `http://127.0.0.1:${(stub.address() as AddressInfo).port}`,
      bucket: "mcp-artifacts",
      region: "us-east-1",
      forcePathStyle: true,
      publicBaseUrl: "https://s3.example/mcp-artifacts",
      signedUrlTtlSeconds: 60,
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "not-a-real-secret",
    });
    await s.putObject(KEY, Buffer.from("png"), "image/png");
    assert.deepEqual(acl, ["bucket-owner-full-control"]);
  } finally {
    stub.close();
  }
});
