// The on-disk artifact store: the one that makes a deployment with no
// object storage possible.
//
// The traversal cases are the reason this file exists. Keys are built from
// job data, and this store is the last thing between a key and the
// filesystem: a key that escapes ARTIFACT_DIR means reading or writing
// arbitrary files as the service user.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ImagegenError } from "../../src/contracts/index.ts";
import { LocalArtifactStore } from "../../src/storage/local.ts";

let root: string;
let store: LocalArtifactStore;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "artifact-store-test-"));
  store = new LocalArtifactStore({ dir: root, publicBaseUrl: "http://localhost:8080" });
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

const KEY = "projects/tinyorbit-cloud/hero/v1/artifact.png";

describe("LocalArtifactStore", () => {
  test("uploads a file and reads the same bytes back", async () => {
    const src = join(root, "source.png");
    const body = Buffer.from("not really a png, but the bytes must survive");
    await writeFile(src, body);

    const result = await store.uploadArtifact(src, KEY, "image/png");
    assert.equal(result.key, KEY);
    assert.equal(result.bytes, body.byteLength);
    assert.ok(result.durationMs >= 0);

    // On disk under the artifact directory, at the key's own path.
    assert.deepEqual(await readFile(join(root, KEY)), body);
    // And back out through the interface, which is what edit_image uses.
    assert.deepEqual(await store.download(KEY), body);
  });

  test("writes metadata as pretty-printed JSON", async () => {
    const key = "projects/tinyorbit-cloud/hero/v1/metadata.json";
    await store.uploadMetadata(key, { version: 1, generator: "codex-chatgpt-image" });
    const text = await readFile(join(root, key), "utf8");
    assert.deepEqual(JSON.parse(text), { version: 1, generator: "codex-chatgpt-image" });
    assert.ok(text.includes("\n  "), "metadata.json is read by humans, keep it indented");
  });

  test("publicUrl points at the route this process serves", () => {
    assert.equal(store.publicUrl(KEY), `http://localhost:8080/artifacts/${KEY}`);
  });

  test("signedUrl is the plain URL, because a directory has nothing to sign against", async () => {
    assert.equal(await store.signedUrl(KEY), store.publicUrl(KEY));
  });

  test("a missing artifact fails with JOB_NOT_FOUND, exactly like the S3 store", async () => {
    await assert.rejects(
      () => store.download("projects/p/a/v9/nothing.png"),
      (e: unknown) => e instanceof ImagegenError && e.code === "JOB_NOT_FOUND",
    );
  });

  test("rejects a key containing a .. segment", async () => {
    const src = join(root, "source.png");
    for (const key of [
      "../escaped.png",
      "projects/../../escaped.png",
      "projects/p/../../../escaped.png",
      "projects\\..\\escaped.png",
    ]) {
      await assert.rejects(
        () => store.uploadArtifact(src, key, "image/png"),
        (e: unknown) => e instanceof ImagegenError && e.code === "STORAGE_UPLOAD_FAILED",
        `must reject: ${key}`,
      );
      await assert.rejects(
        () => store.download(key),
        (e: unknown) => e instanceof ImagegenError && e.code === "STORAGE_UPLOAD_FAILED",
        `must reject: ${key}`,
      );
    }
  });

  test("rejects a key that is an absolute path", async () => {
    const src = join(root, "source.png");
    for (const key of ["/etc/cron.d/backdoor", "/tmp/escaped.png"]) {
      await assert.rejects(
        () => store.uploadArtifact(src, key, "image/png"),
        (e: unknown) => e instanceof ImagegenError && e.code === "STORAGE_UPLOAD_FAILED",
        `must reject: ${key}`,
      );
      await assert.rejects(
        () => store.uploadMetadata(key, {}),
        (e: unknown) => e instanceof ImagegenError && e.code === "STORAGE_UPLOAD_FAILED",
        `must reject: ${key}`,
      );
    }
  });

  test("reports IMAGE_GENERATION_FAILED when Codex left no file to upload", async () => {
    await assert.rejects(
      () => store.uploadArtifact(join(root, "never-written.png"), KEY, "image/png"),
      (e: unknown) => e instanceof ImagegenError && e.code === "IMAGE_GENERATION_FAILED",
    );
  });

  test("isReachable creates the directory on a fresh volume", async () => {
    const fresh = join(root, "does-not-exist-yet");
    const s = new LocalArtifactStore({ dir: fresh, publicBaseUrl: "http://localhost:8080" });
    assert.equal(await s.isReachable(), true);
  });
});
