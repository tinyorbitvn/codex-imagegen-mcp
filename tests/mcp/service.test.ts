// Tests for the MCP contract + job lifecycle of imagegen-mcp.
//
// Uses an in-memory JobStore/JobQueue so it runs without Redis — this
// locks down the MCP contract first; wiring in the real Codex-backed
// worker comes later.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { ImagegenError } from "../../src/contracts/index.ts";
import type { ArtifactRef, JobPayload } from "../../src/contracts/index.ts";
import { InMemoryJobQueue, InMemoryJobStore } from "../../src/queue/index.ts";

import { ImagegenService } from "../../src/mcp/service.ts";

function build(limits = { createImagePerHour: 100, editImagePerHour: 100 }) {
  const store = new InMemoryJobStore();
  const queue = new InMemoryJobQueue();
  const service = new ImagegenService({ store, queue, config: { rateLimit: limits } });
  return { service, store, queue };
}

/** Simulates a worker completing a job it ALREADY DEQUEUED. */
async function completePayload(
  payload: JobPayload,
  store: InMemoryJobStore,
  queue: InMemoryJobQueue,
): Promise<ArtifactRef> {
  const { spec, version, parentVersion, jobId } = payload;
  const artifact: ArtifactRef = {
    projectId: spec.projectId,
    assetId: spec.assetId,
    version,
    parentVersion,
    key: `projects/${spec.projectId}/${spec.assetId}/v${version}/${spec.filename}`,
    url: `https://s3.example/mcp-artifacts/projects/${spec.projectId}/${spec.assetId}/v${version}/${spec.filename}`,
    mimeType: spec.outputFormat === "png" ? "image/png" : "image/webp",
    width: spec.width,
    height: spec.height,
    transparent: spec.transparentBackground,
    specHash: "deadbeef",
    createdAt: new Date().toISOString(),
  };
  await store.markCompleted(jobId, artifact);
  await queue.ack(jobId);
  return artifact;
}

/** Convenience: dequeue the next job then complete it. */
async function completeNextJob(
  queue: InMemoryJobQueue,
  store: InMemoryJobStore,
): Promise<ArtifactRef> {
  const payload = await queue.dequeue(1000);
  assert.ok(payload, "there must be a job in the queue");
  return completePayload(payload!, store, queue);
}

