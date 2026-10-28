# animate_image Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use sdd-orca:subagent-driven-development (recommended) or sdd-orca:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an MCP tool `animate_image` that turns a still artifact into a looping animated WebP plus a GIF fallback, using five motion presets and no Codex call.

**Architecture:** The MCP role validates input, picks the still source and enqueues a job of the new kind `"animate"` on the existing queue. In the worker, the consumer branches on that kind before any Codex code. It downloads the source, renders frames with sharp (pure geometry in `motion.ts`, pixels in `animate.ts`), uploads `animation.webp`, `animation.gif` and `metadata.json`, and completes the job. The artifact is a new version of the same asset, with an optional `animation` field.

**Tech Stack:** TypeScript on Node ≥ 22.6 (run with `--experimental-strip-types`), `node:test`, zod 3, `@modelcontextprotocol/sdk`, express, sharp 0.35.5 (new).

**Spec:** `docs/superpowers/specs/2026-10-28-animate-image-design.md`

## Global Constraints

- The repository is public: code, comments, test names and commit messages are in English, as Conventional Commits (`feat: …`, `docs: …`). No `Co-Authored-By` or other Claude footer in any commit.
- Match the surrounding style. Comments explain *why*; constants are named; the `#private` class fields and `ImagegenError(code, message)` follow the existing pattern.
- Verify with `npm test` (142 tests pass on `main` before this work) and `npm run typecheck`. Both must be clean after every task.
- New dependency: `sharp` `^0.35.5` only. No system packages in the Dockerfile.
- Motions: `spin | pulse | shake | bounce | float`. Intensities: `low | medium | high`, default `medium`.
- Default durations: spin 1200, pulse 1000, shake 800, bounce 900, float 2400 ms. `duration_ms` is clamped to 400–4000, never rejected.
- `fps` = 24. `frames = round(duration_ms / 1000 · 24)` clamped to 8–96. Frame delay is `round(1000 / 24)` = 42 ms.
- Amplitudes (low / medium / high):
  - pulse: scale 0.08 / 0.14 / 0.20;
  - shake: 6° / 10° / 15°;
  - bounce: 8% / 14% / 20% of height;
  - float: 3% / 5% / 8% of height.
- Long side of the downscaled source ≤ 512 px.
- Output keys are `projects/<project>/<asset>/v<n>/animation.webp`, `…/animation.gif` and `…/metadata.json`. Metadata `generator` is `"animate-preset"`.
- Error codes (no new codes):
  - missing source → `JOB_NOT_FOUND`;
  - animated source → `UNSUPPORTED_FORMAT`;
  - render failure → `IMAGE_GENERATION_FAILED`, with the sharp reason in the message.
- `animate_image` has no rate limit of its own. Known side effect: `countSince` counts every job a principal creates, so animate jobs still count toward the create/edit windows. The deployed limits are 0 (off), so this is left alone.
- Release: package and `VERSION` 0.7.0; chart `version` 0.3.0 and `appVersion` "0.7.0".
- GitOps repo (`~/Workspace/dc-fpt-argocd-platform`) rules:
  - commits in Vietnamese;
  - never commit `Chart.lock` or `charts/*.tgz`;
  - the two `image:` blocks in `custom-applications/imagegen-mcp/values.yaml` always share one tag.

## Review Focus

Inputs the spec implies but does not test directly, most likely to bite first. Each has a test in the task named.

1. **Opaque source.** A PNG with no alpha channel (from `create_image` with `transparent_background: false`) must animate onto a transparent canvas without crashing. The corners revealed while spinning are transparent. Task 3.
2. **Non-square source.** A 16:9 source (1536×864) is capped to 512 px on its long side, keeps its aspect ratio, and nothing is clipped. Task 3.
3. **Far-out-of-range `duration_ms`.** Values like 50 or 100000 are clamped to 400 / 4000, not rejected and not left as NaN. Tasks 1 and 5.
4. **Animate job cancelled while queued.** It is never rendered and its source is never downloaded. Task 4.
5. **Undecodable source bytes.** The job fails with `IMAGE_GENERATION_FAILED` and a message naming the renderer's reason, not the generic "check the logs" text. Tasks 3 and 4.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/contracts/animation.ts` | create | Motion/intensity names, defaults, bounds, `clampAnimationDuration`, `AnimationRequest`/`AnimationInfo` types. Shared by MCP and worker. |
| `src/contracts/index.ts` | modify | Re-export `animation.ts`. |
| `src/contracts/job.ts` | modify | `JobPayload.kind` gains `"animate"` and `animation?`; `ArtifactRef.animation?`; `jobToResult` exposes it. |
| `src/contracts/schemas.ts` | modify | `animateImageSchema`; `PUBLIC_TOOLS` gains `animate_image`. |
| `src/worker/motion.ts` | create | Pure per-frame geometry: `transformAt`, `frameTransforms`, `frameCount`, `canvasSize`. |
| `src/worker/animate.ts` | create | `renderAnimation(source, request)`: sharp frames → animated WebP + GIF. |
| `src/worker/consumer.ts` | modify | `kind === "animate"` branch and the `#animate` method. |
| `src/artifacts.ts` | modify | Serve `.gif` as `image/gif`. |
| `src/mcp/service.ts` | modify | `animateImage`, plus a shared `#stillSource` used by `editImage` too. |
| `src/mcp/server.ts` | modify | Register the `animate_image` tool. |
| `tests/contracts/animation.test.ts` | create | Contract tests. |
| `tests/worker/motion.test.ts` | create | Geometry tests. |
| `tests/worker/animate.test.ts` | create | Renderer tests on real pixels. |
| `tests/worker/consumer.test.ts` | modify | Animate branch tests. |
| `tests/artifacts.test.ts` | modify | `.gif` content type. |
| `tests/mcp/service.test.ts` | modify | Service tests. |
| `tests/mcp/server.test.ts` | create | `tools/list` over the real `/mcp` route. |
| `README.md`, `docs/architecture.md` | modify | Tool tables. |
| `package.json`, `package-lock.json`, `src/version.ts`, `charts/codex-imagegen-mcp/Chart.yaml` | modify | Dependency and version 0.7.0. |

---

### Task 1: Animation contracts

**Files:**
- Create: `src/contracts/animation.ts`
- Modify: `src/contracts/index.ts`, `src/contracts/job.ts`, `src/contracts/schemas.ts`
- Test: `tests/contracts/animation.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (exported from `src/contracts/index.ts`):
  - `ANIMATION_MOTIONS: readonly ["spin","pulse","shake","bounce","float"]`, `type AnimationMotion`
  - `ANIMATION_INTENSITIES: readonly ["low","medium","high"]`, `type AnimationIntensity`
  - `DEFAULT_ANIMATION_DURATION_MS: Record<AnimationMotion, number>`
  - `MIN_ANIMATION_DURATION_MS = 400`, `MAX_ANIMATION_DURATION_MS = 4000`, `ANIMATION_FPS = 24`
  - `clampAnimationDuration(ms: number): number`
  - `interface AnimationRequest { motion: AnimationMotion; intensity: AnimationIntensity; durationMs: number }`
  - `interface AnimationInfo extends AnimationRequest { frames: number; fps: number; gif: { key: string; url: string } }`
  - `JobPayload.kind: "create" | "edit" | "animate"`, `JobPayload.animation?: AnimationRequest`
  - `ArtifactRef.animation?: AnimationInfo`
  - `animateImageSchema` (zod shape), `PUBLIC_TOOLS` including `"animate_image"`
  - `jobToResult` adds `artifact.animation = { motion, intensity, duration_ms, frames, fps, gif_url }` when present.

- [ ] **Step 1: Write the failing test**

Create `tests/contracts/animation.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --experimental-strip-types --disable-warning=ExperimentalWarning tests/contracts/animation.test.ts`
Expected: FAIL, because the module `src/contracts/index.ts` does not export `ANIMATION_MOTIONS` (a SyntaxError on the import).

- [ ] **Step 3: Create `src/contracts/animation.ts`**

```ts
// Motion presets for animate_image.
//
// Shared because the MCP role fills in defaults and clamps while the
// worker renders: both have to agree on the names and the bounds, and a
// drift would show up as a broken job rather than a compile error.

