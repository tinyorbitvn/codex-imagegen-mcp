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
import sharp from "sharp";

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
  const m = /Copy the (?:generated|edited) image, unchanged, to exactly this path: (.+)$/m.exec(
    opts.prompt,
  );
  assert.ok(m, "the instructions must state the output path");
  await writeFile(m![1]!.trim(), Buffer.from("PNGFAKE"));
  return { exitCode: 0, durationMs: 5, stderrTail: "" };
};

function codexFailing(stderr: string): CodexRunner {
  return async () => ({ exitCode: 1, durationMs: 5, stderrTail: stderr });
}

function build(runner: CodexRunner, storage = new FakeStorage(), concurrency = 1) {
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
      concurrency,
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

  test("a spent ChatGPT usage limit is reported as itself, not as a generic failure", async () => {
    // What the caller gets back has to name the cause: the account's
    // quota is gone, the request was fine, and here is when to retry.
    const { consumer, store, queue } = build(
      codexFailing(
        "workdir: /work/jobs/img_quota\n" +
          "ERROR: You've hit your usage limit. Upgrade to Pro, visit\n" +
          "https://chatgpt.com/codex/settings/usage to purchase more credits\n" +
          "or try again at 9:02 AM.",
      ),
    );
    const s = spec();
    await store.create(record("img_quota", s));
    await queue.enqueue(payload("img_quota", s));

    assert.equal(await runOnce(consumer, store, "img_quota"), "failed");
    const job = await store.get("img_quota");
    assert.equal(job!.errorCode, "CODEX_QUOTA_EXHAUSTED");
    assert.match(job!.errorMessage!, /usage limit/i);
    assert.match(job!.errorMessage!, /9:02 AM/);
    // The retry time is the ONLY thing taken from stderr: no workdir, no URL.
    assert.doesNotMatch(JSON.stringify(job), /workdir|chatgpt\.com/);
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
      const m = /Copy the (?:generated|edited) image, unchanged, to exactly this path: (.+)$/m.exec(
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

describe("consumer — animate_image", () => {
  const SOURCE_KEY = "projects/tinyorbit-cloud/bell/v1/artifact.png";

  async function seed(storage: FakeStorage, body?: Buffer): Promise<void> {
    storage.objects.set(
      SOURCE_KEY,
      body ??
        (await sharp({
          create: { width: 64, height: 64, channels: 4, background: { r: 200, g: 150, b: 0, alpha: 1 } },
        })
          .png()
          .toBuffer()),
    );
  }

  function animatePayload(jobId: string): JobPayload {
    return {
      jobId,
      kind: "animate",
      spec: spec({ assetId: "bell", outputFormat: "webp", filename: "animation.webp", width: 64, height: 64 }),
      version: 2,
      parentVersion: 1,
      sourceKey: SOURCE_KEY,
      instructions: null,
      animation: { motion: "shake", intensity: "medium", durationMs: 800 },
    };
  }

  const codexMustNotRun: CodexRunner = async () => {
    throw new Error("Codex must not run for animate_image");
  };

  test("renders WebP, GIF and metadata without running Codex", async () => {
    const { consumer, store, queue, storage } = build(codexMustNotRun);
    await seed(storage);
    const p = animatePayload("img_anim1");
    await store.create(record(p.jobId, p.spec, 2));
    await queue.enqueue(p);

    assert.equal(await runOnce(consumer, store, p.jobId), "completed");
    const a = (await store.get(p.jobId))!.artifact!;
    assert.equal(a.key, "projects/tinyorbit-cloud/bell/v2/animation.webp");
    assert.equal(a.mimeType, "image/webp");
    assert.equal(a.parentVersion, 1);
    assert.equal(a.transparent, true);
    assert.equal(a.animation!.motion, "shake");
    assert.equal(a.animation!.frames, 19);
    assert.equal(a.animation!.gif.key, "projects/tinyorbit-cloud/bell/v2/animation.gif");
    assert.equal(a.animation!.gif.url, `https://s3.example/${a.animation!.gif.key}`);
    assert.ok(storage.objects.has(a.key) && storage.objects.has(a.animation!.gif.key));

    const meta = storage.metadata.get("projects/tinyorbit-cloud/bell/v2/metadata.json") as Record<string, unknown>;
    assert.equal(meta.generator, "animate-preset");
    assert.equal(meta.content_type, "image/webp");
    const m = await sharp(storage.objects.get(a.key)!, { animated: true }).metadata();
    assert.equal(m.pages, 19);
  });

  test("a source that is not an image fails with the renderer's reason", async () => {
    const { consumer, store, queue, storage } = build(codexMustNotRun);
    await seed(storage, Buffer.from("junk"));
    const p = animatePayload("img_anim2");
    await store.create(record(p.jobId, p.spec, 2));
    await queue.enqueue(p);

    assert.equal(await runOnce(consumer, store, p.jobId), "failed");
    const job = (await store.get(p.jobId))!;
    assert.equal(job.errorCode, "IMAGE_GENERATION_FAILED");
    assert.match(job.errorMessage ?? "", /^Could not render the animation: /);
  });

  test("an animate job cancelled while it renders publishes nothing", async () => {
    const { consumer, store, queue, storage } = build(codexMustNotRun);
    await seed(storage);
    const p = animatePayload("img_anim4");
    const realDownload = storage.download.bind(storage);
    // cancel_image_job arriving mid-job: flag for the worker, status for the client.
    storage.download = async (key: string) => {
      await queue.requestCancel(p.jobId);
      await store.markCancelled(p.jobId);
      return realDownload(key);
    };
    await store.create(record(p.jobId, p.spec, 2));
    await queue.enqueue(p);

    assert.equal(await runOnce(consumer, store, p.jobId), "cancelled");
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await store.get(p.jobId))!.status, "cancelled");
    assert.equal(storage.objects.has("projects/tinyorbit-cloud/bell/v2/animation.webp"), false);
  });

  test("an animate job cancelled while queued is never rendered", async () => {
    const { consumer, store, queue, storage } = build(codexMustNotRun);
    await seed(storage);
    let downloads = 0;
    const realDownload = storage.download.bind(storage);
    storage.download = async (key: string) => {
      downloads += 1;
      return realDownload(key);
    };
    const p = animatePayload("img_anim3");
    await store.create(record(p.jobId, p.spec, 2));
    await queue.enqueue(p);
    await queue.requestCancel(p.jobId);

    assert.equal(await runOnce(consumer, store, p.jobId), "cancelled");
    assert.equal(downloads, 0, "the source must not even be fetched");
    assert.equal(storage.objects.has("projects/tinyorbit-cloud/bell/v2/animation.webp"), false);
  });
});

describe("consumer — uploads", () => {
  const UP1 = "uploads/tinyorbit-cloud/upl_" + "1".repeat(32);
  const UP2 = "uploads/tinyorbit-cloud/upl_" + "2".repeat(32);

  function jpeg(w: number, h: number, orientation?: number): Promise<Buffer> {
    const s = sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 40, b: 40 } } }).jpeg();
    return (orientation ? s.withMetadata({ orientation }) : s).toBuffer();
  }

  test("references land as reference-N.png and the prompt names them", async () => {
    const seen: { prompt?: string; files?: string[]; cwd?: string; format?: string } = {};
    const runner: CodexRunner = async (opts) => {
      seen.prompt = opts.prompt;
      seen.cwd = opts.cwd;
      seen.files = await readdir(opts.cwd);
      seen.format = (await sharp(join(opts.cwd, "reference-1.png")).metadata()).format;
      return codexOk(opts);
    };
    const { consumer, store, queue, storage } = build(runner);
    storage.objects.set(UP1, await jpeg(40, 30));
    storage.objects.set(UP2, await jpeg(30, 40));
    const p: JobPayload = { ...payload("img_refs", spec()), referenceKeys: [UP1, UP2] };
    await store.create(record(p.jobId, p.spec));
    await queue.enqueue(p);

    assert.equal(await runOnce(consumer, store, p.jobId), "completed");
    assert.ok(seen.files!.includes("reference-1.png") && seen.files!.includes("reference-2.png"));
    assert.ok(seen.prompt!.includes(`${seen.cwd}/reference-1.png`));
    assert.ok(seen.prompt!.includes(`${seen.cwd}/reference-2.png`));
    assert.match(seen.prompt!, /Do not copy text, logos or watermarks/);
    assert.equal(seen.format, "png");
  });

  test("an uploaded edit source is turned upright and stripped before Codex sees it", async () => {
    const seen: { width?: number; height?: number; orientation?: number; format?: string } = {};
    const runner: CodexRunner = async (opts) => {
      const m = await sharp(join(opts.cwd, "source.png")).metadata();
      Object.assign(seen, { width: m.width, height: m.height, orientation: m.orientation, format: m.format });
      return codexOk(opts);
    };
    const { consumer, store, queue, storage } = build(runner);
    storage.objects.set(UP1, await jpeg(40, 20, 6));
    const p: JobPayload = {
      jobId: "img_upedit", kind: "edit", spec: spec({ width: 20, height: 40 }), version: 1,
      parentVersion: null, sourceKey: UP1, instructions: "make it blue",
    };
    await store.create(record(p.jobId, p.spec));
    await queue.enqueue(p);

    assert.equal(await runOnce(consumer, store, p.jobId), "completed");
    assert.deepEqual(seen, { width: 20, height: 40, orientation: undefined, format: "png" });
  });

  test("animate_image renders an upright animation from an upload", async () => {
    const { consumer, store, queue, storage } = build(async () => {
      throw new Error("Codex must not run for animate_image");
    });
    storage.objects.set(UP1, await jpeg(40, 20, 6));
    const p: JobPayload = {
      jobId: "img_upanim", kind: "animate",
      spec: spec({ assetId: "logo", outputFormat: "webp", filename: "animation.webp", width: 20, height: 40 }),
      version: 1, parentVersion: null, sourceKey: UP1, instructions: null,
      animation: { motion: "pulse", intensity: "low", durationMs: 400 },
    };
    await store.create(record(p.jobId, p.spec));
    await queue.enqueue(p);

    assert.equal(await runOnce(consumer, store, p.jobId), "completed");
    const a = (await store.get(p.jobId))!.artifact!;
    assert.equal(a.parentVersion, null);
    assert.ok(a.height > a.width, `upright portrait canvas, got ${a.width}x${a.height}`);
  });

  test("an upload that expired before the job ran fails as UPLOAD_NOT_FOUND", async () => {
    const { consumer, store, queue } = build(codexOk);
    const p: JobPayload = { ...payload("img_refgone", spec()), referenceKeys: [UP1] };
    await store.create(record(p.jobId, p.spec));
    await queue.enqueue(p);

    assert.equal(await runOnce(consumer, store, p.jobId), "failed");
    const job = (await store.get(p.jobId))!;
    assert.equal(job.errorCode, "UPLOAD_NOT_FOUND");
    assert.match(job.errorMessage ?? "", /upload it again/);
  });
});

