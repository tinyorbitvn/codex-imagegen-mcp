// The animate_image contract: names, bounds and the shape a client sees.
// Both roles import these, so a drift here breaks a job silently.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import {
  ANIMATION_MOTIONS,
  DEFAULT_ANIMATION_DURATION_MS,
  MAX_ANIMATION_DURATION_MS,
  MIN_ANIMATION_DURATION_MS,
  PUBLIC_TOOLS,
  animateImageSchema,
  clampAnimationDuration,
  jobToResult,
} from "../../src/contracts/index.ts";
import type { ArtifactRef, JobRecord } from "../../src/contracts/index.ts";

function completed(artifact: ArtifactRef): JobRecord {
  return {
    jobId: "img_1", status: "completed", projectId: "p", assetId: "a",
    version: artifact.version, parentVersion: artifact.parentVersion, principal: "x",
    createdAt: "2026-10-28T00:00:00.000Z", startedAt: null, completedAt: null,
    artifact, errorCode: null, errorMessage: null, traceId: null,
  };
}

const still: ArtifactRef = {
  projectId: "p", assetId: "a", version: 1, parentVersion: null,
  key: "projects/p/a/v1/artifact.png", url: "https://s3.example/v1/artifact.png",
  mimeType: "image/png", width: 1024, height: 1024, transparent: true,
  specHash: "h", createdAt: "2026-10-28T00:00:00.000Z",
};

test("every motion has a default duration inside the allowed range", () => {
  for (const m of ANIMATION_MOTIONS) {
    const d = DEFAULT_ANIMATION_DURATION_MS[m];
    assert.ok(d >= MIN_ANIMATION_DURATION_MS && d <= MAX_ANIMATION_DURATION_MS, m);
  }
});

test("duration is clamped to 400-4000 ms, not rejected", () => {
  assert.equal(clampAnimationDuration(50), 400);
  assert.equal(clampAnimationDuration(-5), 400);
  assert.equal(clampAnimationDuration(100_000), 4000);
  assert.equal(clampAnimationDuration(1234.6), 1235);
});

test("animate_image is one of the public tools", () => {
  assert.ok((PUBLIC_TOOLS as readonly string[]).includes("animate_image"));
});

test("the schema accepts a known motion and rejects an unknown one", () => {
  const s = z.object(animateImageSchema);
  assert.equal(s.safeParse({ project_id: "p", asset_id: "a", motion: "spin" }).success, true);
  assert.equal(s.safeParse({ project_id: "p", asset_id: "a", motion: "wiggle" }).success, false);
  assert.equal(s.safeParse({ project_id: "p", asset_id: "a" }).success, false, "motion is required");
});

test("jobToResult exposes the animation and the GIF url", () => {
  const r = jobToResult(
    completed({
      ...still, version: 2, parentVersion: 1,
      key: "projects/p/a/v2/animation.webp", url: "https://s3.example/v2/animation.webp",
      mimeType: "image/webp",
      animation: {
        motion: "spin", intensity: "medium", durationMs: 1200, frames: 29, fps: 24,
        gif: { key: "projects/p/a/v2/animation.gif", url: "https://s3.example/v2/animation.gif" },
      },
    }),
  ) as { artifact: Record<string, unknown> };
  assert.deepEqual(r.artifact.animation, {
    motion: "spin", intensity: "medium", duration_ms: 1200, frames: 29, fps: 24,
    gif_url: "https://s3.example/v2/animation.gif",
  });
});

test("a still artifact has no animation field in the result", () => {
  const r = jobToResult(completed(still)) as { artifact: Record<string, unknown> };
  assert.equal("animation" in r.artifact, false);
});
