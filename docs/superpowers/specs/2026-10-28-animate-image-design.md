# animate_image: looping motion presets on an existing image

Date: 2026-10-28. Status: approved design, not yet implemented.

## Goal

Let an MCP client turn a still artifact into a short looping animation for the
web: an icon that spins, a heart that pulses, a bell that shakes, a mascot that
bounces or floats. The output is an animated WebP plus a GIF fallback.

The animation is made by transforming the still image frame by frame. Codex is
not called, so an animation costs no ChatGPT quota. The object moves as a
whole; it never changes pose. Animations with real pose changes (sprite sheets,
frame-by-frame edits) were considered and rejected for this iteration.

## Success criteria

- `animate_image` on a transparent, isolated icon returns a WebP and a GIF
  that loop seamlessly, with the last frame flowing into the first.
- The job takes under 2 seconds of worker time once it reaches the front of
  the queue.
- Nothing is clipped while moving: a spinning square's corners stay on canvas.
- `create_image`, `edit_image` and their artifacts behave exactly as before.

## Interface

New MCP tool `animate_image`, a sixth entry in `PUBLIC_TOOLS`.

| Input | Type | Default | Notes |
|---|---|---|---|
| `project_id` | string | required | sanitized like `edit_image` |
| `asset_id` | string | required | |
| `source_version` | int ≥ 1 | latest | must be a still (PNG or static WebP) |
| `motion` | `spin` \| `pulse` \| `shake` \| `bounce` \| `float` | required | |
| `duration_ms` | int | per motion (below) | one loop; clamped to 400–4000 |
| `intensity` | `low` \| `medium` \| `high` | `medium` | scales amplitude |

The tool waits for the job and reports progress the same way `create_image`
does, then returns the artifact. Its description tells the client that the
best source is `create_image` with `isolated_object: true` and a transparent
background.

Result: a new version of the same asset, with `parentVersion` set to the
source version.

- The main file is `animation.webp`, an animated WebP with full alpha that
  loops forever.
- `ArtifactRef` gains an optional `animation` field:
  `{ motion, intensity, durationMs, frames, fps, gif: { key, url } }`.
- `metadata.json` carries the same fields, with `generator: "animate-preset"`.

`edit_image` and `animate_image` reject a source whose artifact has
`animation` set. They return a `UNSUPPORTED_FORMAT` that names the source
version, since the image models and the transforms both work on stills.

## Motions

Each motion is a closed curve over `t ∈ [0, 1)`, sampled at `frames` points so
that frame `frames` would equal frame 0. Amplitudes are given as
`low / medium / high`.

| Motion | Transform per frame | Amplitude | Default duration |
|---|---|---|---|
| `spin` | rotate `360°·t` | (fixed) | 1200 ms |
| `pulse` | scale `1 + A·(1−cos 2πt)/2` | A = 0.08 / 0.14 / 0.20 | 1000 ms |
| `shake` | rotate `A·sin 2πt·e^(…)`, a damped wobble that ends at 0° | 6° / 10° / 15° | 800 ms |
| `bounce` | translate y by `−A·abs(sin πt)`, squash (`scaleY 0.92`, `scaleX 1.06`) near the ground | 8% / 14% / 20% of height | 900 ms |
| `float` | translate y by `A·sin 2πt` | 3% / 5% / 8% of height | 2400 ms |

`frames = round(duration_ms / 1000 · 24)`, clamped to 8–96. `fps` is 24.

## Rendering

New module `src/worker/animate.ts`, using `sharp` (new dependency).

1. `frameTransforms(motion, intensity, frames)` is a pure function that
   returns `{ angleDeg, scaleX, scaleY, dx, dy }[]`. It is unit-tested without
   images.
2. Load the source and downscale it so its long side is ≤ 512 px. Animated
   icons do not need more, and file size grows with every frame.
3. Compute padding so no frame clips:
   - `spin` and `shake` pad to the rotated bounding box (for spin, the
     diagonal);
   - `pulse` pads by the maximum scale;
   - `bounce` and `float` pad vertically by the amplitude.

   Every frame is drawn centered on one canvas of that padded size, with a
   transparent background.