export const ANIMATION_MOTIONS = ["spin", "pulse", "shake", "bounce", "float"] as const;
export type AnimationMotion = (typeof ANIMATION_MOTIONS)[number];

export const ANIMATION_INTENSITIES = ["low", "medium", "high"] as const;
export type AnimationIntensity = (typeof ANIMATION_INTENSITIES)[number];

/** One loop per motion, picked so each reads naturally without tuning. */
export const DEFAULT_ANIMATION_DURATION_MS: Record<AnimationMotion, number> = {
  spin: 1200,
  pulse: 1000,
  shake: 800,
  bounce: 900,
  float: 2400,
};

export const MIN_ANIMATION_DURATION_MS = 400;
export const MAX_ANIMATION_DURATION_MS = 4000;
export const ANIMATION_FPS = 24;

/**
 * Clamps rather than rejects: a loop a little outside the range is still
 * a clear request, and the upper bound is what keeps render time and file
 * size in check (96 frames at 4000 ms).
 */
export function clampAnimationDuration(ms: number): number {
  return Math.min(MAX_ANIMATION_DURATION_MS, Math.max(MIN_ANIMATION_DURATION_MS, Math.round(ms)));
}

/** What the caller asked for, after defaults and clamping. */
export interface AnimationRequest {
  motion: AnimationMotion;
  intensity: AnimationIntensity;
  durationMs: number;
}

/** What was actually rendered, stored on the artifact. */
export interface AnimationInfo extends AnimationRequest {
  frames: number;
  fps: number;
  /** The GIF fallback that sits next to the main animated WebP. */
  gif: { key: string; url: string };
}
```

- [ ] **Step 4: Re-export it**

In `src/contracts/index.ts`, add the line after `export * from "./errors.ts";`:

```ts
export * from "./animation.ts";
```

- [ ] **Step 5: Extend `src/contracts/job.ts`**

Replace the import line at the top:

```ts
import type { AspectRatio, OutputFormat } from "./schemas.ts";
```

with:

```ts
import type { AnimationInfo, AnimationRequest } from "./animation.ts";
import type { AspectRatio, OutputFormat } from "./schemas.ts";
```

In `JobPayload`, replace `kind: "create" | "edit";` with `kind: "create" | "edit" | "animate";`. Replace the `sourceKey` doc comment `/** S3 key of the source image, only present when kind="edit". */` with `/** S3 key of the source image, present when kind is "edit" or "animate". */`. Then add after the `instructions` field:

```ts
  /** Only present when kind="animate". */
  animation?: AnimationRequest;
```

In `ArtifactRef`, add after `createdAt: string;`:

```ts
  /**
   * Set only on animate_image output. edit_image and animate_image refuse
   * such a source: both work on a single still frame.
   */
  animation?: AnimationInfo;
```

In `jobToResult`, replace the whole `if (job.status === "completed" && job.artifact) { … }` block with:

```ts
  if (job.status === "completed" && job.artifact) {
    const a = job.artifact;
    const artifact: Record<string, unknown> = {
      project_id: a.projectId,
      asset_id: a.assetId,
      version: a.version,
      parent_version: a.parentVersion,
      url: a.url,
      mime_type: a.mimeType,
      width: a.width,
      height: a.height,
      transparent: a.transparent,
      created_at: a.createdAt,
    };
    if (a.animation) {
      artifact.animation = {
        motion: a.animation.motion,
        intensity: a.animation.intensity,
        duration_ms: a.animation.durationMs,
        frames: a.animation.frames,
        fps: a.animation.fps,
        gif_url: a.animation.gif.url,
      };
    }
    out.artifact = artifact;
  }
```

- [ ] **Step 6: Add the schema and the public tool in `src/contracts/schemas.ts`**

After `import { z } from "zod";` add:

```ts
import {
  ANIMATION_INTENSITIES,
  ANIMATION_MOTIONS,
  MAX_ANIMATION_DURATION_MS,
  MIN_ANIMATION_DURATION_MS,
} from "./animation.ts";
```

Change the `getImageJobSchema` description to `"job_id returned by create_image, edit_image or animate_image."`.

Directly after the closing `};` of `editImageSchema`, add:

```ts
export const animateImageSchema = {
  project_id: z.string(),
  asset_id: z.string(),
  source_version: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Still image to animate. Omit for the latest version."),
  motion: z
    .enum(ANIMATION_MOTIONS)
    .describe(
      "spin: one full turn. pulse: grow and shrink. shake: a damped wobble, " +
        "like a ringing bell. bounce: a hop with a squash on landing. " +
        "float: drift up and down.",
    ),
  duration_ms: z
    .number()
    .int()
    .optional()
    .describe(
      `One loop in milliseconds. Defaults per motion; clamped to ` +
        `${MIN_ANIMATION_DURATION_MS}-${MAX_ANIMATION_DURATION_MS}.`,
    ),
  intensity: z
    .enum(ANIMATION_INTENSITIES)
    .optional()
    .describe("How far the object moves. Defaults to medium."),
  wait: editImageSchema.wait,
  timeout_seconds: editImageSchema.timeout_seconds,
};
```

Replace the `PUBLIC_TOOLS` block with:

```ts
/** Names of the 6 tools Claude Design gets to see. */
export const PUBLIC_TOOLS = [
  "create_image",
  "edit_image",
  "animate_image",
  "get_image_job",
  "get_artifact",
  "cancel_image_job",
] as const;
```

- [ ] **Step 7: Run the tests and typecheck**

Run: `node --test --experimental-strip-types --disable-warning=ExperimentalWarning tests/contracts/animation.test.ts`
Expected: PASS, 6 tests.

Run: `npm test 2>&1 | grep -E '^# (pass|fail)'; npm run typecheck`
Expected: `# fail 0`; typecheck prints nothing and exits 0. If any existing test asserted 5 public tools, update that assertion to 6 and say so in the commit body.

- [ ] **Step 8: Commit**

```bash
git add src/contracts tests/contracts/animation.test.ts
git commit -m "feat: add the animate_image contract"
```

---

### Task 2: Motion geometry

**Files:**
- Create: `src/worker/motion.ts`
- Test: `tests/worker/motion.test.ts`

**Interfaces:**
- Consumes: `ANIMATION_FPS`, `AnimationMotion`, `AnimationIntensity` from `src/contracts/index.ts` (Task 1).
- Produces:
  - `interface FrameTransform { angleDeg: number; scaleX: number; scaleY: number; dx: number; dy: number }`. Here `dx`/`dy` are fractions of the source **height**, and negative `dy` means up.
  - `transformAt(motion: AnimationMotion, intensity: AnimationIntensity, t: number): FrameTransform`, for `t` in [0, 1]; `t = 1` equals `t = 0`.
  - `frameCount(durationMs: number): number`, which is `round(durationMs · 24 / 1000)` clamped to 8–96.
  - `frameTransforms(motion, intensity, frames: number): FrameTransform[]`, sampled at `i / frames`.
  - `canvasSize(width: number, height: number, frames: readonly FrameTransform[]): { width: number; height: number }`.

- [ ] **Step 1: Write the failing test**

Create `tests/worker/motion.test.ts`:

