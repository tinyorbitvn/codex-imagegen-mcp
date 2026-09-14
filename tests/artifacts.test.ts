// The /artifacts route: what makes an image URL work when there is no
// object storage. If this route is wrong, every URL create_image hands
// back in single-process mode is either dead or a way to read the
// filesystem.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { mountArtifacts } from "../src/artifacts.ts";

const PNG = Buffer.from("fake png bytes");

let root: string;
let server: Server;
let base: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "artifact-route-test-"));
  await mkdir(join(root, "projects/tinyorbit-cloud/hero/v1"), { recursive: true });
  await writeFile(join(root, "projects/tinyorbit-cloud/hero/v1/artifact.png"), PNG);
  await writeFile(
    join(root, "projects/tinyorbit-cloud/hero/v1/metadata.json"),
    JSON.stringify({ version: 1 }),
  );
  await writeFile(join(root, "projects/tinyorbit-cloud/hero/v1/notes.bin"), "opaque");
  // A file OUTSIDE the artifact directory, standing in for anything on the
  // filesystem a traversal could reach.
  await writeFile(join(root, "..", "artifact-route-secret.txt"), "top secret");

  const app = express();
  mountArtifacts(app, root);
  server = app.listen(0);
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await rm(root, { recursive: true, force: true });
  await rm(join(root, "..", "artifact-route-secret.txt"), { force: true });
});

describe("GET /artifacts", () => {
  test("serves a generated image with the right content type", async () => {
    const res = await fetch(`${base}/artifacts/projects/tinyorbit-cloud/hero/v1/artifact.png`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
  });

  test("serves metadata.json as JSON", async () => {
    const res = await fetch(`${base}/artifacts/projects/tinyorbit-cloud/hero/v1/metadata.json`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
  });

  test("an unknown extension is served as a download, never as something to run", async () => {
    const res = await fetch(`${base}/artifacts/projects/tinyorbit-cloud/hero/v1/notes.bin`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^application\/octet-stream/);
  });

  test("a missing artifact is a 404", async () => {
    const res = await fetch(`${base}/artifacts/projects/tinyorbit-cloud/hero/v9/artifact.png`);
    assert.equal(res.status, 404);
  });

  test("a traversal attempt gets a 404 and says nothing about the filesystem", async () => {
    // Percent-encoded so the client's URL parser cannot normalize the
    // "../" away before it is sent: this is the shape an attacker uses.
    for (const path of [
      "/artifacts/%2e%2e%2fartifact-route-secret.txt",
      "/artifacts/projects%2f%2e%2e%2f%2e%2e%2fartifact-route-secret.txt",
      "/artifacts/%2fetc%2fpasswd",
    ]) {
      const res = await fetch(`${base}${path}`);
      const body = await res.text();
      assert.equal(res.status, 404, `must refuse: ${path}`);
      assert.ok(!body.includes("secret"), "the reply must not leak what it looked at");
      assert.ok(!body.includes(root), "the reply must not leak the artifact directory");
    }
  });
});