4. Render each frame with sharp (resize for scale, rotate with a transparent
   background, composite at the offset), then stack the frames into one
   vertical strip of raw RGBA.
5. Encode the strip twice, using sharp's `pageHeight` multi-page input:
   - WebP with `loop: 0`, delay `1000/fps` per frame, alpha kept;
   - GIF with `loop: 0`, same delay. GIF alpha is 1-bit, so soft edges on a
     transparent background look jagged. This is expected and noted in the
     tool description.

## Flow

The MCP role writes only to the job store; artifact storage belongs to the
worker. So `animate_image` enqueues a job with the new kind `"animate"` on the
existing queue:

- `JobPayload.kind` becomes `"create" | "edit" | "animate"`;
- an `animate` payload carries `sourceKey`, `parentVersion` and an
  `animation` spec (`motion`, `intensity`, `durationMs`).

`ImageSpec` stays as it is. The service fills in the source's
`width`/`height`/`transparent` and sets `filename: "animation.webp"`.

In `consumer.#handle`, an `animate` payload skips Codex entirely:

1. download `sourceKey`;
2. render;
3. upload `animation.webp`, `animation.gif` and `metadata.json`;
4. complete the job with the `ArtifactRef`.

Cancellation, status and `get_artifact` work unchanged.

Trade-off accepted: the worker runs one job at a time, so an animate job can
wait behind a 30–140 s Codex job. Rendering itself is sub-second. A separate
fast lane would need a second queue and a second consumer loop. That is not
worth it at this volume.

Version allocation uses the same `highestAllocatedVersion + 1` path as
`edit_image`.

## Errors

| Case | Result |
|---|---|
| No such asset or version | `JOB_NOT_FOUND` (same as `edit_image`) |
| Source is already animated | `UNSUPPORTED_FORMAT` |
| Bad `motion` / `intensity` / `duration_ms` type | schema rejection by zod |
| sharp fails to decode or encode | job `failed`, code `IMAGE_GENERATION_FAILED` with the sharp message |

Rate limiting: none. The job is cheap, and the output is bounded at 512 px and
96 frames.

## Testing

- `frameTransforms` for every motion:
  - frame 0 is the identity;
  - the curve closes (the next sample after the last frame equals frame 0);
  - peak amplitude grows from low to high;
  - `spin` covers 360°.
- Padding: a square source spun 45° stays fully on canvas, checked by the
  alpha bounding box of the rendered frame.
- Encoder:
  - the WebP and GIF read back with `sharp().metadata()` as `pages === frames`
    and `loop === 0`;
  - the WebP keeps an alpha channel.
- Consumer: an `animate` payload with the memory queue and local storage
  completes. It does so without invoking the Codex runner (the runner is
  stubbed to throw), and produces two files plus metadata.
- Service and schema:
  - `animate_image` validates its input;
  - it rejects an animated source;
  - it allocates the next version.
- Live check after deploy: create a transparent icon, then run each of the 5
  motions through the gateway and look at the files.

## Release and rollout

- `codex-imagegen-mcp` v0.7.0:
  - minor, because of a new tool and a new `ArtifactRef` field;
  - chart 0.3.0 with `appVersion` 0.7.0;
  - tag and GitHub Release, as the repository is public.
- README and `docs/architecture.md` describe the new tool.
- Dockerfile: `sharp` ships prebuilt libvips for linux-x64 and arm64 with GIF
  support, so no system packages are needed. Check the image still builds on
  both arches.
- GitOps, in `dc-fpt-argocd-platform`:
  - bump both image tags in `custom-applications/imagegen-mcp/values.yaml`
    together;
  - add `animate_image` to the three `mcp.tool.name in [...]` allowlists in
    `custom-applications/agentgateway/values.yaml`. Without this the gateway
    hides the tool.

## Out of scope

- Pose-changing animation: sprite sheets, frame-by-frame edits.
- Video output (MP4/WebM).
- Animating an image the server did not generate (upload).
- Custom easing curves and combined motions.