describe("create_image", () => {
  test("returns job_id immediately and pushes exactly one job onto the queue", async () => {
    // An MCP call must return immediately instead of blocking for the
    // whole render — that's what lets a client run several images in
    // parallel.
    const { service, queue } = build();
    const r = await service.createImage(
      {
        project_id: "tinyorbit-cloud",
        asset_id: "homepage-hero-vps",
        description: "VPS server",
      },
      "claude-design",
    );
    assert.match(r.job_id, /^img_[0-9a-f]{32}$/);
    assert.equal(r.status, "queued");
    assert.equal(await queue.depth(), 1);
  });

  test("defaults: transparent background, isolated object, png", async () => {
    // These three defaults are what makes an artifact usable for web
    // animation without having to spell them out every time.
    const { service, queue } = build();
    await service.createImage(
      { project_id: "p", asset_id: "a", description: "x" },
      "claude-design",
    );
    const payload = await queue.dequeue(1000);
    assert.equal(payload!.spec.transparentBackground, true);
    assert.equal(payload!.spec.isolatedObject, true);
    assert.equal(payload!.spec.outputFormat, "png");
    assert.equal(payload!.spec.safePaddingPercent, 12);
  });

  test("style.reference resolves to the profile's content", async () => {
    const { service, queue } = build();
    await service.createImage(
      {
        project_id: "p",
        asset_id: "a",
        description: "x",
        style: { reference: "tinyorbit-cloud-v1" },
      },
      "claude-design",
    );
    const payload = await queue.dequeue(1000);
    assert.match(payload!.spec.stylePrompt, /claymorphism/);
    assert.match(payload!.spec.stylePrompt, /#2E5BFF/);
    assert.equal(payload!.spec.styleReference, "tinyorbit-cloud-v1");
  });

  test("nonexistent style profile -> error spells out the valid names", async () => {
    const { service } = build();
    await assert.rejects(
      () =>
        service.createImage(
          { project_id: "p", asset_id: "a", description: "x", style: { reference: "does-not-exist" } },
          "claude-design",
        ),
      (e: unknown) =>
        e instanceof ImagegenError &&
        e.code === "UNKNOWN_STYLE_PROFILE" &&
        /tinyorbit-cloud-v1/.test(e.message),
    );
  });

  test("rejects invalid project_id/asset_id BEFORE creating the job", async () => {
    const { service, queue } = build();
    await assert.rejects(
      () =>
        service.createImage(
          { project_id: "../etc", asset_id: "a", description: "x" },
          "claude-design",
        ),
      (e: unknown) => e instanceof ImagegenError && e.code === "INVALID_PROJECT",
    );
    await assert.rejects(
      () =>
        service.createImage(
          { project_id: "p", asset_id: "a; rm -rf /", description: "x" },
          "claude-design",
        ),
      (e: unknown) => e instanceof ImagegenError && e.code === "INVALID_ASSET_ID",
    );
    // No job made it onto the queue — the check blocks BEFORE spending
    // any resources.
    assert.equal(await queue.depth(), 0);
  });

  test("when the queue is full, reject immediately with RATE_LIMITED", async () => {
    const store = new InMemoryJobStore();
    const queue = new InMemoryJobQueue(2);
    const service = new ImagegenService({
      store,
      queue,
      config: { rateLimit: { createImagePerHour: 100, editImagePerHour: 100 } },
    });
    for (const id of ["a1", "a2"]) {
      await service.createImage(
        { project_id: "p", asset_id: id, description: "x" },
        "claude-design",
      );
    }
    await assert.rejects(
      () =>
        service.createImage(
          { project_id: "p", asset_id: "a3", description: "x" },
          "claude-design",
        ),
      (e: unknown) => e instanceof ImagegenError && e.code === "RATE_LIMITED",
    );
  });
});

describe("version numbering", () => {
  test("allocates from the ALREADY-ALLOCATED watermark so two parallel jobs don't collide", async () => {
    // If allocation went by the highest completed version, both jobs
    // would get v1 and the later job would overwrite the earlier one on
    // object storage.
    const { service, queue } = build();
    await service.createImage(
      { project_id: "p", asset_id: "a", description: "x" },
      "claude-design",
    );
    await service.createImage(
      { project_id: "p", asset_id: "a", description: "y" },
      "claude-design",
    );
    const first = await queue.dequeue(1000);
    const second = await queue.dequeue(1000);
    assert.equal(first!.version, 1);
    assert.equal(second!.version, 2, "the second job must get a different version");
  });

  test("a failed job releases its version number back for next time", async () => {
    const { service, store, queue } = build();
    const r = await service.createImage(
      { project_id: "p", asset_id: "a", description: "x" },
      "claude-design",
    );
    await queue.dequeue(1000);
    await store.markFailed(r.job_id, "IMAGE_GENERATION_FAILED", "broken");
    assert.equal(await store.highestAllocatedVersion("p", "a"), 0);
  });
});

describe("edit_image", () => {
  test("creates a new version and keeps lineage, does NOT overwrite the old one", async () => {
    const { service, store, queue } = build();
    await service.createImage(
      { project_id: "p", asset_id: "a", description: "x" },
      "claude-design",
    );
    await completeNextJob(queue, store);

    const e = await service.editImage(
      { project_id: "p", asset_id: "a", instructions: "shrink it down" },
      "claude-design",
    );
    const payload = await queue.dequeue(1000);
    assert.equal(payload!.kind, "edit");
    assert.equal(payload!.version, 2);
    assert.equal(payload!.parentVersion, 1, "must keep the lineage");
    assert.match(payload!.sourceKey!, /\/v1\//, "must point at the correct v1 source image");

    await completePayload(payload!, store, queue);
    const res = (await service.getImageJob(e.job_id)) as any;
    assert.equal(res.artifact.version, 2);
    assert.equal(res.artifact.parent_version, 1);

    // v1 is still queryable — proof it wasn't overwritten.
    const v1 = (await service.getArtifact({ project_id: "p", asset_id: "a", version: 1 })) as any;
    assert.equal(v1.artifact.version, 1);
  });

  test("editing a nonexistent artifact reports JOB_NOT_FOUND", async () => {
    const { service } = build();
    await assert.rejects(
      () =>
        service.editImage(
          { project_id: "p", asset_id: "missing-asset", instructions: "x" },
          "claude-design",
        ),
      (e: unknown) => e instanceof ImagegenError && e.code === "JOB_NOT_FOUND",
    );
  });
});

describe("get_artifact", () => {
  test("omitting version returns the latest one", async () => {
    const { service, store, queue } = build();
    await service.createImage(
      { project_id: "p", asset_id: "a", description: "x" },
      "claude-design",
    );
    await completeNextJob(queue, store);
    await service.editImage(
      { project_id: "p", asset_id: "a", instructions: "y" },
      "claude-design",
    );
    await completeNextJob(queue, store);

    const latest = (await service.getArtifact({ project_id: "p", asset_id: "a" })) as any;
    assert.equal(latest.artifact.version, 2);
  });
});

describe("cancel_image_job", () => {
  test("cancels a queued job and sets the cancel flag for the worker", async () => {
    const { service, queue } = build();
    const r = await service.createImage(
      { project_id: "p", asset_id: "a", description: "x" },
      "claude-design",
    );
    const out = (await service.cancelImageJob(r.job_id)) as any;
    assert.equal(out.status, "cancelled");
    // The cancel flag is what actually stops the worker rather than just
    // changing the status on paper — without it Codex would still run to
    // completion and still spend quota.
    assert.equal(await queue.isCancelled(r.job_id), true);
  });

  test("a completed job CANNOT be cancelled", async () => {
    const { service, store, queue } = build();
    const r = await service.createImage(
      { project_id: "p", asset_id: "a", description: "x" },
      "claude-design",
    );
    await completeNextJob(queue, store);
    await assert.rejects(
      () => service.cancelImageJob(r.job_id),
      (e: unknown) => e instanceof ImagegenError && e.code === "JOB_CANCELLED",
    );
  });
});

describe("rate limit", () => {
  test("counted per principal", async () => {
    const { service } = build({ createImagePerHour: 2, editImagePerHour: 2 });
    await service.createImage({ project_id: "p", asset_id: "a1", description: "x" }, "claude");
    await service.createImage({ project_id: "p", asset_id: "a2", description: "x" }, "claude");
    await assert.rejects(
      () => service.createImage({ project_id: "p", asset_id: "a3", description: "x" }, "claude"),
      (e: unknown) => e instanceof ImagegenError && e.code === "RATE_LIMITED",
    );
    // Someone else can still call it.
    assert.ok(
      await service.createImage({ project_id: "p", asset_id: "a4", description: "x" }, "someone-else"),
    );
  });
});

describe("waitForImage — waiting and progress reporting", () => {
  test("returns the artifact when the job is done, with timed_out=false", async () => {
    const { service, store, queue } = build();
    const h = await service.createImage(
      { project_id: "p", asset_id: "a", description: "cube" },
      "test",
    );
    // Fake worker completes it after the wait loop has already started.
    const done = service.waitForImage({ job_id: h.job_id, timeout_seconds: 30 }, { pollMs: 5 });
    await completeNextJob(queue, store);
    const r = await done;
    assert.equal(r.status, "completed");
    assert.equal(r.timed_out, false);
    assert.ok((r.artifact as { url: string }).url.startsWith("https://"));
  });

  test("reports progress on EVERY status change, not spamming every loop", async () => {
    // This matters: the client displays progress, so emitting a "still
    // running" line every 3 seconds would be noise. Only emit when the
    // status actually changes.
    const { service, store, queue } = build();
    const h = await service.createImage(
      { project_id: "p", asset_id: "a", description: "x" },
      "test",
    );
    const seen: string[] = [];
    const done = service.waitForImage(
      { job_id: h.job_id, timeout_seconds: 30 },
      { pollMs: 5, onProgress: ({ status }) => void seen.push(status) },
    );
    const payload = await queue.dequeue(1000);
    await store.markRunning(payload!.jobId);
    // Wait a few ticks so the loop has time to sample the `running` state
    // before the job jumps to completed — at a 5ms cadence, 60ms is
    // plenty.
    await new Promise((r) => setTimeout(r, 60));
    await completePayload(payload!, store, queue);
    await done;
    assert.deepEqual(seen, ["queued", "running", "completed"]);
  });

  test("timing out is NOT an error and does NOT cancel the job", async () => {
    // The job already spent ChatGPT quota; cancelling it out of
    // impatience would just be throwing money away.
    const { service, store } = build();
    const h = await service.createImage(
      { project_id: "p", asset_id: "a", description: "x" },
      "test",
    );
    // A timeout_seconds smaller than the schema's minimum is INTENTIONAL:
    // waitForImage doesn't validate the schema (validation lives at the
    // tool layer), so the test stays deterministic without actually
    // waiting 10 real seconds.
    const r = await service.waitForImage({ job_id: h.job_id, timeout_seconds: 0.2 }, { pollMs: 5 });
    assert.equal(r.timed_out, true);
    assert.equal(r.status, "queued");
    const still = await store.get(h.job_id);
    assert.equal(still!.status, "queued", "the job must remain untouched for the worker to keep running");
  });

  test("client disconnecting stops the wait, job stays untouched", async () => {
    const { service, store } = build();
    const h = await service.createImage(
      { project_id: "p", asset_id: "a", description: "x" },
      "test",
    );
    const ac = new AbortController();
    ac.abort();
    const r = await service.waitForImage(
      { job_id: h.job_id, timeout_seconds: 30 },
      { signal: ac.signal, pollMs: 5 },
    );
    assert.equal(r.aborted, true);
    assert.equal((await store.get(h.job_id))!.status, "queued");
  });

  test("nonexistent job_id -> JOB_NOT_FOUND", async () => {
    const { service } = build();
    await assert.rejects(
      () => service.waitForImage({ job_id: "img_doesnotexist", timeout_seconds: 10 }, { pollMs: 5 }),
      (e: unknown) => (e as ImagegenError).code === "JOB_NOT_FOUND",
    );
  });
});
