// Integration test for the consumer: a FAKE Codex + fake object storage.
//
// The fake Codex writes out exactly the file the instructions ask for, so
// the test exercises the real path (dedicated job directory, upload,
// metadata, cleanup) without needing a ChatGPT account and without
// spending any quota.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readdir, readFile, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { join } from "node:path";

import type { ImageSpec, JobPayload, JobRecord } from "../../src/contracts/index.ts";
import { InMemoryJobQueue, InMemoryJobStore } from "../../src/queue/index.ts";
import type { ArtifactStore } from "../../src/storage/index.ts";

import { Consumer, pruneGeneratedImages } from "../../src/worker/consumer.ts";
import type { CodexRunner } from "../../src/worker/consumer.ts";

let workRoot: string;
before(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "codex-worker-test-"));
});
after(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

function spec(over: Partial<ImageSpec> = {}): ImageSpec {
  return {
    projectId: "tinyorbit-cloud",
    assetId: "homepage-hero-vps",
    description: "VPS server",
    stylePrompt: "claymorphism",
    styleReference: "tinyorbit-cloud-v1",
    aspectRatio: "1:1",
    width: 1536,
    height: 1536,
    transparentBackground: true,
    outputFormat: "png",
    isolatedObject: true,
    safePaddingPercent: 12,
    filename: "artifact.png",
    ...over,
  };
}

function record(jobId: string, s: ImageSpec, version = 1): JobRecord {
  return {
    jobId, status: "queued", projectId: s.projectId, assetId: s.assetId,
    version, parentVersion: null, principal: "claude-design",
    createdAt: new Date().toISOString(), startedAt: null, completedAt: null,
    artifact: null, errorCode: null, errorMessage: null, traceId: null,
  };
}

class FakeStorage {
  objects = new Map<string, Buffer>();
  metadata = new Map<string, unknown>();
  failUploads = false;

  async uploadArtifact(localPath: string, key: string, _mime: string) {
    if (this.failUploads) {
      const { ImagegenError } = await import("../../src/contracts/index.ts");
      throw new ImagegenError("STORAGE_UPLOAD_FAILED", "Failed to upload artifact");
    }
    let body: Buffer;
    try {
      body = await readFile(localPath);
    } catch {
      const { ImagegenError } = await import("../../src/contracts/index.ts");
      throw new ImagegenError(
        "IMAGE_GENERATION_FAILED",
        "Codex finished but produced no image file",
      );
    }
    this.objects.set(key, body);
    return { key, url: `https://s3.example/${key}`, bytes: body.byteLength, durationMs: 1 };
  }
  async uploadMetadata(key: string, meta: unknown) {
    this.metadata.set(key, meta);
  }
  async download(key: string) {
    const b = this.objects.get(key);
    if (!b) throw new Error("not found");
    return b;
  }
  async isReachable() {
    return true;
  }
  publicUrl(key: string) {
    return `https://s3.example/${key}`;
  }
  async signedUrl(key: string) {
    return this.publicUrl(key);
  }
}

/** Fake Codex that succeeds: writes out exactly the file the instructions ask for. */
const codexOk: CodexRunner = async (opts) => {
  const m = /Save the (?:final generated asset|edited artifact) to exactly this path: (.+)$/m.exec(
    opts.prompt,
  );
  assert.ok(m, "the instructions must state the output path");
  await writeFile(m![1]!.trim(), Buffer.from("PNGFAKE"));
  return { exitCode: 0, durationMs: 5, stderrTail: "" };
};

function codexFailing(stderr: string): CodexRunner {
  return async () => ({ exitCode: 1, durationMs: 5, stderrTail: stderr });
}

function build(runner: CodexRunner, storage = new FakeStorage()) {
  const store = new InMemoryJobStore();
  const queue = new InMemoryJobQueue();
  const consumer = new Consumer({
    store,
    queue,
    storage: storage as unknown as ArtifactStore,
    config: {
      workDir: join(workRoot, "jobs"),
      codexHome: join(workRoot, "codex"),
      codexBinary: "codex",
      jobTimeoutSeconds: 30,
      concurrency: 1,
    },
    runner,
  });
  return { consumer, store, queue, storage };
}

/** Runs the consumer long enough to process one job, then stops it. */
async function runOnce(c: Consumer, store: InMemoryJobStore, jobId: string): Promise<string> {
  void c.run();
  const deadline = Date.now() + 5000;
  for (;;) {
    const s = (await store.get(jobId))?.status;
    if (s && s !== "queued" && s !== "running") {
      c.stop();
      await new Promise((r) => setTimeout(r, 60));
      return s;
    }
    if (Date.now() > deadline) {
      c.stop();
      throw new Error(`job never finished, still ${s}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

function payload(jobId: string, s: ImageSpec): JobPayload {
  return { jobId, kind: "create", spec: s, version: 1, parentVersion: null, sourceKey: null, instructions: null };
}

describe("consumer — happy path", () => {
  test("artifact lands at the correct S3 key layout", async () => {
    const { consumer, store, queue, storage } = build(codexOk);
    const s = spec();
    await store.create(record("img_1", s));
    await queue.enqueue(payload("img_1", s));

    assert.equal(await runOnce(consumer, store, "img_1"), "completed");
    assert.ok(
      storage.objects.has("projects/tinyorbit-cloud/homepage-hero-vps/v1/artifact.png"),
    );
    assert.ok(
      storage.metadata.has("projects/tinyorbit-cloud/homepage-hero-vps/v1/metadata.json"),
    );

    const job = await store.get("img_1");
    assert.equal(job!.artifact!.transparent, true);
    assert.equal(job!.artifact!.width, 1536);
  });

  test("metadata records style_reference but does NOT record the raw spec", async () => {
    const { consumer, store, queue, storage } = build(codexOk);
    const s = spec({ description: "confidential trade secret, must not leak" });
    await store.create(record("img_2", s));
    await queue.enqueue(payload("img_2", s));
    await runOnce(consumer, store, "img_2");

    const meta = JSON.stringify([...storage.metadata.values()]);
    assert.doesNotMatch(meta, /confidential trade secret/);
    assert.match(meta, /"spec_hash":\s*"[0-9a-f]{64}"/);
    assert.match(meta, /"style_reference":\s*"tinyorbit-cloud-v1"/);
    assert.match(meta, /"generator":\s*"codex-chatgpt-image"/);
  });

  test("cleans up the job directory once done", async () => {
    const { consumer, store, queue } = build(codexOk);
    const s = spec();
    await store.create(record("img_3", s));
    await queue.enqueue(payload("img_3", s));
    await runOnce(consumer, store, "img_3");

    const left = await readdir(join(workRoot, "jobs")).catch((): string[] => []);
    assert.ok(!left.includes("img_3"), "the job directory must be removed");
  });
});

describe("consumer — Codex fails", () => {
  test("expired session -> CODEX_NOT_AUTHENTICATED, does NOT leak stderr externally", async () => {
    const { consumer, store, queue } = build(
      codexFailing("Error: not logged in; see /home/codex/.codex/auth.json"),
    );
    const s = spec();
    await store.create(record("img_4", s));
    await queue.enqueue(payload("img_4", s));

    assert.equal(await runOnce(consumer, store, "img_4"), "failed");
    const job = await store.get("img_4");
    assert.equal(job!.errorCode, "CODEX_NOT_AUTHENTICATED");
    // stderr contains the token file's path — must never be exposed externally.
    assert.doesNotMatch(JSON.stringify(job), /auth\.json/);
  });

  test("account lacks the image-generation capability -> explicit CAPABILITY error", async () => {
    // Must report an explicit capability error, and state plainly there
    // is no fallback through an API key.
    const { consumer, store, queue } = build(
      codexFailing("image generation is not available on your plan"),
    );
    const s = spec();
    await store.create(record("img_5", s));
    await queue.enqueue(payload("img_5", s));

    assert.equal(await runOnce(consumer, store, "img_5"), "failed");
    const job = await store.get("img_5");
    assert.equal(job!.errorCode, "IMAGE_CAPABILITY_UNAVAILABLE");
    assert.match(job!.errorMessage!, /does NOT automatically fall back to an OpenAI API key/);
  });

  test("Codex reports success but produces no file -> still failed", async () => {
    const noFile: CodexRunner = async () => ({ exitCode: 0, durationMs: 5, stderrTail: "" });
    const { consumer, store, queue } = build(noFile);
    const s = spec();
    await store.create(record("img_6", s));
    await queue.enqueue(payload("img_6", s));
    assert.equal(await runOnce(consumer, store, "img_6"), "failed");
  });
});

describe("consumer — upload fails", () => {
  test("job ends up failed with STORAGE_UPLOAD_FAILED", async () => {
    const storage = new FakeStorage();
    storage.failUploads = true;
    const { consumer, store, queue } = build(codexOk, storage);
    const s = spec();
    await store.create(record("img_7", s));
    await queue.enqueue(payload("img_7", s));

    assert.equal(await runOnce(consumer, store, "img_7"), "failed");
    assert.equal((await store.get("img_7"))!.errorCode, "STORAGE_UPLOAD_FAILED");
  });
});

describe("consumer — cancelling a job", () => {
  test("a job cancelled while still queued does NOT run Codex", async () => {
    // Important: every Codex run is real quota. Cancelling before it runs
    // must actually save that unit.
    let codexCalls = 0;
    const counting: CodexRunner = async (opts) => {
      codexCalls += 1;
      return codexOk(opts);
    };
    const { consumer, store, queue } = build(counting);
    const s = spec();
    await store.create(record("img_8", s));
    await queue.enqueue(payload("img_8", s));
    await queue.requestCancel("img_8");

    assert.equal(await runOnce(consumer, store, "img_8"), "cancelled");
    assert.equal(codexCalls, 0, "Codex must not run for a cancelled job");
  });
});

describe("consumer — salvaging an image Codex generated but misplaced", () => {
  // Codex generates the image into $CODEX_HOME/generated_images/<session>/
  // and only then moves it to the path we requested. Its self-check step
  // used to call `python`, and the image had no python, so it abandoned
  // the move step BUT STILL EXITED 0. Measured in a real pod on
  // 2026-09-12: 9 orphaned PNGs, timestamps lining up exactly with the
  // failed jobs. Each one is a unit of paid ChatGPT quota.

  /** "Forgetful" fake Codex: generates the image into its own store, forgets to move it. */
  function codexForgetful(body: string): CodexRunner {
    return async (opts) => {
      const dir = join(opts.codexHome, "generated_images", "session-abc");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "img-001.png"), Buffer.from(body));
      return { exitCode: 0, durationMs: 5, stderrTail: "" };
    };
  }

  test("picks up the image from generated_images instead of wasting a unit of quota", async () => {
    const { consumer, store, queue, storage } = build(codexForgetful("SALVAGED-IMAGE"));
    const s = spec();
    await store.create(record("img_salvage_1", s));
    await queue.enqueue(payload("img_salvage_1", s));

    assert.equal(await runOnce(consumer, store, "img_salvage_1"), "completed");
    const key = [...storage.objects.keys()].find((k) => k.endsWith("artifact.png"));
    assert.ok(key, "the artifact must have been uploaded");
    assert.equal(storage.objects.get(key!)!.toString(), "SALVAGED-IMAGE");
  });

  test("does NOT pick up an image older than when the job started — a wrong delivery is worse than reporting failure", async () => {
    const { consumer, store, queue } = build(async () => ({
      exitCode: 0,
      durationMs: 5,
      stderrTail: "",
    }));
    // Image from a PREVIOUS job, already sitting in the store from an hour ago.
    const dir = join(workRoot, "codex", "generated_images", "old-session");
    await mkdir(dir, { recursive: true });
    const oldFile = join(dir, "img-old.png");
    await writeFile(oldFile, Buffer.from("IMAGE-FROM-PREVIOUS-JOB"));
    const oneHourAgo = new Date(Date.now() - 3_600_000);
    await utimes(oldFile, oneHourAgo, oneHourAgo);

    const s = spec();
    await store.create(record("img_salvage_2", s));
    await queue.enqueue(payload("img_salvage_2", s));

    assert.equal(await runOnce(consumer, store, "img_salvage_2"), "failed");
    assert.equal((await store.get("img_salvage_2"))!.errorCode, "IMAGE_GENERATION_FAILED");
  });

  test("no generated_images store present -> reports a clean failure, no unrelated crash", async () => {
    const isolatedRoot = await mkdtemp(join(tmpdir(), "codex-worker-empty-"));
    try {
      const store = new InMemoryJobStore();
      const queue = new InMemoryJobQueue();
      const storage = new FakeStorage();
      const consumer = new Consumer({
        store,
        queue,
        storage: storage as unknown as ArtifactStore,
        config: {
          workDir: join(isolatedRoot, "jobs"),
          codexHome: join(isolatedRoot, "codex-empty"),
          codexBinary: "codex",
          jobTimeoutSeconds: 30,
          concurrency: 1,
        },
        runner: async () => ({ exitCode: 0, durationMs: 5, stderrTail: "" }),
      });
      const s = spec();
      await store.create(record("img_salvage_3", s));
      await queue.enqueue(payload("img_salvage_3", s));

      assert.equal(await runOnce(consumer, store, "img_salvage_3"), "failed");
      assert.equal((await store.get("img_salvage_3"))!.errorCode, "IMAGE_GENERATION_FAILED");
    } finally {
      await rm(isolatedRoot, { recursive: true, force: true });
    }
  });
});

describe("consumer — metadata must MEASURE the image, not echo the request", () => {
  // Measured on a real job 2026-09-12: asked for 1536x1536, Codex
  // returned 1254x1254, yet the metadata still claimed 1536x1536 because
  // the code wrote `spec.width` directly. Claude reads that metadata and
  // builds a layout on the wrong assumption, with no one the wiser.

  /** A minimal real PNG, with a chosen size and colorType. */
  function pngThat(w: number, h: number, colorType: number): Buffer {
    const channels = colorType === 6 ? 4 : 3;
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = colorType;
    const idat = deflateSync(Buffer.alloc(h * (1 + w * channels)));
    const chunk = (t: string, d: Buffer) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(d.length, 0);
      return Buffer.concat([len, Buffer.from(t, "latin1"), d, Buffer.alloc(4)]);
    };
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", idat),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  }

  function codexReturning(buf: Buffer): CodexRunner {
    return async (opts) => {
      const m = /Save the (?:final generated asset|edited artifact) to exactly this path: (.+)$/m.exec(
        opts.prompt,
      );
      await writeFile(m![1]!.trim(), buf);
      return { exitCode: 0, durationMs: 5, stderrTail: "" };
    };
  }

  test("records the image's REAL dimensions, not the requested ones", async () => {
    const { consumer, store, queue, storage } = build(codexReturning(pngThat(1254, 1254, 6)));
    const s = spec({ width: 1536, height: 1536 });
    await store.create(record("img_meta_1", s));
    await queue.enqueue(payload("img_meta_1", s));

    assert.equal(await runOnce(consumer, store, "img_meta_1"), "completed");
    const art = (await store.get("img_meta_1"))!.artifact!;
    assert.equal(art.width, 1254, "must be the measurement from the file");
    assert.equal(art.height, 1254);

    const meta = [...storage.metadata.values()][0] as Record<string, unknown>;
    assert.equal(meta.width, 1254, "metadata.json must also follow the file");
    assert.equal(meta.height, 1254);
  });

  test("an image with no alpha channel yields transparent=false, even if a transparent background was requested", async () => {
    // Asking for one thing and getting another is a real occurrence;
    // metadata must state what's actually in the file, otherwise Claude
    // will composite an opaque image onto a layout that assumes it's
    // transparent.
    const { consumer, store, queue } = build(codexReturning(pngThat(64, 64, 2)));
    const s = spec({ transparentBackground: true });
    await store.create(record("img_meta_2", s));
    await queue.enqueue(payload("img_meta_2", s));

    assert.equal(await runOnce(consumer, store, "img_meta_2"), "completed");
    assert.equal((await store.get("img_meta_2"))!.artifact!.transparent, false);
  });

  test("falls back to the spec when the header can't be read, does NOT fail the job", async () => {
    const { consumer, store, queue } = build(codexReturning(Buffer.from("not an image")));
    const s = spec({ width: 1536, height: 1536 });
    await store.create(record("img_meta_3", s));
    await queue.enqueue(payload("img_meta_3", s));

    assert.equal(await runOnce(consumer, store, "img_meta_3"), "completed");
    const art = (await store.get("img_meta_3"))!.artifact!;
    assert.deepEqual([art.width, art.height], [1536, 1536]);
  });
});

describe("pruneGeneratedImages — keeps Codex's image store from growing without bound", () => {
  // Codex leaves an image behind AFTER EVERY job, including successful
  // ones. Measured 2026-09-12: 9 files / 5.9MB after one afternoon of
  // testing, ~0.7MB per run.

  async function seedImageStore(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), "codexhome-"));
    await mkdir(join(home, "generated_images", "old-session"), { recursive: true });
    await mkdir(join(home, "generated_images", "new-session"), { recursive: true });
    const oldFile = join(home, "generated_images", "old-session", "old.png");
    const newFile = join(home, "generated_images", "new-session", "new.png");
    await writeFile(oldFile, Buffer.from("OLD"));
    await writeFile(newFile, Buffer.from("NEW"));
    const twoDaysAgo = new Date(Date.now() - 48 * 3_600_000);
    await utimes(oldFile, twoDaysAgo, twoDaysAgo);
    return home;
  }

  test("removes expired images and drops the now-empty session directory too", async () => {
    const home = await seedImageStore();
    try {
      const n = await pruneGeneratedImages(home, 24 * 3_600_000);
      assert.equal(n, 1);
      const remaining = await readdir(join(home, "generated_images"));
      assert.deepEqual(remaining, ["new-session"], "the empty directory must be cleaned up too");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("does NOT touch images still within the retention window — salvage still needs to read them", async () => {
    const home = await seedImageStore();
    try {
      const n = await pruneGeneratedImages(home, 72 * 3_600_000);
      assert.equal(n, 0);
      assert.equal((await readdir(join(home, "generated_images"))).length, 2);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("maxAge = 0 means COMPLETELY OFF, deletes nothing", async () => {
    const home = await seedImageStore();
    try {
      assert.equal(await pruneGeneratedImages(home, 0), 0);
      assert.equal((await readdir(join(home, "generated_images"))).length, 2);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a nonexistent store returns 0, doesn't throw", async () => {
    assert.equal(await pruneGeneratedImages(join(tmpdir(), "does-not-exist-xyz"), 1000), 0);
  });
});