describe("consumer — the worker converts, Codex only copies", () => {
  test("a PNG from Codex becomes the WebP the client asked for", async () => {
    const png = await sharp({ create: { width: 64, height: 48, channels: 4, background: "#3a7c" } }).png().toBuffer();
    const { consumer, store, queue, storage } = build(async (opts) => {
      const m = /exactly this path: (.+)$/m.exec(opts.prompt);
      await writeFile(m![1]!.trim(), png);
      return { exitCode: 0, durationMs: 5, stderrTail: "", threadId: "t-convert" };
    });
    const s = spec({ outputFormat: "webp", filename: "artifact.webp" });
    await store.create(record("img_convert_1", s));
    await queue.enqueue(payload("img_convert_1", s));

    assert.equal(await runOnce(consumer, store, "img_convert_1"), "completed");
    const key = [...storage.objects.keys()].find((k) => k.endsWith("/artifact.webp"));
    assert.ok(key, "uploaded under the requested filename");
    const meta = await sharp(storage.objects.get(key!)!).metadata();
    assert.equal(meta.format, "webp");
    assert.deepEqual([meta.width, meta.height, meta.hasAlpha], [64, 48, true]);
  });
});

describe("consumer — an older Codex habit still works", () => {
  test("a PNG written straight to artifact.webp is converted in place", async () => {
    const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#123" } }).png().toBuffer();
    const { consumer, store, queue, storage } = build(async (opts) => {
      await writeFile(join(opts.cwd, "artifact.webp"), png);
      return { exitCode: 0, durationMs: 5, stderrTail: "", threadId: "t-legacy" };
    });
    const s = spec({ assetId: "legacy", outputFormat: "webp", filename: "artifact.webp" });
    await store.create(record("img_legacy_1", s));
    await queue.enqueue(payload("img_legacy_1", s));

    assert.equal(await runOnce(consumer, store, "img_legacy_1"), "completed");
    const key = [...storage.objects.keys()].find((k) => k.includes("/legacy/") && k.endsWith("/artifact.webp"));
    assert.equal((await sharp(storage.objects.get(key!)!).metadata()).format, "webp");
  });
});