```ts
// The shape of every motion, checked without rendering a single pixel.
// A loop that does not close shows as a visible jump once per cycle.

import { test } from "node:test";
import assert from "node:assert/strict";

import { ANIMATION_INTENSITIES, ANIMATION_MOTIONS } from "../../src/contracts/index.ts";
import type { AnimationMotion } from "../../src/contracts/index.ts";
import { canvasSize, frameCount, frameTransforms, transformAt } from "../../src/worker/motion.ts";
import type { FrameTransform } from "../../src/worker/motion.ts";

const EPS = 1e-9;
const near = (a: number, b: number) => Math.abs(a - b) < EPS;
/** Angle difference on the circle, so 360° and -1e-15° both count as 0°. */
const angleDiff = (a: number, b: number) => Math.abs(((((b - a) % 360) + 540) % 360) - 180);

function peak(motion: AnimationMotion, f: FrameTransform): number {
  switch (motion) {
    case "pulse": return f.scaleX - 1;
    case "shake": return Math.abs(f.angleDeg);
    case "bounce": return -f.dy;
    case "float": return Math.abs(f.dy);
    default: return 0;
  }
}

test("spin, pulse, shake and float start at the resting pose", () => {
  for (const m of ["spin", "pulse", "shake", "float"] as const) {
    const f = transformAt(m, "medium", 0);
    assert.ok(near(f.angleDeg, 0) && near(f.scaleX, 1) && near(f.scaleY, 1), m);
    assert.ok(near(f.dx, 0) && near(f.dy, 0), m);
  }
});

test("bounce starts on the ground, squashed, with its base pinned", () => {
  const f = transformAt("bounce", "medium", 0);
  assert.ok(f.scaleY < 1 && f.scaleX > 1, "squashed on landing");
  assert.ok(near(f.dy, (1 - f.scaleY) / 2), "shifted down by half the lost height");
  assert.equal(f.angleDeg, 0);
  const apex = transformAt("bounce", "medium", 0.5);
  assert.ok(near(apex.dy, -0.14) && near(apex.scaleY, 1), "apex is 14% up, unsquashed");
});

test("every motion closes its loop at every intensity", () => {
  for (const m of ANIMATION_MOTIONS) {
    for (const i of ANIMATION_INTENSITIES) {
      const a = transformAt(m, i, 0);
      const b = transformAt(m, i, 1);
      assert.ok(angleDiff(a.angleDeg, b.angleDeg) < EPS, `${m}/${i} angle`);
      assert.ok(near(a.scaleX, b.scaleX) && near(a.scaleY, b.scaleY), `${m}/${i} scale`);
      assert.ok(near(a.dx, b.dx) && near(a.dy, b.dy), `${m}/${i} offset`);
    }
  }
});

test("peak amplitude grows from low to high", () => {
  for (const m of ["pulse", "shake", "bounce", "float"] as const) {
    const peaks = ANIMATION_INTENSITIES.map((i) =>
      Math.max(...frameTransforms(m, i, 96).map((f) => peak(m, f))),
    );
    assert.ok(peaks[0]! < peaks[1]! && peaks[1]! < peaks[2]!, `${m}: ${peaks.join(" < ")}`);
  }
});

test("spin covers a full turn in even steps", () => {
  const fs = frameTransforms("spin", "medium", 24);
  assert.equal(fs.length, 24);
  fs.forEach((f, i) => assert.ok(near(f.angleDeg, i * 15), `frame ${i}`));
});

test("frameCount follows 24 fps and stays within 8-96", () => {
  assert.equal(frameCount(1000), 24);
  assert.equal(frameCount(1200), 29);
  assert.equal(frameCount(100), 8);
  assert.equal(frameCount(10_000), 96);
});

test("canvasSize fits a square spun to 45 degrees", () => {
  const c = canvasSize(100, 100, [transformAt("spin", "medium", 0.125)]);
  assert.ok(c.width >= Math.ceil(100 * Math.SQRT2), `width ${c.width}`);
  assert.ok(c.height >= Math.ceil(100 * Math.SQRT2), `height ${c.height}`);
});

test("canvasSize leaves room for vertical travel and nothing more sideways", () => {
  const c = canvasSize(100, 100, frameTransforms("float", "high", 48));
  assert.ok(c.height >= 100 + 2 * 8, `height ${c.height}`);
  assert.ok(c.width < c.height);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --experimental-strip-types --disable-warning=ExperimentalWarning tests/worker/motion.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/worker/motion.ts`.

- [ ] **Step 3: Create `src/worker/motion.ts`**

```ts
// Per-frame geometry for animate_image's motion presets.
//
// Pure math with no images, so the shape of every motion is tested on
// its own and the renderer only has to apply what it is given. Every
// curve is closed over t in [0, 1]: t = 1 lands exactly on t = 0, which
// is what makes the loop seamless.

import { ANIMATION_FPS } from "../contracts/index.ts";
import type { AnimationIntensity, AnimationMotion } from "../contracts/index.ts";

/** One frame. dx/dy are fractions of the source height; negative dy is up. */
export interface FrameTransform {
  angleDeg: number;
  scaleX: number;
  scaleY: number;
  dx: number;
  dy: number;
}

const AMPLITUDE: Record<Exclude<AnimationMotion, "spin">, Record<AnimationIntensity, number>> = {
  pulse: { low: 0.08, medium: 0.14, high: 0.2 },
  shake: { low: 6, medium: 10, high: 15 },
  bounce: { low: 0.08, medium: 0.14, high: 0.2 },
  float: { low: 0.03, medium: 0.05, high: 0.08 },
};

/** Fraction of the hop height below which the object squashes; full squash at the ground. */
const SQUASH_ZONE = 0.15;
const SQUASH_Y = 0.08;
const STRETCH_X = 0.06;

const MIN_FRAMES = 8;
const MAX_FRAMES = 96;
/** sharp rounds rotated sizes up, so the canvas keeps a few spare pixels. */
const CANVAS_MARGIN = 4;

const REST: FrameTransform = { angleDeg: 0, scaleX: 1, scaleY: 1, dx: 0, dy: 0 };

export function transformAt(
  motion: AnimationMotion,
  intensity: AnimationIntensity,
  t: number,
): FrameTransform {
  switch (motion) {
    case "spin":
      return { ...REST, angleDeg: 360 * t };
    case "pulse": {
      const s = 1 + (AMPLITUDE.pulse[intensity] * (1 - Math.cos(2 * Math.PI * t))) / 2;
      return { ...REST, scaleX: s, scaleY: s };
    }
    case "shake":
      // Three swings that die out, so the bell rests at 0° before it rings again.
      return {
        ...REST,
        angleDeg: AMPLITUDE.shake[intensity] * Math.sin(6 * Math.PI * t) * Math.exp(-3 * t),
      };
    case "bounce": {
      const h = Math.abs(Math.sin(Math.PI * t));
      const q = h < SQUASH_ZONE ? 1 - h / SQUASH_ZONE : 0;
      const scaleY = 1 - SQUASH_Y * q;
      return {
        angleDeg: 0,
        scaleX: 1 + STRETCH_X * q,
        scaleY,
        dx: 0,
        // Down by half the lost height keeps the base on the ground while squashed.
        dy: -AMPLITUDE.bounce[intensity] * h + (1 - scaleY) / 2,
      };
    }
    case "float":
      return { ...REST, dy: -AMPLITUDE.float[intensity] * Math.sin(2 * Math.PI * t) };
    default:
      throw new Error(`unknown motion: ${String(motion)}`);
  }
}

export function frameCount(durationMs: number): number {
  return Math.min(MAX_FRAMES, Math.max(MIN_FRAMES, Math.round((durationMs / 1000) * ANIMATION_FPS)));
}

export function frameTransforms(
  motion: AnimationMotion,
  intensity: AnimationIntensity,
  frames: number,
): FrameTransform[] {
  return Array.from({ length: frames }, (_, i) => transformAt(motion, intensity, i / frames));
}

/**
 * The smallest canvas that holds every frame drawn about its centre.
 * Derived from the transforms rather than per motion, so a spin gets its
 * diagonal and a float its travel without either being special-cased.
 */
export function canvasSize(
  width: number,
  height: number,
  frames: readonly FrameTransform[],
): { width: number; height: number } {
  let w = 0;
  let h = 0;
  for (const f of frames) {
    const sw = width * f.scaleX;
    const sh = height * f.scaleY;
    const a = (f.angleDeg * Math.PI) / 180;
    const cos = Math.abs(Math.cos(a));
    const sin = Math.abs(Math.sin(a));
    w = Math.max(w, sw * cos + sh * sin + 2 * Math.abs(f.dx * height));
    h = Math.max(h, sw * sin + sh * cos + 2 * Math.abs(f.dy * height));
  }
  return { width: Math.ceil(w) + CANVAS_MARGIN, height: Math.ceil(h) + CANVAS_MARGIN };
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `node --test --experimental-strip-types --disable-warning=ExperimentalWarning tests/worker/motion.test.ts`
Expected: PASS, 8 tests.

Run: `npm run typecheck`
Expected: exit 0. If TypeScript flags `default:` as unreachable, keep it; it is the guard against a payload that never went through zod.

- [ ] **Step 5: Commit**

```bash
git add src/worker/motion.ts tests/worker/motion.test.ts
git commit -m "feat: add closed-loop geometry for the five motion presets"
```

---

### Task 3: Renderer

**Files:**
- Modify: `package.json`, `package-lock.json` (via npm)
- Create: `src/worker/animate.ts`
- Test: `tests/worker/animate.test.ts`

**Interfaces:**
- Consumes:
  - `frameCount`, `frameTransforms`, `canvasSize`, `FrameTransform` from `src/worker/motion.ts` (Task 2);
  - `ANIMATION_FPS`, `ImagegenError`, `AnimationRequest` from contracts (Task 1).
- Produces:
  - `MAX_ANIMATION_SIDE = 512`;
  - `interface RenderedAnimation { webp: Buffer; gif: Buffer; width: number; height: number; frames: number; fps: number }`;
  - `renderAnimation(source: Buffer, request: AnimationRequest): Promise<RenderedAnimation>`. Any failure throws `ImagegenError("IMAGE_GENERATION_FAILED", "Could not render the animation: <sharp message>")`.

- [ ] **Step 1: Add sharp**

Run: `npm install sharp@^0.35.5`
Expected: `package.json` `dependencies` gains `"sharp": "^0.35.5"`, and `package-lock.json` changes. Check with `git diff --stat`. If npm also rewrites the stale `"version": "0.5.0"` at the top of the lockfile, keep that change.

- [ ] **Step 2: Write the failing test**

Create `tests/worker/animate.test.ts`:

```ts
// The renderer on real pixels: frame count, looping, alpha, and that a
// moving object never leaves the canvas.

