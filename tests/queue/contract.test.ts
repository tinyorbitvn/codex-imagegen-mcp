// The contract every JobStore/JobQueue implementation MUST uphold.
//
// Runs against the in-memory implementation because it doesn't need Redis.
// The Redis implementation (RedisJobStore/RedisJobQueue) MUST behave
// IDENTICALLY — the invariants below are implemented in parallel in both
// files, and this is where they're written down.
//
// To run this same suite against real Redis, stand up a Redis instance and
// swap the factory at the top of the file; every assertion stays the same.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { ImagegenError } from "../../src/contracts/index.ts";
import type { ArtifactRef, JobPayload, JobRecord } from "../../src/contracts/index.ts";
import { InMemoryJobQueue, InMemoryJobStore } from "../../src/queue/memory.ts";

function record(over: Partial<JobRecord> = {}): JobRecord {
  return {
    jobId: "img_1", status: "queued", projectId: "p", assetId: "a",
    version: 1, parentVersion: null, principal: "claude-design",
    createdAt: new Date().toISOString(), startedAt: null, completedAt: null,
    artifact: null, errorCode: null, errorMessage: null, traceId: null,
    ...over,
  };
}

function artifact(version = 1): ArtifactRef {
  return {
    projectId: "p", assetId: "a", version, parentVersion: null,
    key: `projects/p/a/v${version}/artifact.png`, url: "https://s3.example/x",
    mimeType: "image/png", width: 1536, height: 1536, transparent: true,
    specHash: "deadbeef", createdAt: new Date().toISOString(),
  };
}

function payload(jobId: string): JobPayload {
  return {
    jobId, kind: "create", version: 1, parentVersion: null,
    sourceKey: null, instructions: null,
    spec: {
      projectId: "p", assetId: "a", description: "x", stylePrompt: "",
      styleReference: null, aspectRatio: "1:1", width: 1536, height: 1536,
      transparentBackground: true, outputFormat: "png", isolatedObject: true,
      safePaddingPercent: 12, filename: "artifact.png",
    },
  };
}

describe("JobStore — state invariants", () => {
  test("queued -> running -> completed", async () => {
    const s = new InMemoryJobStore();
    await s.create(record());
    await s.markRunning("img_1");
    assert.equal((await s.get("img_1"))!.status, "running");
    await s.markCompleted("img_1", artifact());
    const done = (await s.get("img_1"))!;
    assert.equal(done.status, "completed");
    assert.equal(done.artifact!.version, 1);
  });

  test("a completed job is NOT overwritten by markFailed", async () => {
    // Protects a published artifact: a late cleanup pass must not turn a
    // successful job into a failed one.
    const s = new InMemoryJobStore();
    await s.create(record());
    await s.markCompleted("img_1", artifact());
    await s.markFailed("img_1", "IMAGE_GENERATION_FAILED", "late");
    assert.equal((await s.get("img_1"))!.status, "completed");
  });

  test("only a queued or running job can be cancelled", async () => {
    const s = new InMemoryJobStore();
    await s.create(record({ jobId: "img_q" }));
    assert.equal(await s.markCancelled("img_q"), true);

    await s.create(record({ jobId: "img_done" }));
    await s.markCompleted("img_done", artifact(9));
    assert.equal(await s.markCancelled("img_done"), false);
    assert.equal((await s.get("img_done"))!.status, "completed");
  });
});

describe("JobStore — version allocation", () => {
  test("counts by the ALLOCATED marker, not the completed one", async () => {
    // Allocating by completed version would let two parallel jobs both get
    // v1, and the later one overwrites the earlier one in object storage.
    const s = new InMemoryJobStore();
    await s.create(record({ jobId: "img_1", version: 1 }));
    assert.equal(await s.highestAllocatedVersion("p", "a"), 1);
    assert.equal(await s.getArtifact("p", "a"), null, "no completed version yet");
  });

  test("a failed job gives its version number back for next time", async () => {
    const s = new InMemoryJobStore();
    await s.create(record({ jobId: "img_1", version: 1 }));
    await s.markFailed("img_1", "IMAGE_GENERATION_FAILED", "x");
    assert.equal(await s.highestAllocatedVersion("p", "a"), 0);
  });

  test("getArtifact with no version returns the latest one", async () => {
    const s = new InMemoryJobStore();
    for (const v of [1, 2, 3]) {
      await s.create(record({ jobId: `img_${v}`, version: v }));
      await s.markCompleted(`img_${v}`, artifact(v));
    }
    assert.equal((await s.getArtifact("p", "a"))!.version, 3);
    assert.equal((await s.getArtifact("p", "a", 2))!.version, 2);
    assert.equal(await s.getArtifact("p", "a", 99), null);
  });
});

describe("JobQueue — queue invariants", () => {
  test("FIFO", async () => {
    const q = new InMemoryJobQueue();
    await q.enqueue(payload("img_1"));
    await q.enqueue(payload("img_2"));
    assert.equal((await q.dequeue(500))!.jobId, "img_1");
    assert.equal((await q.dequeue(500))!.jobId, "img_2");
  });

  test("an empty queue makes dequeue return null after the timeout, NOT hang", async () => {
    // Important: the consumer loop must be able to check the stop flag
    // again, otherwise the pod only shuts down via SIGKILL.
    const q = new InMemoryJobQueue();
    const t0 = Date.now();
    assert.equal(await q.dequeue(100), null);
    assert.ok(Date.now() - t0 >= 90);
  });

  test("exceeding the cap throws RATE_LIMITED instead of queueing without limit", async () => {
    const q = new InMemoryJobQueue(2);
    await q.enqueue(payload("img_1"));
    await q.enqueue(payload("img_2"));
    await assert.rejects(
      () => q.enqueue(payload("img_3")),
      (e: unknown) => e instanceof ImagegenError && e.code === "RATE_LIMITED",
    );
  });

  test("an un-acked job stays in processing, and reapStale picks it back up", async () => {
    // This is what keeps a job from hanging at "running" forever when the
    // worker dies mid-job.
    const q = new InMemoryJobQueue();
    await q.enqueue(payload("img_1"));
    await q.dequeue(500);
    assert.deepEqual((await q.reapStale()).map((p) => p.jobId), ["img_1"]);
    assert.deepEqual(await q.reapStale(), [], "once picked up, it's not picked up again");
  });

  test("once acked, reapStale no longer sees it", async () => {
    const q = new InMemoryJobQueue();
    await q.enqueue(payload("img_1"));
    await q.dequeue(500);
    await q.ack("img_1");
    assert.deepEqual(await q.reapStale(), []);
  });

  test("the cancellation flag can be read back", async () => {
    const q = new InMemoryJobQueue();
    assert.equal(await q.isCancelled("img_1"), false);
    await q.requestCancel("img_1");
    assert.equal(await q.isCancelled("img_1"), true);
  });
});