describe("consumer — salvage under concurrency", () => {
  // Jobs running side by side share generated_images/: the newest file there may be another job's image.
  function codexGeneratesInto(session: string, threadId: string | undefined): CodexRunner {
    return async (opts) => {
      const dir = join(opts.codexHome, "generated_images", session);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "img-001.png"), Buffer.from(`FROM-${session}`));
      return { exitCode: 0, durationMs: 5, stderrTail: "", threadId };
    };
  }

  test("takes the image from this job's own thread", async () => {
    const { consumer, store, queue, storage } = build(codexGeneratesInto("thread-mine", "thread-mine"), new FakeStorage(), 2);
    const s = spec({ assetId: "thread-1" });
    await store.create(record("img_thread_1", s));
    await queue.enqueue(payload("img_thread_1", s));
    assert.equal(await runOnce(consumer, store, "img_thread_1"), "completed");
    const key = [...storage.objects.keys()].find((k) => k.includes("/thread-1/") && k.endsWith("artifact.png"));
    assert.equal(storage.objects.get(key!)!.toString(), "FROM-thread-mine");
  });

  test("never takes another thread's image", async () => {
    const { consumer, store, queue } = build(codexGeneratesInto("thread-other", "thread-mine"), new FakeStorage(), 2);
    const s = spec();
    await store.create(record("img_thread_2", s));
    await queue.enqueue(payload("img_thread_2", s));
    assert.equal(await runOnce(consumer, store, "img_thread_2"), "failed");
    assert.equal((await store.get("img_thread_2"))!.errorCode, "IMAGE_GENERATION_FAILED");
  });

  test("without a thread id, salvages nothing when jobs can run side by side", async () => {
    const { consumer, store, queue } = build(codexGeneratesInto("some-session", undefined), new FakeStorage(), 2);
    const s = spec();
    await store.create(record("img_thread_3", s));
    await queue.enqueue(payload("img_thread_3", s));
    assert.equal(await runOnce(consumer, store, "img_thread_3"), "failed");
  });
});