import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";

import { ImagegenError } from "../../src/contracts/index.ts";
import { MAX_ANIMATION_SIDE, renderAnimation } from "../../src/worker/animate.ts";

function solid(width: number, height: number, alpha = true): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: alpha ? 4 : 3,
      background: alpha ? { r: 230, g: 60, b: 40, alpha: 1 } : { r: 230, g: 60, b: 40 },
    },
  })
    .png()
    .toBuffer();
}

/** Bounding box of every pixel with any opacity, on one page of an animation. */
async function alphaBox(buf: Buffer, page: number) {
  const { data, info } = await sharp(buf, { page }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width, minY = info.height, maxX = -1, maxY = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3]! > 0) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
  }
  return { minX, minY, maxX, maxY, width: info.width, height: info.height, data };
}

test("WebP and GIF both carry every frame and loop forever", async () => {
  const out = await renderAnimation(await solid(64, 64), { motion: "pulse", intensity: "medium", durationMs: 500 });
  assert.equal(out.frames, 12);
  assert.equal(out.fps, 24);
  for (const [format, buf] of [["webp", out.webp], ["gif", out.gif]] as const) {
    const m = await sharp(buf, { animated: true }).metadata();
    assert.equal(m.format, format);
    assert.equal(m.pages, out.frames, `${format} pages`);
    assert.equal(m.loop, 0, `${format} loops forever`);
    assert.equal(m.width, out.width);
    assert.equal(m.pageHeight, out.height);
  }
});

test("the WebP keeps an alpha channel", async () => {
  const out = await renderAnimation(await solid(64, 64), { motion: "float", intensity: "low", durationMs: 400 });
  assert.equal((await sharp(out.webp, { animated: true }).metadata()).hasAlpha, true);
});

test("a square spun to 45 degrees stays fully on the canvas", async () => {
  // 667 ms -> 16 frames, so page 2 is the 45° pose: the widest a square gets.
  const out = await renderAnimation(await solid(100, 100), { motion: "spin", intensity: "medium", durationMs: 667 });
  assert.equal(out.frames, 16);
  const b = await alphaBox(out.webp, 2);
  assert.ok(b.minX > 0 && b.minY > 0, `touches the top/left edge: ${JSON.stringify(b)}`);
  assert.ok(b.maxX < b.width - 1 && b.maxY < b.height - 1, "touches the bottom/right edge");
  assert.ok(b.maxX - b.minX + 1 >= 100 * Math.SQRT2 - 4, "the corners are really there");
});

test("an opaque source still animates on a transparent canvas", async () => {
  const out = await renderAnimation(await solid(64, 64, false), { motion: "spin", intensity: "medium", durationMs: 667 });
  const b = await alphaBox(out.webp, 2);
  assert.equal(b.data[3], 0, "the corner of the canvas is transparent");
});

test("a wide source is capped at 512 px on its long side and keeps its aspect", async () => {
  const out = await renderAnimation(await solid(1536, 864), { motion: "float", intensity: "medium", durationMs: 400 });
  const b = await alphaBox(out.webp, 0);
  const objectWidth = b.maxX - b.minX + 1;
  const objectHeight = b.maxY - b.minY + 1;
  assert.ok(Math.abs(objectWidth - MAX_ANIMATION_SIDE) <= 1, `width ${objectWidth}`);
  assert.ok(Math.abs(objectHeight - 288) <= 1, `height ${objectHeight}`);
  assert.ok(out.width <= MAX_ANIMATION_SIDE + 8);
});

test("bytes that are not an image fail with the renderer's reason", async () => {
  await assert.rejects(
    () => renderAnimation(Buffer.from("not an image"), { motion: "spin", intensity: "medium", durationMs: 1200 }),
    (e: unknown) =>
      e instanceof ImagegenError &&
      e.code === "IMAGE_GENERATION_FAILED" &&
      /^Could not render the animation: .+/.test(e.message),
  );
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test --experimental-strip-types --disable-warning=ExperimentalWarning tests/worker/animate.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/worker/animate.ts`.

- [ ] **Step 4: Create `src/worker/animate.ts`**

```ts
// Renders animate_image's output: the still, transformed frame by frame
// with sharp, encoded as an animated WebP plus a GIF fallback.
//
// No Codex here, so an animation spends no ChatGPT quota. The long side
// is capped at 512 px because file size and encode time grow with every
// frame: measured 2026-10-28 on 2 CPUs, 96 frames at 512 px take ~14 s,
// three quarters of it in the WebP encoder.

import sharp from "sharp";
import { ANIMATION_FPS, ImagegenError } from "../contracts/index.ts";
import type { AnimationRequest } from "../contracts/index.ts";
import { canvasSize, frameCount, frameTransforms } from "./motion.ts";
import type { FrameTransform } from "./motion.ts";

export const MAX_ANIMATION_SIDE = 512;

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

export interface RenderedAnimation {
  webp: Buffer;
  gif: Buffer;
  width: number;
  height: number;
  frames: number;
  fps: number;
}

interface RawImage {
  data: Buffer;
  width: number;
  height: number;
}

export async function renderAnimation(
  source: Buffer,
  request: AnimationRequest,
): Promise<RenderedAnimation> {
  try {
    return await render(source, request);
  } catch (err) {
    // sharp's messages describe the image, never a credential, so they are
    // safe to hand back and far more useful than "check the logs".
    throw new ImagegenError(
      "IMAGE_GENERATION_FAILED",
      `Could not render the animation: ${(err as Error).message}`,
    );
  }
}

async function render(source: Buffer, request: AnimationRequest): Promise<RenderedAnimation> {
  const base = await toRaw(
    sharp(source)
      .ensureAlpha()
      .resize({
        width: MAX_ANIMATION_SIDE,
        height: MAX_ANIMATION_SIDE,
        fit: "inside",
        withoutEnlargement: true,
      }),
  );

  const frames = frameCount(request.durationMs);
  const transforms = frameTransforms(request.motion, request.intensity, frames);
  const canvas = canvasSize(base.width, base.height, transforms);
  const frameBytes = canvas.width * canvas.height * 4;

  // sharp encodes one tall strip as pages; filling it in place avoids
  // holding a second copy of every frame (~200 MB at 96 frames).
  const strip = Buffer.alloc(frameBytes * frames);
  await Promise.all(
    transforms.map(async (t, i) => {
      const frame = await renderFrame(base, t, canvas);
      frame.copy(strip, i * frameBytes);
    }),
  );

  const delay = new Array<number>(frames).fill(Math.round(1000 / ANIMATION_FPS));
  const pages = () =>
    sharp(strip, {
      raw: { width: canvas.width, height: canvas.height * frames, channels: 4, pageHeight: canvas.height },
    });
  const [webp, gif] = await Promise.all([
    pages().webp({ loop: 0, delay }).toBuffer(),
    pages().gif({ loop: 0, delay }).toBuffer(),
  ]);

  return { webp, gif, width: canvas.width, height: canvas.height, frames, fps: ANIMATION_FPS };
}

async function renderFrame(
  base: RawImage,
  t: FrameTransform,
  canvas: { width: number; height: number },
): Promise<Buffer> {
  let img = base;
  const w = Math.max(1, Math.round(base.width * t.scaleX));
  const h = Math.max(1, Math.round(base.height * t.scaleY));
  // Two passes, so the rotation always works on the already-scaled size.
  if (w !== base.width || h !== base.height) {
    img = await toRaw(sharp(img.data, { raw: rawOf(img) }).resize(w, h, { fit: "fill" }));
  }
  if (Math.abs(t.angleDeg % 360) > 1e-6) {
    img = await toRaw(sharp(img.data, { raw: rawOf(img) }).rotate(t.angleDeg, { background: TRANSPARENT }));
  }

  const left = Math.round(canvas.width / 2 + t.dx * base.height - img.width / 2);
  const top = Math.round(canvas.height / 2 + t.dy * base.height - img.height / 2);
  return sharp({
    create: { width: canvas.width, height: canvas.height, channels: 4, background: TRANSPARENT },
  })
    .composite([
      {
        input: img.data,
        raw: rawOf(img),
        left: clamp(left, 0, canvas.width - img.width),
        top: clamp(top, 0, canvas.height - img.height),
      },
    ])
    .raw()
    .toBuffer();
}

function rawOf(img: RawImage) {
  return { width: img.width, height: img.height, channels: 4 as const };
}

async function toRaw(pipeline: sharp.Sharp): Promise<RawImage> {
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `node --test --experimental-strip-types --disable-warning=ExperimentalWarning tests/worker/animate.test.ts`
Expected: PASS, 6 tests.

Run: `npm run typecheck`
Expected: exit 0.
- If `import sharp from "sharp"` fails to typecheck under `NodeNext`, use `import sharp = require("sharp")`. That form does not work under strip-types, so prefer `import sharp from "sharp"` and add `"esModuleInterop": true` to `tsconfig.json` only if TypeScript asks for it.
- If `sharp.Sharp` is not found as a type, import it with `import type { Sharp } from "sharp"`.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/worker/animate.ts tests/worker/animate.test.ts
git commit -m "feat: render looping WebP and GIF animations with sharp"
```

---

### Task 4: Worker branch and GIF serving

**Files:**
- Modify: `src/worker/consumer.ts` (inside `#handle`, right after `await mkdir(jobDir, …)`; plus a new method after `#handle`), `src/artifacts.ts` (`CONTENT_TYPES`)
- Test: `tests/worker/consumer.test.ts` (append a describe block), `tests/artifacts.test.ts` (one setup line plus one test)

**Interfaces:**
- Consumes:
  - `renderAnimation` from `src/worker/animate.ts` (Task 3);
  - `JobPayload.animation`, `ArtifactRef.animation` from Task 1;
  - the existing `artifactKey`, `specHash` (`src/worker/prompt.ts`, `specHash(prompt: string): string`) and `metrics.uploaded(seconds)`.
- Produces: a completed job whose artifact has:
  - `key` = `projects/<p>/<a>/v<n>/animation.webp`, `mimeType` `image/webp`, `transparent: true`;
  - `animation.gif.key` = `…/animation.gif`;
  - metadata at `…/metadata.json` with `generator: "animate-preset"`.

- [ ] **Step 1: Write the failing consumer tests**

In `tests/worker/consumer.test.ts`, add `import sharp from "sharp";` after the `node:path` import. Then append at the end of the file:

```ts
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
```

- [ ] **Step 2: Write the failing route test**

In `tests/artifacts.test.ts`, in `before`, after the `notes.bin` `writeFile` line, add:

```ts
  await writeFile(join(root, "projects/tinyorbit-cloud/hero/v1/animation.gif"), "GIF89a");
```

Inside `describe("GET /artifacts", …)`, after the first test, add:

```ts
  test("serves the GIF fallback of an animation as image/gif", async () => {
    const res = await fetch(`${base}/artifacts/projects/tinyorbit-cloud/hero/v1/animation.gif`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/gif");
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test --experimental-strip-types --disable-warning=ExperimentalWarning tests/worker/consumer.test.ts tests/artifacts.test.ts 2>&1 | grep -E '^not ok|# (pass|fail)'`
Expected:
- the first two animate tests fail: the consumer runs the Codex path, and the stub throws "Codex must not run";
- the cancel test may already pass;
- the GIF test fails with `application/octet-stream`.

- [ ] **Step 4: Serve `.gif`**

In `src/artifacts.ts`, add to `CONTENT_TYPES`, after the `.webp` line:

```ts
  ".gif": "image/gif",
```

Change the sentence `this directory only ever holds what the worker uploads, which is one image plus metadata.json.` in the comment above it to `this directory only ever holds what the worker uploads: one image (or an animation and its GIF fallback) plus metadata.json.`

- [ ] **Step 5: Branch in the consumer**

In `src/worker/consumer.ts`:

1. Add `import { renderAnimation } from "./animate.ts";` after the `readImageInfo` import.
2. In `#handle`, directly after `await mkdir(jobDir, { recursive: true, mode: 0o700 });`, insert:

```ts
      // animate_image never reaches Codex: no quota, no prompt, no salvage.
      if (payload.kind === "animate") {
        const done = await this.#animate(payload, jobDir);
        uploadMs = done.uploadMs;
        await this.#store.markCompleted(jobId, done.artifact);
        ok = true;
        return;
      }

```

(The `return` runs the existing `finally`, which removes the job directory, acks the queue and logs "job finished".)

3. Add this method directly after the closing brace of `#handle`:

```ts
  /**
   * Renders an animate_image job from a still the worker made earlier.
   * The service has already refused animated sources, so the source is a
   * single frame.
   */
  async #animate(
    payload: JobPayload,
    jobDir: string,
  ): Promise<{ artifact: ArtifactRef; uploadMs: number }> {
    const { spec, version } = payload;
    const request = payload.animation!;
    const source = await this.#storage.download(payload.sourceKey!);
    const out = await renderAnimation(source, request);

    const webpPath = join(jobDir, "animation.webp");
    const gifPath = join(jobDir, "animation.gif");
    await writeFile(webpPath, out.webp, { mode: 0o600 });
    await writeFile(gifPath, out.gif, { mode: 0o600 });

    const key = artifactKey(spec.projectId, spec.assetId, version, "animation.webp");
    const gifKey = artifactKey(spec.projectId, spec.assetId, version, "animation.gif");
    const webpUpload = await this.#storage.uploadArtifact(webpPath, key, "image/webp");
    const gifUpload = await this.#storage.uploadArtifact(gifPath, gifKey, "image/gif");
    const uploadMs = webpUpload.durationMs + gifUpload.durationMs;
    metrics.uploaded(uploadMs / 1000);

    const artifact: ArtifactRef = {
      projectId: spec.projectId,
      assetId: spec.assetId,
      version,
      parentVersion: payload.parentVersion,
      key,
      url: webpUpload.url,
      mimeType: "image/webp",
      width: out.width,
      height: out.height,
      // The canvas is transparent whatever the source was.
      transparent: true,
      specHash: specHash(JSON.stringify(request)),
      createdAt: new Date().toISOString(),
      animation: { ...request, frames: out.frames, fps: out.fps, gif: { key: gifKey, url: gifUpload.url } },
    };

    await this.#storage.uploadMetadata(
      artifactKey(spec.projectId, spec.assetId, version, "metadata.json"),
      {
        project_id: artifact.projectId,
        asset_id: artifact.assetId,
        version: artifact.version,
        parent_version: artifact.parentVersion,
        job_id: payload.jobId,
        content_type: artifact.mimeType,
        width: artifact.width,
        height: artifact.height,
        transparent: artifact.transparent,
        animation: {
          motion: request.motion,
          intensity: request.intensity,
          duration_ms: request.durationMs,
          frames: out.frames,
          fps: out.fps,
          gif_key: gifKey,
        },
        spec_hash: artifact.specHash,
        generator: "animate-preset",
        created_at: artifact.createdAt,
      },
    );

    return { artifact, uploadMs };
  }
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `node --test --experimental-strip-types --disable-warning=ExperimentalWarning tests/worker/consumer.test.ts tests/artifacts.test.ts 2>&1 | grep -E '^not ok|# (pass|fail)'`
Expected: `# fail 0`.

Run: `npm test 2>&1 | grep -E '^# (pass|fail)'; npm run typecheck`
Expected: `# fail 0`; typecheck exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/worker/consumer.ts src/artifacts.ts tests/worker/consumer.test.ts tests/artifacts.test.ts
git commit -m "feat: let the worker render animate jobs without Codex"
```

---

### Task 5: Service and MCP tool

**Files:**
- Modify: `src/mcp/service.ts` (`editImage`, a new `#stillSource`, a new `animateImage`), `src/mcp/server.ts` (imports; tool registration after `edit_image`)
- Test: `tests/mcp/service.test.ts` (change the helper; add a describe block); create `tests/mcp/server.test.ts`

**Interfaces:**
- Consumes:
  - `animateImageSchema`, `clampAnimationDuration`, `DEFAULT_ANIMATION_DURATION_MS`, `AnimationMotion`, `AnimationIntensity`, `ArtifactRef`, `PUBLIC_TOOLS`, `ANIMATION_MOTIONS` from Task 1.
- Produces:
  - `ImagegenService.animateImage(raw: Record<string, unknown>, principal: string): Promise<JobHandle>`. It enqueues `{ kind: "animate", version: highestAllocated + 1, parentVersion: src.version, sourceKey: src.key, instructions: null, animation: { motion, intensity, durationMs } }`.
  - The MCP tool `animate_image`.
  - `editImage` now rejects an animated source with `UNSUPPORTED_FORMAT`.

- [ ] **Step 1: Write the failing service tests**

In `tests/mcp/service.test.ts`, give `completePayload` an optional `extra` parameter. Change its signature to:

```ts
async function completePayload(
  payload: JobPayload,
  store: InMemoryJobStore,
  queue: InMemoryJobQueue,
  extra: Partial<ArtifactRef> = {},
): Promise<ArtifactRef> {
```

and add `...extra,` as the last property of the `artifact` object literal, after `createdAt: new Date().toISOString(),`.

Append at the end of the file:

```ts
describe("animate_image", () => {
  async function withStill() {
    const b = build();
    await b.service.createImage({ project_id: "p", asset_id: "a", description: "a bell" }, "claude-design");
    await completeNextJob(b.queue, b.store);
    return b;
  }

  test("queues an animate job on a new version, pointing at the still", async () => {
    const { service, queue } = await withStill();
    const r = await service.animateImage({ project_id: "p", asset_id: "a", motion: "spin" }, "claude-design");
    assert.match(r.job_id, /^img_[0-9a-f]{32}$/);
    const payload = (await queue.dequeue(1000))!;
    assert.equal(payload.kind, "animate");
    assert.equal(payload.version, 2);
    assert.equal(payload.parentVersion, 1);
    assert.match(payload.sourceKey!, /\/v1\//);
    assert.equal(payload.spec.filename, "animation.webp");
    assert.deepEqual(payload.animation, { motion: "spin", intensity: "medium", durationMs: 1200 });
  });

  test("duration_ms outside 400-4000 is clamped, not rejected", async () => {
    const { service, queue } = await withStill();
    await service.animateImage({ project_id: "p", asset_id: "a", motion: "pulse", duration_ms: 50 }, "x");
    assert.equal((await queue.dequeue(1000))!.animation!.durationMs, 400);
    await service.animateImage({ project_id: "p", asset_id: "a", motion: "pulse", duration_ms: 100_000 }, "x");
    assert.equal((await queue.dequeue(1000))!.animation!.durationMs, 4000);
  });

  test("an animated source is refused by name, for animate and edit alike", async () => {
    const { service, store, queue } = await withStill();
    await service.animateImage({ project_id: "p", asset_id: "a", motion: "spin" }, "x");
    await completePayload((await queue.dequeue(1000))!, store, queue, {
      mimeType: "image/webp",
      animation: {
        motion: "spin", intensity: "medium", durationMs: 1200, frames: 29, fps: 24,
        gif: { key: "projects/p/a/v2/animation.gif", url: "https://s3.example/v2/animation.gif" },
      },
    });

    const refused = (e: unknown) =>
      e instanceof ImagegenError && e.code === "UNSUPPORTED_FORMAT" && /version 2/.test(e.message);
    await assert.rejects(() => service.animateImage({ project_id: "p", asset_id: "a", motion: "pulse" }, "x"), refused);
    await assert.rejects(() => service.editImage({ project_id: "p", asset_id: "a", instructions: "x" }, "x"), refused);

    // The still underneath is still fair game.
    await service.animateImage({ project_id: "p", asset_id: "a", motion: "pulse", source_version: 1 }, "x");
    assert.equal((await queue.dequeue(1000))!.parentVersion, 1);
  });

  test("animating a missing asset reports JOB_NOT_FOUND", async () => {
    const { service } = build();
    await assert.rejects(
      () => service.animateImage({ project_id: "p", asset_id: "missing", motion: "spin" }, "x"),
      (e: unknown) => e instanceof ImagegenError && e.code === "JOB_NOT_FOUND",
    );
  });
});
```

- [ ] **Step 2: Write the failing server test**

Create `tests/mcp/server.test.ts`:

```ts
// tools/list over the real /mcp route: the tool names and schemas a client
// (and the gateway's allowlist) actually sees. A tool that is coded but
// not registered only shows up here.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { ANIMATION_MOTIONS, PUBLIC_TOOLS } from "../../src/contracts/index.ts";
import { InMemoryJobQueue, InMemoryJobStore } from "../../src/queue/index.ts";
import { ImagegenService } from "../../src/mcp/service.ts";
import { mountMcp } from "../../src/mcp/server.ts";

interface ListedTool {
  name: string;
  inputSchema: { properties: Record<string, { enum?: string[] }>; required?: string[] };
}

let server: Server;
let base: string;

before(async () => {
  const app = express();
  const service = new ImagegenService({
    store: new InMemoryJobStore(),
    queue: new InMemoryJobQueue(),
    config: { rateLimit: { createImagePerHour: 0, editImagePerHour: 0 } },
  });
  mountMcp(app, { service });
  server = app.listen(0);
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

async function listTools(): Promise<ListedTool[]> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(res.status, 200);
  // Stateless Streamable HTTP answers as one SSE event.
  const data = (await res.text()).split("\n").find((l) => l.startsWith("data: "));
  assert.ok(data, "an SSE data line");
  return JSON.parse(data.slice("data: ".length)).result.tools as ListedTool[];
}

test("tools/list exposes exactly the public tools", async () => {
  const names = (await listTools()).map((t) => t.name).sort();
  assert.deepEqual(names, [...PUBLIC_TOOLS].sort());
});

test("animate_image requires motion and lists the five presets", async () => {
  const tool = (await listTools()).find((t) => t.name === "animate_image");
  assert.ok(tool, "animate_image is registered");
  for (const field of ["project_id", "asset_id", "motion"]) {
    assert.ok(tool.inputSchema.required?.includes(field), `${field} is required`);
  }
  assert.deepEqual(tool.inputSchema.properties.motion?.enum, [...ANIMATION_MOTIONS]);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test --experimental-strip-types --disable-warning=ExperimentalWarning tests/mcp/service.test.ts tests/mcp/server.test.ts 2>&1 | grep -E '^not ok|# (pass|fail)'`
Expected:
- the animate tests fail with `service.animateImage is not a function`;
- the edit refusal is not raised yet;
- the server tests fail because `animate_image` is not listed.

- [ ] **Step 4: Add `#stillSource` and `animateImage` to `src/mcp/service.ts`**

Extend the value import from `"../contracts/index.ts"` with `DEFAULT_ANIMATION_DURATION_MS` and `clampAnimationDuration`. Extend the type import with `AnimationIntensity`, `AnimationMotion` and `ArtifactRef`.

In `editImage`, replace from `const source = await this.#store.getArtifact(projectId, assetId, sourceVersion);` through `const src = source.artifact;` with:

```ts
    const src = await this.#stillSource(projectId, assetId, sourceVersion);
```

After the closing brace of `editImage`, add:

```ts
  // ---------------------------------------------------------------
  // animate_image — motion presets on a still, rendered by the worker
  // ---------------------------------------------------------------
  async animateImage(raw: Record<string, unknown>, principal: string): Promise<JobHandle> {
    const projectId = sanitizeIdentifier(raw.project_id, "project");
    const assetId = sanitizeIdentifier(raw.asset_id, "asset_id");
    // motion/intensity are enums checked by zod at the tool boundary.
    const motion = raw.motion as AnimationMotion;
    const intensity = (raw.intensity as AnimationIntensity | undefined) ?? "medium";
    const durationMs = clampAnimationDuration(
      (raw.duration_ms as number | undefined) ?? DEFAULT_ANIMATION_DURATION_MS[motion],
    );

    const src = await this.#stillSource(projectId, assetId, raw.source_version as number | undefined);

    const spec: ImageSpec = {
      projectId,
      assetId,
      description: `animate_image: ${motion}`,
      stylePrompt: "",
      styleReference: null,
      aspectRatio: "1:1",
      width: src.width,
      height: src.height,
      transparentBackground: src.transparent,
      outputFormat: "webp",
      isolatedObject: true,
      safePaddingPercent: 0,
      filename: "animation.webp",
    };

    const version = (await this.#store.highestAllocatedVersion(projectId, assetId)) + 1;
    const jobId = newJobId();

    await this.#store.create(this.#newRecord(jobId, spec, version, src.version, principal));
    await this.#queue.enqueue({
      jobId,
      kind: "animate",
      spec,
      version,
      parentVersion: src.version,
      sourceKey: src.key,
      instructions: null,
      animation: { motion, intensity, durationMs },
    });

    return { job_id: jobId, status: "queued" };
  }

  /**
   * The still an edit or an animation starts from. Animated artifacts are
   * refused: Codex edits and the motion presets both work on one frame.
   */
  async #stillSource(
    projectId: string,
    assetId: string,
    version: number | undefined,
  ): Promise<ArtifactRef> {
    const source = await this.#store.getArtifact(projectId, assetId, version);
    if (!source?.artifact) {
      throw new ImagegenError(
        "JOB_NOT_FOUND",
        `No artifact ${projectId}/${assetId}` + (version ? ` version ${version}` : ""),
      );
    }
    const src = source.artifact;
    if (src.animation) {
      throw new ImagegenError(
        "UNSUPPORTED_FORMAT",
        `${projectId}/${assetId} version ${src.version} is an animation; ` +
          "pass source_version of a still image.",
      );
    }
    return src;
  }
```

- [ ] **Step 5: Register the tool in `src/mcp/server.ts`**

Add `animateImageSchema,` to the import list from `"../contracts/index.ts"`, in alphabetical order before `cancelImageJobSchema`. Directly after the `edit_image` `server.registerTool(…);` call, add:

```ts
  server.registerTool(
    "animate_image",
    {
      title: "Animate existing artifact",
      description:
        "Turns a still artifact into a short looping animation and saves it " +
        "as a NEW VERSION: an animated WebP at artifact.url, plus a GIF " +
        "fallback at artifact.animation.gif_url. The object moves as a " +
        "whole (spin, pulse, shake, bounce or float); it does not change " +
        "pose. Uses no image-generation quota and takes a few seconds once " +
        "the worker is free.\n\n" +
        "Best source: create_image with isolated_object=true and a " +
        "transparent background. GIF transparency is 1-bit, so soft edges " +
        "look jagged in the GIF; prefer the WebP on the web. Waits and " +
        "reports progress like create_image; wait=false returns the job_id " +
        "right away.",
      inputSchema: animateImageSchema,
    },
    async (args, extra) => {
      try {
        const a = args as Record<string, unknown>;
        const handle = await service.animateImage(a, principal);
        return ok(await runAndMaybeWait(handle, a, extra, service));
      } catch (e) {
        return fail(e);
      }
    },
  );
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `node --test --experimental-strip-types --disable-warning=ExperimentalWarning tests/mcp/service.test.ts tests/mcp/server.test.ts 2>&1 | grep -E '^not ok|# (pass|fail)'`
Expected: `# fail 0`.

Run: `npm test 2>&1 | grep -E '^# (pass|fail)'; npm run typecheck`
Expected: `# fail 0` (142 existing plus the new ones); typecheck exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/mcp tests/mcp
git commit -m "feat: add the animate_image tool"
```

---

### Task 6: Docs, version 0.7.0 and image check

**Files:**
- Modify: `README.md` (tool table near line 77), `docs/architecture.md` (tool table near line 57, plus the flow description if it lists job kinds), `package.json`, `src/version.ts`, `charts/codex-imagegen-mcp/Chart.yaml`

**Interfaces:**
- Consumes: the finished feature (Tasks 1–5).
- Produces: version 0.7.0 everywhere `tests/version.test.ts` checks, and a Docker image that loads sharp.

- [ ] **Step 1: Tool tables**

In `README.md`, add a row after the `edit_image` row:

```markdown
| `animate_image` | Turns a still artifact into a looping animated WebP plus a GIF fallback (spin, pulse, shake, bounce, float) as a NEW version. No Codex run, no quota. |
```

In `docs/architecture.md`, add the same row after its `edit_image` row. If `docs/architecture.md` describes the job kinds or the worker flow (`grep -n 'kind\|edit' docs/architecture.md`), add one sentence there:

```markdown
An `animate` job skips Codex: the worker downloads the still, renders the motion with sharp, and uploads `animation.webp`, `animation.gif` and `metadata.json`.
```

- [ ] **Step 2: Bump the version**

- `package.json`: `"version": "0.6.2"` → `"version": "0.7.0"`.
- `src/version.ts`: `export const VERSION = "0.6.2";` → `export const VERSION = "0.7.0";`.
- `charts/codex-imagegen-mcp/Chart.yaml`: `version: 0.2.4` → `version: 0.3.0`, `appVersion: "0.6.2"` → `appVersion: "0.7.0"`.

Then run: `npm install --package-lock-only`. This makes the lockfile's root version follow.

- [ ] **Step 3: Full check**

Run: `npm test 2>&1 | grep -E '^# (pass|fail)'; npm run typecheck; helm lint charts/codex-imagegen-mcp | tail -2`
Expected: `# fail 0`; typecheck exit 0; `1 chart(s) linted, 0 chart(s) failed`.

- [ ] **Step 4: Build the image and load sharp inside it**

Run:
```bash
docker build -t codex-imagegen-mcp:animate-check . > /tmp/claude-1000/-home-ubuntu-Workspace-dc-fpt-argocd-platform/e8086e18-6121-4850-bddd-ad7e69f7b3a6/scratchpad/docker-build.log 2>&1; echo rc=$?
docker run --rm --entrypoint node codex-imagegen-mcp:animate-check -e 'import("sharp").then(m => console.log("sharp", m.default.versions.vips, m.default.format.gif.output.buffer))'
```
Expected: `rc=0`, then `sharp <vips version> true`. If the build fails, `tail -40` the log. If the runtime stage is missing `node_modules/@img/*`, check that the `npm prune --omit=dev` stage kept `sharp`'s optional platform package.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/architecture.md package.json package-lock.json src/version.ts charts/codex-imagegen-mcp/Chart.yaml
git commit -m "chore: release 0.7.0 with animate_image"
```

---

### Task 7: Release and rollout (after branch review and the user's go-ahead)

This task is outward-facing: it publishes a public tag and image and changes the live cluster. Do it only after the whole-branch review passes **and** the user has said to merge and release. It has no TDD cycle; its gate is the live check in Step 4.

**Files:**
- `codex-imagegen-mcp`: merge `feat/animate-image` into `main`, tag `v0.7.0`.
- `~/Workspace/dc-fpt-argocd-platform`:
  - `custom-applications/imagegen-mcp/values.yaml` (lines 14 and 40, both `tag:`);
  - `custom-applications/imagegen-mcp/Chart.yaml` (`appVersion`);
  - `custom-applications/agentgateway/values.yaml` (the three `mcp.tool.name in [...]` lists, near lines 241, 242 and 280).

- [ ] **Step 1: Merge, tag and publish**

```bash
cd ~/Workspace/codex-imagegen-mcp
git switch main && git merge --ff-only feat/animate-image
git log origin/main..main --format=%B | grep -ciE 'co-authored-by|claude-session'   # must print 0
git push origin main && git tag v0.7.0 && git push origin v0.7.0
gh run watch "$(gh run list --workflow publish.yml --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status
gh release view v0.7.0 --json tagName,url -q '.tagName + " " + .url'
```
Expected: the workflow succeeds and the release exists. `publish.yml` writes the release notes itself.

- [ ] **Step 2: GitOps change, in two commits**

Order matters: a 0.6.x worker that dequeues an `animate` payload falls into its create branch, spends a Codex quota unit and publishes an unrelated image. Commit and push the image bump first, wait until **both** imagegen Deployments run `:0.7.0` (Step 3), and only then commit the allowlist change.

In `~/Workspace/dc-fpt-argocd-platform`:
- Set both `tag: "0.6.2"` in `custom-applications/imagegen-mcp/values.yaml` to `tag: "0.7.0"`.
- Set `appVersion` in `custom-applications/imagegen-mcp/Chart.yaml` to `"0.7.0"`.
- In `custom-applications/agentgateway/values.yaml`, change each of the three lists from `["create_image", "edit_image", "get_image_job", "get_artifact", "cancel_image_job"]` to `["create_image", "edit_image", "animate_image", "get_image_job", "get_artifact", "cancel_image_job"]`.

Check:
```bash
grep -c '"animate_image"' custom-applications/agentgateway/values.yaml          # 3
grep -c 'tag: "0.7.0"' custom-applications/imagegen-mcp/values.yaml             # 2
helm dependency update custom-applications/agentgateway >/dev/null && helm template custom-applications/agentgateway >/dev/null && echo render-ok
git status --porcelain | grep -E 'Chart.lock|charts/' && echo "REMOVE before commit"
```
Then commit in Vietnamese without a footer, in this order:
```bash
git add custom-applications/imagegen-mcp
git commit -m "feat(imagegen-mcp): nâng 0.7.0 — thêm tool animate_image (ảnh động WebP + GIF)"
git push
# ...Step 3 shows both Deployments on :0.7.0, then:
git add custom-applications/agentgateway
git commit -m "feat(agentgateway): mở allowlist cho animate_image"
git push
```

- [ ] **Step 3: Wait for sync**

```bash
export KUBECONFIG=~/Workspace/RKE2/playbooks/kubeconfig
/tmp/claude-1000/-home-ubuntu-Workspace-dc-fpt-argocd-platform/e8086e18-6121-4850-bddd-ad7e69f7b3a6/scratchpad/upd/wait-apps.sh 40
kubectl -n mcp-system get deploy -o jsonpath='{range .items[*]}{.metadata.name} {.spec.template.spec.containers[0].image}{"\n"}{end}' | grep imagegen
```
Run the wait in the background. Expected: `ALL OK`, and both imagegen Deployments show `:0.7.0`.

- [ ] **Step 4: Live check**

1. Create one transparent isolated icon with the session's imagegen MCP `create_image`. This spends one quota unit. Use `project_id: "animate-check"`, `asset_id: "bell"`, `isolated_object: true` and a description of a simple bell icon.
2. The session's MCP client lists tools at connect time, so `animate_image` is not callable from it yet. Call it on the backend directly:
```bash
kubectl -n mcp-system port-forward svc/imagegen-mcp 18080:80 >/dev/null 2>&1 &
for m in spin pulse shake bounce float; do
  curl -s http://127.0.0.1:18080/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"animate_image\",\"arguments\":{\"project_id\":\"animate-check\",\"asset_id\":\"bell\",\"source_version\":1,\"motion\":\"$m\"}}}" \
    | grep '^data: ' | sed 's/^data: //' | jq -r '.result.structuredContent | "\(.status) \(.artifact.version) \(.artifact.url) \(.artifact.animation.gif_url) \(.waited_seconds)s"'
done
kill %1
```
   Check the Service name and port first with `kubectl -n mcp-system get svc`.
   Expected: five lines, each `completed <version> <webp url> <gif url> <seconds>s`, with no `failed`.
3. Download one WebP and one GIF. Check `pages` and `loop` with sharp from a scratch directory, then look at a frame with the Read tool.
4. Check that the gateway lets the tool through: ask the user to reconnect their MCP client and confirm `animate_image` appears.
5. Delete the `animate-check` artifacts only if the user wants them gone; they are harmless.