describe("consumer — one Codex at a time while a token refresh may run", () => {
  async function runTwo(expiresInMs: number): Promise<number> {
    const home = await mkdtemp(join(tmpdir(), "codex-home-"));
    const jwt = `h.${Buffer.from(JSON.stringify({ exp: Math.floor((Date.now() + expiresInMs) / 1000) })).toString("base64url")}.s`;
    await writeFile(join(home, "auth.json"), JSON.stringify({ tokens: { access_token: jwt }, last_refresh: new Date().toISOString() }));
    let running = 0;
    let most = 0;
    const store = new InMemoryJobStore();
    const queue = new InMemoryJobQueue();
    const consumer = new Consumer({
      store,
      queue,
      storage: new FakeStorage() as unknown as ArtifactStore,
      config: { workDir: join(home, "jobs"), codexHome: home, codexBinary: "codex", jobTimeoutSeconds: 30, concurrency: 3 },
      runner: async (opts) => {
        running++;
        most = Math.max(most, running);
        await new Promise((r) => setTimeout(r, 150));
        await codexOk(opts);
        running--;
        return { exitCode: 0, durationMs: 150, stderrTail: "", threadId: "t" };
      },
    });
    for (const id of ["img_gate_a", "img_gate_b"]) {
      const s = spec({ assetId: id });
      await store.create(record(id, s));
      await queue.enqueue(payload(id, s));
    }
    void consumer.run();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const done = await Promise.all(["img_gate_a", "img_gate_b"].map(async (id) => (await store.get(id))?.status));
      if (done.every((s) => s === "completed")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    consumer.stop();
    await new Promise((r) => setTimeout(r, 60));
    await rm(home, { recursive: true, force: true });
    return most;
  }

  test("runs jobs side by side while the access token has long to live", async () => {
    assert.equal(await runTwo(10 * 24 * 3_600_000), 2);
  });

  test("runs them one at a time when expiry is close enough for Codex to refresh", async () => {
    // Two processes refreshing at once: the second gets "refresh token was already used".
    assert.equal(await runTwo(10 * 60_000), 1);
  });
});
