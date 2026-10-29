# upload_image Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use sdd-orca:subagent-driven-development (recommended) or sdd-orca:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `upload_image` tool so a client can hand the server its own image (presigned S3 POST or inline base64) and use it as a reference for `create_image` or as the source of `edit_image` / `animate_image`.

**Architecture:** The MCP role issues an upload id and either stores inline bytes or presigns a POST to `uploads/<project>/<id>`; it inspects every upload with sharp when a job is submitted. The job payload carries upload keys; the worker downloads, auto-orients and strips each one into the job folder, exactly where `edit_image` already puts its source. The bucket gets CORS for the POST and a lifecycle rule that expires `uploads/`.

**Tech Stack:** TypeScript on Node ≥ 22.6 (`--experimental-strip-types`), `node:test`, zod 3, `@modelcontextprotocol/sdk`, `@aws-sdk/client-s3` + new `@aws-sdk/s3-presigned-post`, sharp 0.35.5. Deployment: Helm chart in `dc-fpt-argocd-platform`, Ceph RGW 20.2.4 behind `https://s3.tinyorbit.vn`.

**Spec:** `docs/superpowers/specs/2026-10-29-image-upload-design.md`

## Global Constraints

- Public repo: code, comments, test names, commit messages in **English**; Conventional Commits. Comments explain *why*, match the density of the surrounding file.
- Commits carry **no** `Co-Authored-By` or `Claude-Session` footer (user rule, every repo).
- Imports use the `.ts` extension; tests are `node:test` + `node:assert/strict`.
- Limits (verbatim from the spec): POST cap **20 MB**; inline cap **700 KB** decoded; image sides **16–4096 px**; formats **PNG, JPEG, WebP**, still only; POST target expires after **15 minutes** (900 s); `reference_upload_ids` **1–4**; `UPLOAD_RETENTION_DAYS` default **1**; `UPLOAD_CORS_ORIGINS` default `*`.
- `upload_id` = `upl_` + 32 lowercase hex from a CSPRNG; key = `uploads/<project_id>/<upload_id>`.
- Errors: malformed / missing / expired id → `UPLOAD_NOT_FOUND` (new code); bytes failing inspection → `UNSUPPORTED_FORMAT` with the reason.
- New dependency pinned to the installed SDK line: `@aws-sdk/s3-presigned-post@3.1131.0` (same version as the installed `@aws-sdk/client-s3`).
- GitOps repo (`~/Workspace/dc-fpt-argocd-platform`): commit messages and YAML comments in **Vietnamese**, comment blocks ≤ 3 lines explaining why; never commit `Chart.lock` or `charts/*.tgz`; the image bump lands **before** `upload_image` is added to the **four** `mcp.tool.name in [...]` allowlists, in a separate commit.
- Never print bucket keys or tokens: read the Secret into env inside the command that uses it.

## Review Focus

1. **POST field order.** A client that appends the file before the policy fields gets a 400 from S3. The tool description must say "every entry of `fields` first, the file last under `file_field`" — checked by the Task 6 description test and the Task 9 live POST.
2. **An upload that expires between submit and run.** A long queue can outlive the upload; the job must fail as `UPLOAD_NOT_FOUND` with "upload it again", not as "failed to read source artifact". Test in Task 7.
3. **The same upload id passed twice** in one `reference_upload_ids` must not become two reference files. Test in Task 5.
4. **SVG sent as an image.** sharp reads SVG; it must be refused as a format, never rasterised from client input. Test in Task 3.
5. **A browser preflight from another origin.** Claude Design's preview sends `OPTIONS` before the POST; the bucket must answer with `Access-Control-Allow-Origin`. Proven in Task 1, re-checked live in Task 9.

---

### Task 1: Spike — prove RGW accepts the presigned POST, the size cap, CORS and lifecycle

Throwaway. Nothing is committed. If any **want** below does not hold, STOP and report to the human partner: the design depends on all of them.

**Files:**
- Create (gitignored workspace, not committed): `.superpowers/sdd/2026-10-29-image-upload/spike.mjs`

- [ ] **Step 1: Install the presigner without touching package.json**

```bash
cd ~/Workspace/codex-imagegen-mcp
npm install --no-save @aws-sdk/s3-presigned-post@3.1131.0 > /tmp/claude-1000/spike-npm.log 2>&1; echo rc=$?
```
Expected: `rc=0`; `git status --porcelain package.json package-lock.json` prints nothing.

- [ ] **Step 2: Write the spike script**

The script lives inside the repo tree so `@aws-sdk/*` resolves from the repo's `node_modules`. It reads current bucket CORS/lifecycle first and only writes with `--apply`.

```js
// Throwaway spike for upload_image: does RGW accept what the feature relies on?
import {
  S3Client, HeadObjectCommand, DeleteObjectCommand,
  GetBucketCorsCommand, PutBucketCorsCommand,
  GetBucketLifecycleConfigurationCommand, PutBucketLifecycleConfigurationCommand,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";

const Bucket = "mcp-artifacts";
const PUBLIC = "https://s3.tinyorbit.vn/mcp-artifacts";
const UA = { "User-Agent": "upload-spike/1.0" };
const client = new S3Client({
  endpoint: "https://s3.tinyorbit.vn", region: "us-east-1", forcePathStyle: true,
  credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY },
});
const say = (k, v) => console.log(`${k}: ${v}`);
const Key = `uploads/spike/upl_${"0".repeat(32)}`;

async function show(name, cmd, pick) {
  try { say(name, JSON.stringify(pick(await client.send(cmd)))); } catch (e) { say(name, e.name); }
}
await show("before.cors", new GetBucketCorsCommand({ Bucket }), (r) => r.CORSRules);
await show("before.lifecycle", new GetBucketLifecycleConfigurationCommand({ Bucket }), (r) => r.Rules);
if (process.argv[2] !== "--apply") process.exit(0);

// Exactly what ArtifactStorage.configureUploads will send.
await client.send(new PutBucketCorsCommand({ Bucket, CORSConfiguration: { CORSRules: [
  { AllowedMethods: ["POST"], AllowedOrigins: ["*"], AllowedHeaders: ["*"], MaxAgeSeconds: 3000 },
  { AllowedMethods: ["GET", "HEAD"], AllowedOrigins: ["*"], AllowedHeaders: ["*"], MaxAgeSeconds: 3000 },
] } })).then(() => say("put.cors", "ok"), (e) => say("put.cors", `${e.name} ${e.message}`));
await client.send(new PutBucketLifecycleConfigurationCommand({ Bucket, LifecycleConfiguration: { Rules: [
  { ID: "expire-uploads", Status: "Enabled", Filter: { Prefix: "uploads/" }, Expiration: { Days: 1 } },
] } })).then(() => say("put.lifecycle", "ok"), (e) => say("put.lifecycle", `${e.name} ${e.message}`));
await show("after.lifecycle", new GetBucketLifecycleConfigurationCommand({ Bucket }), (r) => r.Rules);

const { fields } = await createPresignedPost(client, {
  Bucket, Key, Expires: 900,
  Conditions: [["content-length-range", 1, 1000], ["eq", "$Content-Type", "image/png"]],
  Fields: { "Content-Type": "image/png" },
});
async function post(bytes) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append("file", new Blob([Buffer.alloc(bytes, 1)], { type: "image/png" }), "x.png");
  const r = await fetch(PUBLIC, { method: "POST", body: form, headers: { ...UA, Origin: "https://claude.ai" } });
  return `${r.status} acao=${r.headers.get("access-control-allow-origin")} ${(await r.text()).slice(0, 160)}`;
}
say("post.small", await post(500));
say("post.too-big", await post(1001));
const pre = await fetch(PUBLIC, { method: "OPTIONS", headers: {
  ...UA, Origin: "https://claude.ai", "Access-Control-Request-Method": "POST" } });
say("preflight", `${pre.status} acao=${pre.headers.get("access-control-allow-origin")} methods=${pre.headers.get("access-control-allow-methods")}`);
say("anon.get", (await fetch(`${PUBLIC}/${Key}`, { headers: UA })).status);
say("head", (await client.send(new HeadObjectCommand({ Bucket, Key }))).ContentLength);
await client.send(new DeleteObjectCommand({ Bucket, Key }));
say("cleanup", "deleted");
```

- [ ] **Step 3: Read the current bucket config (read-only run)**

```bash
cd ~/Workspace/codex-imagegen-mcp && export KUBECONFIG=~/Workspace/RKE2/playbooks/kubeconfig
AWS_ACCESS_KEY_ID=$(kubectl -n mcp-system get secret mcp-artifacts -o jsonpath='{.data.AWS_ACCESS_KEY_ID}' | base64 -d) \
AWS_SECRET_ACCESS_KEY=$(kubectl -n mcp-system get secret mcp-artifacts -o jsonpath='{.data.AWS_SECRET_ACCESS_KEY}' | base64 -d) \
node .superpowers/sdd/2026-10-29-image-upload/spike.mjs
```
Expected: `before.cors: NoSuchCORSConfiguration` and `before.lifecycle: NoSuchLifecycleConfiguration`.
If either shows existing rules, STOP: `--apply` would overwrite them. Report them to the human partner.

- [ ] **Step 4: Apply and probe**

Same command with `--apply` appended.
Expected (the **wants**):
- `put.cors: ok`, `put.lifecycle: ok`, `after.lifecycle` shows the `expire-uploads` rule;
- `post.small: 204 acao=*` (or the echoed origin);
- `post.too-big: 400 …EntityTooLarge…`;
- `preflight: 200 acao=* methods=` containing `POST`;
- `anon.get: 403`; `head: 500`; `cleanup: deleted`.

If `put.lifecycle` fails on a checksum header, retry once with `requestChecksumCalculation: "WHEN_REQUIRED"` added to the `S3Client` options. If that works, Task 4 must set the same option on the client in `src/storage/s3.ts`; record it as a ruling.

- [ ] **Step 5: Record the result in the ledger**

Append the full output lines of Step 4 to `.superpowers/sdd/2026-10-29-image-upload/progress.md` under `Task 1: spike`. No commit.

---

### Task 2: Contracts — upload ids, limits, error code, schema fields, payload field

**Files:**
- Create: `src/contracts/upload.ts`
- Modify: `src/contracts/errors.ts` (add `"UPLOAD_NOT_FOUND"` after `"JOB_NOT_FOUND"`)
- Modify: `src/contracts/index.ts` (export `./upload.ts`)
- Modify: `src/contracts/schemas.ts` (`uploadImageSchema`, `reference_upload_ids`, `source_upload_id`)
- Modify: `src/contracts/job.ts` (`JobPayload.referenceKeys`)
- Test: `tests/contracts/upload.test.ts`

`PUBLIC_TOOLS` is NOT changed here: `tests/mcp/server.test.ts` asserts it equals the registered tools, and the tool is registered in Task 6.

**Interfaces:**
- Produces (from `src/contracts/index.ts`):
  - `UPLOAD_CONTENT_TYPES = ["image/png", "image/jpeg", "image/webp"] as const`, `type UploadContentType`
  - `MAX_UPLOAD_BYTES = 20971520`, `MAX_INLINE_UPLOAD_BYTES = 716800`, `MAX_UPLOAD_SIDE = 4096`, `MIN_UPLOAD_SIDE = 16`, `UPLOAD_TTL_SECONDS = 900`, `MAX_REFERENCE_UPLOADS = 4`
  - `newUploadId(): string`, `uploadKey(projectId: string, uploadId: string): string` (throws `UPLOAD_NOT_FOUND` on a malformed id), `isUploadKey(key: string): boolean`
  - `uploadImageSchema` (zod raw shape: `project_id`, `content_type?`, `data_base64?`)
  - `createImageSchema.reference_upload_ids`, `editImageSchema.source_upload_id`, `animateImageSchema.source_upload_id`
  - `JobPayload.referenceKeys?: string[]`

- [ ] **Step 1: Write the failing test** — `tests/contracts/upload.test.ts`

```ts
// The upload_image contract: ids, keys and the fields other tools accept.
// Both roles import these, so a drift here breaks a job silently.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import {
  ImagegenError,
  MAX_REFERENCE_UPLOADS,
  animateImageSchema,
  createImageSchema,
  editImageSchema,
  isUploadKey,
  newUploadId,
  uploadImageSchema,
  uploadKey,
} from "../../src/contracts/index.ts";

const notFound = (e: unknown) => e instanceof ImagegenError && e.code === "UPLOAD_NOT_FOUND";

test("upload ids are upl_ plus 32 hex characters and never repeat", () => {
  const a = newUploadId();
  assert.match(a, /^upl_[0-9a-f]{32}$/);
  assert.notEqual(a, newUploadId());
});

test("an upload key puts the project in the path", () => {
  const id = newUploadId();
  assert.equal(uploadKey("tinyorbit-cloud", id), `uploads/tinyorbit-cloud/${id}`);
  assert.equal(isUploadKey(uploadKey("p", id)), true);
  assert.equal(isUploadKey("projects/p/a/v1/artifact.png"), false);
});

test("a malformed upload id is not found rather than turned into a path", () => {
  for (const bad of ["", "../../etc/passwd", "upl_XYZ", `upl_${"a".repeat(31)}`, `upl_${"a".repeat(32)}/x`]) {
    assert.throws(() => uploadKey("p", bad), notFound, JSON.stringify(bad));
  }
});

test("upload_image takes a known image type and optional inline data", () => {
  const s = z.object(uploadImageSchema);
  assert.equal(s.safeParse({ project_id: "p", content_type: "image/png" }).success, true);
  assert.equal(s.safeParse({ project_id: "p", data_base64: "aGk=" }).success, true);
  assert.equal(s.safeParse({ project_id: "p", content_type: "image/gif" }).success, false);
  assert.equal(s.safeParse({ content_type: "image/png" }).success, false, "project_id is required");
});

test("create_image accepts 1 to 4 reference uploads", () => {
  const s = z.object(createImageSchema);
  const base = { project_id: "p", asset_id: "a", description: "d" };
  const ids = (n: number) => Array.from({ length: n }, () => newUploadId());
  assert.equal(s.safeParse({ ...base, reference_upload_ids: ids(MAX_REFERENCE_UPLOADS) }).success, true);
  assert.equal(s.safeParse({ ...base, reference_upload_ids: [] }).success, false);
  assert.equal(s.safeParse({ ...base, reference_upload_ids: ids(MAX_REFERENCE_UPLOADS + 1) }).success, false);
});

test("edit_image and animate_image accept an upload as their source", () => {
  const id = newUploadId();
  assert.equal(
    z.object(editImageSchema).safeParse({ project_id: "p", asset_id: "a", instructions: "x", source_upload_id: id }).success,
    true,
  );
  assert.equal(
    z.object(animateImageSchema).safeParse({ project_id: "p", asset_id: "a", motion: "spin", source_upload_id: id }).success,
    true,
  );
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test --experimental-strip-types --disable-warning=ExperimentalWarning tests/contracts/upload.test.ts`
Expected: FAIL — `newUploadId` (and the other names) are not exported.

- [ ] **Step 3: Implement**

`src/contracts/upload.ts`:

```ts
// The upload_image contract: limits, ids and where an upload lives.
//
// Pure values only. The sharp-based inspection lives in src/uploads.ts so
// that importing the contracts never loads a native image library.

import { randomBytes } from "node:crypto";
import { ImagegenError } from "./errors.ts";

export const UPLOAD_CONTENT_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type UploadContentType = (typeof UPLOAD_CONTENT_TYPES)[number];

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
/** Inline base64 grows by a third; this keeps the JSON-RPC body under the 1 MB /mcp limit. */
export const MAX_INLINE_UPLOAD_BYTES = 700 * 1024;
export const MAX_UPLOAD_SIDE = 4096;
export const MIN_UPLOAD_SIDE = 16;
/** Lifetime of a POST target, not of the upload: the bucket lifecycle decides that. */
export const UPLOAD_TTL_SECONDS = 900;
export const MAX_REFERENCE_UPLOADS = 4;

const UPLOAD_ID = /^upl_[0-9a-f]{32}$/;
const UPLOAD_PREFIX = "uploads/";

export function newUploadId(): string {
  return `upl_${randomBytes(16).toString("hex")}`;
}

/**
 * Where an upload lives. The project is part of the key, so an id only
 * resolves inside the project it was issued for, and the strict id format
 * means a caller's string never becomes a path.
 */
export function uploadKey(projectId: string, uploadId: string): string {
  if (!UPLOAD_ID.test(uploadId)) {
    throw new ImagegenError(
      "UPLOAD_NOT_FOUND",
      "upload_id must be one returned by upload_image (upl_ followed by 32 hex characters).",
    );
  }
  return `${UPLOAD_PREFIX}${projectId}/${uploadId}`;
}

export function isUploadKey(key: string): boolean {
  return key.startsWith(UPLOAD_PREFIX);
}
```

`src/contracts/errors.ts` — in `ERROR_CODES`, after `"JOB_NOT_FOUND",` add:

```ts
  // An upload_id that was never issued, belongs to another project, or
  // outlived the bucket's retention. Separate from JOB_NOT_FOUND because
  // the fix is "upload it again", not "check the job id".
  "UPLOAD_NOT_FOUND",
```

`src/contracts/index.ts` — after `export * from "./animation.ts";` add `export * from "./upload.ts";`.

`src/contracts/schemas.ts`:
- add to the imports: `import { MAX_REFERENCE_UPLOADS, UPLOAD_CONTENT_TYPES } from "./upload.ts";`
- in `createImageSchema`, right after `description`:

```ts
  reference_upload_ids: z
    .array(z.string())
    .min(1)
    .max(MAX_REFERENCE_UPLOADS)
    .optional()
    .describe(
      "upload_ids from upload_image. Codex looks at these images while " +
        "drawing: a logo to include, a product or character to keep " +
        "consistent, a layout to follow.",
    ),
```
- in `editImageSchema`, right after `source_version`:

```ts
  source_upload_id: z
    .string()
    .optional()
    .describe(
      "upload_id from upload_image: edit your own image instead of an " +
        "existing version. Do not combine with source_version.",
    ),
```
- in `animateImageSchema`, right after `source_version`: `source_upload_id: editImageSchema.source_upload_id,`
- after `cancelImageJobSchema`:

```ts
export const uploadImageSchema = {
  project_id: z
    .string()
    .describe("Project the upload belongs to; only tools in this project can use it."),
  content_type: z
    .enum(UPLOAD_CONTENT_TYPES)
    .optional()
    .describe("Required unless data_base64 is sent: it is signed into the POST target."),
  data_base64: z
    .string()
    .optional()
    .describe(
      "The image inline, as raw base64 or a data: URI, at most 700 KB " +
        "decoded. Omit it to get a POST target for files up to 20 MB.",
    ),
};
```

`src/contracts/job.ts` — in `JobPayload`, change the `sourceKey` comment to `/** S3 key of the source image (an artifact or an upload), present when kind is "edit" or "animate". */` and add after `animation?`:

```ts
  /** Only for kind="create": upload keys Codex receives as reference images. */
  referenceKeys?: string[];
```

- [ ] **Step 4: Run it and watch it pass, then the suite**

Run: `node --test --experimental-strip-types --disable-warning=ExperimentalWarning tests/contracts/upload.test.ts` → Expected: 6/6 pass.
Run: `npm test > /tmp/claude-1000/t2.log 2>&1; echo rc=$?; grep -E '^# (pass|fail)' /tmp/claude-1000/t2.log` → Expected: `rc=0`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/contracts tests/contracts/upload.test.ts
git commit -m "feat(contracts): upload ids, limits and the fields that take an upload"
```

---

### Task 3: Inspect, normalise and decode uploaded bytes

**Files:**
- Create: `src/uploads.ts`
- Test: `tests/uploads.test.ts`

**Interfaces:**
- Consumes: `MAX_UPLOAD_BYTES`, `MAX_INLINE_UPLOAD_BYTES`, `MAX_UPLOAD_SIDE`, `MIN_UPLOAD_SIDE`, `ImagegenError` from Task 2.
- Produces:
  - `type UploadFormat = "png" | "jpeg" | "webp"`
  - `interface UploadInfo { format: UploadFormat; width: number; height: number; hasAlpha: boolean; bytes: number }` (width/height as displayed, after EXIF orientation)
  - `inspectUpload(buf: Buffer): Promise<UploadInfo>` — throws `UNSUPPORTED_FORMAT`
  - `normaliseUpload(buf: Buffer, format: "png" | "webp"): Promise<Buffer>` — upright, metadata stripped
  - `decodeInlineUpload(data: string): Buffer` — throws `UNSUPPORTED_FORMAT`

- [ ] **Step 1: Write the failing test** — `tests/uploads.test.ts`

```ts
// What the server accepts from a client's image, and what it hands Codex.

import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";

import { ImagegenError, MAX_INLINE_UPLOAD_BYTES, MAX_UPLOAD_BYTES } from "../src/contracts/index.ts";
import { decodeInlineUpload, inspectUpload, normaliseUpload } from "../src/uploads.ts";

const refused = (pattern: RegExp) => (e: unknown) =>
  e instanceof ImagegenError && e.code === "UNSUPPORTED_FORMAT" && pattern.test(e.message);

function solid(width: number, height: number) {
  return sharp({ create: { width, height, channels: 4, background: { r: 10, g: 120, b: 200, alpha: 1 } } });
}

test("PNG, JPEG and WebP are accepted with their size and alpha", async () => {
  assert.deepEqual(await inspectUpload(await solid(64, 32).png().toBuffer()), {
    format: "png", width: 64, height: 32, hasAlpha: true, bytes: (await solid(64, 32).png().toBuffer()).byteLength,
  });
  const jpeg = await inspectUpload(await solid(40, 30).jpeg().toBuffer());
  assert.equal(jpeg.format, "jpeg");
  assert.equal(jpeg.hasAlpha, false);
  assert.equal((await inspectUpload(await solid(20, 20).webp().toBuffer())).format, "webp");
});

test("an EXIF-rotated photo reports the size it is shown at", async () => {
  const sideways = await solid(40, 20).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const info = await inspectUpload(sideways);
  assert.equal(info.width, 20);
  assert.equal(info.height, 40);
});

test("GIF, SVG and bytes that are not an image are refused by format", async () => {
  await assert.rejects(inspectUpload(await solid(20, 20).gif().toBuffer()), refused(/is gif/));
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>');
  await assert.rejects(inspectUpload(svg), refused(/is svg/));
  await assert.rejects(inspectUpload(Buffer.from("hello")), refused(/not an image/));
  await assert.rejects(inspectUpload(Buffer.alloc(0)), refused(/empty/));
});

test("an animated WebP is refused", async () => {
  const strip = Buffer.alloc(20 * 40 * 4, 200);
  const animated = await sharp(strip, { raw: { width: 20, height: 40, channels: 4, pageHeight: 20 } })
    .webp()
    .toBuffer();
  await assert.rejects(inspectUpload(animated), refused(/animated/));
});

test("sides outside 16-4096 px and files over 20 MB are refused", async () => {
  await assert.rejects(inspectUpload(await solid(4097, 16).png().toBuffer()), refused(/4096/));
  await assert.rejects(inspectUpload(await solid(15, 15).png().toBuffer()), refused(/at least 16/));
  await assert.rejects(inspectUpload(Buffer.alloc(MAX_UPLOAD_BYTES + 1)), refused(/limit is 20 MB/));
});

test("normalising turns the image upright and drops its metadata", async () => {
  const sideways = await solid(40, 20).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const out = await sharp(await normaliseUpload(sideways, "png")).metadata();
  assert.equal(out.format, "png");
  assert.equal(out.width, 20);
  assert.equal(out.height, 40);
  assert.equal(out.orientation, undefined);
  assert.equal(out.exif, undefined);
});

test("inline data is read from raw base64 or a data URI", () => {
  const bytes = Buffer.from([1, 2, 3, 250]);
  assert.deepEqual(decodeInlineUpload(bytes.toString("base64")), bytes);
  assert.deepEqual(decodeInlineUpload(`data:image/png;base64,${bytes.toString("base64")}`), bytes);
  assert.deepEqual(decodeInlineUpload(` ${bytes.toString("base64")}\n`), bytes);
});

test("inline data that is not base64, empty, or over 700 KB is refused", () => {
  assert.throws(() => decodeInlineUpload("not base64!!"), refused(/base64/));
  assert.throws(() => decodeInlineUpload(""), refused(/base64/));
  const big = Buffer.alloc(MAX_INLINE_UPLOAD_BYTES + 1).toString("base64");
  assert.throws(() => decodeInlineUpload(big), refused(/700 KB/));
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test --experimental-strip-types --disable-warning=ExperimentalWarning tests/uploads.test.ts`
Expected: FAIL — cannot find module `../src/uploads.ts`.

- [ ] **Step 3: Implement** — `src/uploads.ts`

```ts
// Checks and cleans an image a client uploaded, before anything relies on it.
//
// The MCP role inspects at submit time so a bad file fails the tool call,
// not a Codex run that already spent quota. The worker normalises right
// before use: client photos carry EXIF rotation and metadata that Codex
// should neither misread nor see.

import sharp from "sharp";
import type { Metadata } from "sharp";
import {
  ImagegenError,
  MAX_INLINE_UPLOAD_BYTES,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_SIDE,
  MIN_UPLOAD_SIDE,
} from "./contracts/index.ts";

export type UploadFormat = "png" | "jpeg" | "webp";

export interface UploadInfo {
  format: UploadFormat;
  /** As displayed, after EXIF orientation. */
  width: number;
  height: number;
  hasAlpha: boolean;
  bytes: number;
}

// SVG is readable by sharp but refused: rasterising client-supplied SVG
// lets the client steer librsvg, and no tool needs vector input.
const FORMATS: readonly string[] = ["png", "jpeg", "webp"];
const MB = 1024 * 1024;
const DATA_URI = /^data:[^,]*;base64,/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function refuse(reason: string): never {
  throw new ImagegenError("UNSUPPORTED_FORMAT", `The uploaded file ${reason}`);
}

export async function inspectUpload(buf: Buffer): Promise<UploadInfo> {
  if (buf.byteLength === 0) refuse("is empty.");
  if (buf.byteLength > MAX_UPLOAD_BYTES) {
    refuse(`is ${(buf.byteLength / MB).toFixed(1)} MB; the limit is ${MAX_UPLOAD_BYTES / MB} MB.`);
  }

  const m: Metadata = await sharp(buf)
    .metadata()
    .catch(() => refuse("is not an image that can be read."));
  if (!m.format || !FORMATS.includes(m.format)) {
    refuse(`is ${m.format ?? "an unknown format"}; send PNG, JPEG or WebP.`);
  }
  if ((m.pages ?? 1) > 1) refuse("is animated; send a still image.");

  // Orientations 5-8 swap the axes: a phone photo stored landscape is shown portrait.
  const swapped = (m.orientation ?? 1) >= 5;
  const width = (swapped ? m.height : m.width) ?? 0;
  const height = (swapped ? m.width : m.height) ?? 0;
  if (Math.max(width, height) > MAX_UPLOAD_SIDE) {
    refuse(`is ${width}x${height}; the limit is ${MAX_UPLOAD_SIDE} px on either side.`);
  }
  if (Math.min(width, height) < MIN_UPLOAD_SIDE) {
    refuse(`is ${width}x${height}; it must be at least ${MIN_UPLOAD_SIDE} px on each side.`);
  }

  return {
    format: m.format as UploadFormat,
    width,
    height,
    hasAlpha: m.hasAlpha ?? false,
    bytes: buf.byteLength,
  };
}

/** Upright, metadata-free bytes in the format the job works in. */
export async function normaliseUpload(buf: Buffer, format: "png" | "webp"): Promise<Buffer> {
  // rotate() with no angle applies the EXIF orientation; sharp drops
  // metadata on output unless asked to keep it.
  return sharp(buf).rotate().toFormat(format).toBuffer();
}

export function decodeInlineUpload(data: string): Buffer {
  const raw = data.trim().replace(DATA_URI, "").replace(/\s+/g, "");
  if (!BASE64.test(raw)) refuse("is not valid base64.");
  const buf = Buffer.from(raw, "base64");
  if (buf.byteLength > MAX_INLINE_UPLOAD_BYTES) {
    refuse(
      `is ${Math.ceil(buf.byteLength / 1024)} KB inline; the inline limit is ` +
        `${MAX_INLINE_UPLOAD_BYTES / 1024} KB. Omit data_base64 to get a POST target for larger files.`,
    );
  }
  return buf;
}
```

- [ ] **Step 4: Run it and watch it pass, then typecheck**

Run: `node --test --experimental-strip-types --disable-warning=ExperimentalWarning tests/uploads.test.ts` → Expected: 8/8 pass.
Run: `npm run typecheck > /tmp/claude-1000/tc3.log 2>&1; echo rc=$?; head -20 /tmp/claude-1000/tc3.log` → Expected: `rc=0`.
If sharp reports `pages` for the GIF/animated cases differently than assumed (e.g. the animated WebP comes back as `pages: 2` only with `{ animated: true }`), fix the implementation, not the test, and ledger a ruling.

- [ ] **Step 5: Commit**

```bash
git add src/uploads.ts tests/uploads.test.ts
git commit -m "feat: inspect and normalise uploaded images"
```

---

### Task 4: Storage — put, head, presigned POST, bucket setup; keep uploads private in local mode

**Files:**
- Modify: `package.json`, `package-lock.json` (new dependency)
- Modify: `src/storage/types.ts`, `src/storage/s3.ts`, `src/storage/local.ts`
- Modify: `src/artifacts.ts` (serve `projects/` only)
- Test: `tests/storage/local.test.ts` (extend), `tests/storage/s3.test.ts` (new), `tests/artifacts.test.ts` (extend)

**Interfaces:**
- Produces (on `ArtifactStore`, both stores):
  - `putObject(key: string, body: Buffer, contentType: string): Promise<void>`
  - `headObject(key: string): Promise<{ bytes: number } | null>`
  - `presignUpload(key: string, contentType: string, maxBytes: number, ttlSeconds: number): Promise<PresignedUpload>` where `interface PresignedUpload { url: string; fields: Record<string, string> }`; local throws `UNSUPPORTED_FORMAT`
  - `configureUploads(settings: UploadBucketSettings): Promise<void>` where `interface UploadBucketSettings { corsOrigins: string[]; retentionDays: number }`; local is a no-op

- [ ] **Step 1: Add the dependency**

```bash
npm install @aws-sdk/s3-presigned-post@3.1131.0 > /tmp/claude-1000/npm4.log 2>&1; echo rc=$?
jq -r '.dependencies["@aws-sdk/s3-presigned-post"]' package.json
```
Expected: `rc=0`; prints `^3.1131.0`.

- [ ] **Step 2: Write the failing tests**

Append to `tests/storage/local.test.ts`, inside the existing `describe("LocalArtifactStore", …)` block (it already has `store`, `root`, `ImagegenError`):

```ts
  test("putObject stores bytes that headObject then sizes", async () => {
    const key = "uploads/p/upl_" + "a".repeat(32);
    await store.putObject(key, Buffer.from("12345"), "image/png");
    assert.deepEqual(await store.headObject(key), { bytes: 5 });
    assert.deepEqual(await store.download(key), Buffer.from("12345"));
  });

  test("headObject reports a missing object as null", async () => {
    assert.equal(await store.headObject("uploads/p/upl_" + "b".repeat(32)), null);
  });

  test("a presigned POST needs S3, and the error says to send inline data", async () => {
    await assert.rejects(
      store.presignUpload("uploads/p/upl_" + "c".repeat(32), "image/png", 1000, 900),
      (e: unknown) => e instanceof ImagegenError && e.code === "UNSUPPORTED_FORMAT" && /data_base64/.test(e.message),
    );
  });
```

Create `tests/storage/s3.test.ts`:

```ts
// The presigned POST policy, checked offline: signing needs no network.

import { test } from "node:test";
import assert from "node:assert/strict";

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
  const ttl = Date.parse(policy.expiration) - Date.now();
  assert.ok(ttl > 890_000 && ttl <= 900_000, `expires in ${ttl} ms`);
});
```

Append to `tests/artifacts.test.ts`: in `before`, after the existing `writeFile` calls, add

```ts
  await mkdir(join(root, "uploads/tinyorbit-cloud"), { recursive: true });
  await writeFile(join(root, "uploads/tinyorbit-cloud/upl_" + "e".repeat(32)), "a client's photo");
```
and inside `describe("GET /artifacts", …)`:

```ts
  test("uploads are private, as on S3 where only projects/ is public", async () => {
    const res = await fetch(`${base}/artifacts/uploads/tinyorbit-cloud/upl_${"e".repeat(32)}`);
    assert.equal(res.status, 404);
  });
```

- [ ] **Step 3: Run them and watch them fail**

Run: `node --test --experimental-strip-types --disable-warning=ExperimentalWarning tests/storage/local.test.ts tests/storage/s3.test.ts tests/artifacts.test.ts`
Expected: FAIL — `store.putObject is not a function`, `presignUpload is not a function`, and the uploads route returns 200.

- [ ] **Step 4: Implement**

`src/storage/types.ts` — after `UploadResult` add:

```ts
/** A browser-style POST target: send `fields` first, then the file. */
export interface PresignedUpload {
  url: string;
  fields: Record<string, string>;
}

export interface UploadBucketSettings {
  corsOrigins: string[];
  retentionDays: number;
}
```
and in `ArtifactStore` after `signedUrl`:

```ts
  /** Stores bytes already in memory: inline uploads. */
  putObject(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Size of an object, or null when there is none. */
  headObject(key: string): Promise<{ bytes: number } | null>;
  /** A POST target for exactly one key, capped at maxBytes. S3 only. */
  presignUpload(key: string, contentType: string, maxBytes: number, ttlSeconds: number): Promise<PresignedUpload>;
  /** CORS for the POST target and expiry of uploads/. A no-op where neither applies. */
  configureUploads(settings: UploadBucketSettings): Promise<void>;
```

`src/storage/s3.ts` — extend the client-s3 import with `HeadObjectCommand, PutBucketCorsCommand, PutBucketLifecycleConfigurationCommand`; add `import { createPresignedPost } from "@aws-sdk/s3-presigned-post";`; import the new types; add these methods to `ArtifactStorage`:

```ts
  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    try {
      await this.#client.send(
        new PutObjectCommand({ Bucket: this.#cfg.bucket, Key: key, Body: body, ContentType: contentType }),
      );
    } catch {
      throw new ImagegenError("STORAGE_UPLOAD_FAILED", "Failed to store the upload in object storage");
    }
  }

  async headObject(key: string): Promise<{ bytes: number } | null> {
    try {
      const r = await this.#client.send(new HeadObjectCommand({ Bucket: this.#cfg.bucket, Key: key }));
      return { bytes: r.ContentLength ?? 0 };
    } catch (e) {
      if ((e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
      throw new ImagegenError("STORAGE_UPLOAD_FAILED", "Could not reach object storage to look up the upload");
    }
  }

  /**
   * The policy signature covers the bucket and the form fields, not the
   * host, so the in-cluster endpoint the client signs with can be swapped
   * for the public bucket URL the caller can actually reach.
   */
  async presignUpload(
    key: string,
    contentType: string,
    maxBytes: number,
    ttlSeconds: number,
  ): Promise<PresignedUpload> {
    const { fields } = await createPresignedPost(this.#client, {
      Bucket: this.#cfg.bucket,
      Key: key,
      Conditions: [
        ["content-length-range", 1, maxBytes],
        ["eq", "$Content-Type", contentType],
      ],
      Fields: { "Content-Type": contentType },
      Expires: ttlSeconds,
    });
    return { url: this.#cfg.publicBaseUrl, fields };
  }

  /**
   * Replaces the bucket's CORS and lifecycle with exactly these rules: the
   * bucket belongs to this service. GET stays open to every origin because
   * artifacts are already public; POST is governed by the signed policy.
   */
  async configureUploads(settings: UploadBucketSettings): Promise<void> {
    await this.#client.send(
      new PutBucketCorsCommand({
        Bucket: this.#cfg.bucket,
        CORSConfiguration: {
          CORSRules: [
            { AllowedMethods: ["POST"], AllowedOrigins: settings.corsOrigins, AllowedHeaders: ["*"], MaxAgeSeconds: 3000 },
            { AllowedMethods: ["GET", "HEAD"], AllowedOrigins: ["*"], AllowedHeaders: ["*"], MaxAgeSeconds: 3000 },
          ],
        },
      }),
    );
    await this.#client.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: this.#cfg.bucket,
        LifecycleConfiguration: {
          Rules: [
            {
              ID: "expire-uploads",
              Status: "Enabled",
              Filter: { Prefix: "uploads/" },
              Expiration: { Days: settings.retentionDays },
            },
          ],
        },
      }),
    );
  }
```
If Task 1 ledgered the `requestChecksumCalculation: "WHEN_REQUIRED"` ruling, add that option to the `S3Client` constructor here, with a one-line comment naming the RGW behaviour it works around.

`src/storage/local.ts` — add `stat` to the `node:fs/promises` import, import the new types, add:

```ts
  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    void contentType;
    const target = this.#pathFor(key);
    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, body);
    } catch {
      throw new ImagegenError("STORAGE_UPLOAD_FAILED", "Failed to write the upload to the artifact directory");
    }
  }

  async headObject(key: string): Promise<{ bytes: number } | null> {
    try {
      const st = await stat(this.#pathFor(key));
      return st.isFile() ? { bytes: st.size } : null;
    } catch {
      return null;
    }
  }

  async presignUpload(): Promise<PresignedUpload> {
    throw new ImagegenError(
      "UNSUPPORTED_FORMAT",
      "Uploading by POST needs S3 storage; send the image inline as data_base64 instead.",
    );
  }

  /** Nothing to configure: uploads on disk are never served and are not expired. */
  async configureUploads(settings: UploadBucketSettings): Promise<void> {
    void settings;
  }
```
`#pathFor` throws on an unsafe key; `headObject` lets that throw propagate only through `stat`'s catch — acceptable because every upload key is built by `uploadKey()`.

`src/artifacts.ts` — in the `/artifacts/*` handler, right after `const key = req.params[0] ?? "";` and the `notFound` helper, add:

```ts
    // Uploads share this directory but stay private, as on S3, where the
    // bucket policy only makes projects/* public.
    if (!key.startsWith("projects/")) {
      notFound();
      return;
    }
```

- [ ] **Step 5: Run them and watch them pass, then the suite and typecheck**

Run the Step 3 command → Expected: all pass.
Run: `npm test > /tmp/claude-1000/t4.log 2>&1; echo rc=$?; grep -E '^# (pass|fail)' /tmp/claude-1000/t4.log` → Expected: `rc=0`, `# fail 0`.
Run: `npm run typecheck > /tmp/claude-1000/tc4.log 2>&1; echo rc=$?` → Expected: `rc=0` (the consumer test's `FakeStorage` is cast `as unknown as ArtifactStore`, so the new methods do not break it).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/storage src/artifacts.ts tests/storage tests/artifacts.test.ts
git commit -m "feat(storage): presigned upload target, put/head, bucket CORS and lifecycle"
```

---

### Task 5: Config and service — `uploadImage`, uploads as references and sources

**Files:**
- Modify: `src/config.ts`, `src/index.ts`, `src/mcp/service.ts`
- Test: `tests/config.test.ts` (extend), `tests/mcp/service.test.ts` (extend), `tests/mcp/server.test.ts` (constructor only)

**Interfaces:**
- Consumes: Task 2 contracts; `inspectUpload`, `decodeInlineUpload`, `UploadInfo` (Task 3); `ArtifactStore` methods (Task 4).
- Produces:
  - `Config.uploads: { corsOrigins: string[]; retentionDays: number }`
  - `ServiceDeps.storage: ArtifactStore` (required); `ServiceConfig.uploadRetentionDays: number`
  - `ImagegenService.uploadImage(raw: Record<string, unknown>): Promise<Record<string, unknown>>` — inline → `{ upload_id, status: "stored", bytes, width, height, format }`; POST → `{ upload_id, status: "pending", expires_at, max_bytes, upload: { method: "POST", url, fields, file_field: "file" } }`
  - `createImage` reads `reference_upload_ids` → `JobPayload.referenceKeys`; `editImage` / `animateImage` read `source_upload_id` → `sourceKey` = upload key, `parentVersion: null`

- [ ] **Step 1: Write the failing tests**

`tests/config.test.ts` — add `"UPLOAD_CORS_ORIGINS", "UPLOAD_RETENTION_DAYS"` to `READ_BY_LOADER`, and add:

```ts
describe("loadConfig uploads", () => {
  test("defaults to any origin and one day", () => {
    assert.deepEqual(loadConfig().uploads, { corsOrigins: ["*"], retentionDays: 1 });
  });

  test("a comma list of origins is split and trimmed", () => {
    process.env.UPLOAD_CORS_ORIGINS = "https://a.example, https://b.example ,";
    assert.deepEqual(loadConfig().uploads.corsOrigins, ["https://a.example", "https://b.example"]);
  });

  test("retention never drops below the one day a bucket lifecycle can express", () => {
    process.env.UPLOAD_RETENTION_DAYS = "0";
    assert.equal(loadConfig().uploads.retentionDays, 1);
    process.env.UPLOAD_RETENTION_DAYS = "7";
    assert.equal(loadConfig().uploads.retentionDays, 7);
  });
});
```

`tests/mcp/service.test.ts` — replace the imports block and `build()` with:

```ts
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

import { ImagegenError, MAX_UPLOAD_BYTES, newUploadId, uploadKey } from "../../src/contracts/index.ts";
import type { ArtifactRef, JobPayload } from "../../src/contracts/index.ts";
import { InMemoryJobQueue, InMemoryJobStore } from "../../src/queue/index.ts";
import { LocalArtifactStore } from "../../src/storage/index.ts";
import type { ArtifactStore, PresignedUpload } from "../../src/storage/index.ts";

import { ImagegenService } from "../../src/mcp/service.ts";

const storageRoot = mkdtempSync(join(tmpdir(), "service-uploads-"));
after(() => rmSync(storageRoot, { recursive: true, force: true }));

function localStore(): LocalArtifactStore {
  return new LocalArtifactStore({ dir: storageRoot, publicBaseUrl: "http://localhost:8080" });
}

function build(
  limits = { createImagePerHour: 100, editImagePerHour: 100 },
  storage: ArtifactStore = localStore(),
) {
  const store = new InMemoryJobStore();
  const queue = new InMemoryJobQueue();
  const service = new ImagegenService({
    store,
    queue,
    storage,
    config: { rateLimit: limits, uploadRetentionDays: 1 },
  });
  return { service, store, queue, storage };
}
```
(Keep every existing helper and test below it unchanged.) Then append:

```ts
const pngBytes = (w = 32, h = 32) =>
  sharp({ create: { width: w, height: h, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } } })
    .png()
    .toBuffer();
const jpegBytes = (w = 40, h = 30) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .jpeg()
    .toBuffer();

async function uploadInline(service: ImagegenService, projectId: string, buf: Buffer): Promise<string> {
  const r = await service.uploadImage({ project_id: projectId, data_base64: buf.toString("base64") });
  return r.upload_id as string;
}

const code = (c: string) => (e: unknown) => e instanceof ImagegenError && e.code === c;

class PresigningStore extends LocalArtifactStore {
  calls: Array<{ key: string; contentType: string; maxBytes: number; ttlSeconds: number }> = [];
  override async presignUpload(
    key: string,
    contentType: string,
    maxBytes: number,
    ttlSeconds: number,
  ): Promise<PresignedUpload> {
    this.calls.push({ key, contentType, maxBytes, ttlSeconds });
    return { url: "https://s3.example/mcp-artifacts", fields: { key, "Content-Type": contentType } };
  }
}

describe("upload_image", () => {
  test("inline data is inspected and stored under the project", async () => {
    const { service, storage } = build();
    const r = await service.uploadImage({ project_id: "p", data_base64: (await pngBytes(32, 24)).toString("base64") });
    assert.equal(r.status, "stored");
    assert.equal(r.width, 32);
    assert.equal(r.height, 24);
    assert.equal(r.format, "png");
    assert.ok(await storage.headObject(uploadKey("p", r.upload_id as string)));
  });

  test("inline data that is not an image is refused and nothing is stored", async () => {
    const { service } = build();
    await assert.rejects(
      service.uploadImage({ project_id: "p", data_base64: Buffer.from("hello").toString("base64") }),
      code("UNSUPPORTED_FORMAT"),
    );
  });

  test("without data the POST target comes from the store, capped and short-lived", async () => {
    const storage = new PresigningStore({ dir: storageRoot, publicBaseUrl: "http://localhost:8080" });
    const { service } = build(undefined, storage);
    const r = await service.uploadImage({ project_id: "p", content_type: "image/jpeg" });
    const upload = r.upload as { method: string; url: string; fields: Record<string, string>; file_field: string };
    assert.equal(r.status, "pending");
    assert.equal(r.max_bytes, MAX_UPLOAD_BYTES);
    assert.equal(upload.method, "POST");
    assert.equal(upload.url, "https://s3.example/mcp-artifacts");
    assert.equal(upload.file_field, "file");
    assert.equal(upload.fields.key, uploadKey("p", r.upload_id as string));
    assert.deepEqual(storage.calls[0], {
      key: uploadKey("p", r.upload_id as string),
      contentType: "image/jpeg",
      maxBytes: MAX_UPLOAD_BYTES,
      ttlSeconds: 900,
    });
    const left = Date.parse(r.expires_at as string) - Date.now();
    assert.ok(left > 890_000 && left <= 900_000);
  });

  test("with neither data nor content_type it says what to send", async () => {
    const { service } = build();
    await assert.rejects(service.uploadImage({ project_id: "p" }), code("UNSUPPORTED_FORMAT"));
  });

  test("on local storage a POST target is refused in favour of inline data", async () => {
    const { service } = build();
    await assert.rejects(
      service.uploadImage({ project_id: "p", content_type: "image/png" }),
      (e: unknown) => code("UNSUPPORTED_FORMAT")(e) && /data_base64/.test((e as Error).message),
    );
  });
});

describe("using an upload", () => {
  const create = (projectId: string, refs: string[]) => ({
    project_id: projectId, asset_id: "hero", description: "a cloud", reference_upload_ids: refs,
  });

  test("create_image carries each reference once, in order", async () => {
    const { service, queue } = build();
    const a = await uploadInline(service, "p", await pngBytes());
    const b = await uploadInline(service, "p", await jpegBytes());
    await service.createImage(create("p", [a, b, a]), "u");
    const p = (await queue.dequeue(1000))!;
    assert.deepEqual(p.referenceKeys, [uploadKey("p", a), uploadKey("p", b)]);
  });

  test("a create without references keeps the payload as before", async () => {
    const { service, queue } = build();
    await service.createImage({ project_id: "p", asset_id: "hero", description: "x" }, "u");
    assert.equal("referenceKeys" in (await queue.dequeue(1000))!, false);
  });

  test("an unknown, malformed or other-project upload is UPLOAD_NOT_FOUND and nothing is queued", async () => {
    const { service, queue } = build();
    const elsewhere = await uploadInline(service, "p1", await pngBytes());
    for (const id of [newUploadId(), "../etc/passwd", elsewhere]) {
      await assert.rejects(service.createImage(create("p2", [id]), "u"), code("UPLOAD_NOT_FOUND"), id);
    }
    assert.equal(await queue.depth(), 0);
  });

  test("an upload whose bytes are not an image is refused at submit", async () => {
    const { service, storage } = build();
    const id = newUploadId();
    await storage.putObject(uploadKey("p", id), Buffer.from("junk"), "image/png");
    await assert.rejects(service.createImage(create("p", [id]), "u"), code("UNSUPPORTED_FORMAT"));
  });

  test("edit_image from an upload starts the asset at v1 with no parent", async () => {
    const { service, queue, store } = build();
    const id = await uploadInline(service, "p", await jpegBytes(40, 30));
    const h = await service.editImage(
      { project_id: "p", asset_id: "logo", source_upload_id: id, instructions: "make it blue" },
      "u",
    );
    const p = (await queue.dequeue(1000))!;
    assert.equal(p.kind, "edit");
    assert.equal(p.version, 1);
    assert.equal(p.parentVersion, null);
    assert.equal(p.sourceKey, uploadKey("p", id));
    assert.equal(p.spec.width, 40);
    assert.equal(p.spec.height, 30);
    assert.equal(p.spec.outputFormat, "png", "a JPEG source is edited into PNG");
    assert.equal(p.spec.transparentBackground, false, "no alpha in the upload");
    assert.equal((await store.get(h.job_id))!.parentVersion, null);
  });

  test("source_upload_id and source_version together are refused", async () => {
    const { service } = build();
    const id = await uploadInline(service, "p", await pngBytes());
    await assert.rejects(
      service.editImage({ project_id: "p", asset_id: "a", source_upload_id: id, source_version: 1, instructions: "x" }, "u"),
      code("UNSUPPORTED_FORMAT"),
    );
  });

  test("animate_image from an upload points the worker at the upload", async () => {
    const { service, queue } = build();
    const id = await uploadInline(service, "p", await pngBytes(48, 32));
    await service.animateImage({ project_id: "p", asset_id: "badge", source_upload_id: id, motion: "pulse" }, "u");
    const p = (await queue.dequeue(1000))!;
    assert.equal(p.kind, "animate");
    assert.equal(p.parentVersion, null);
    assert.equal(p.sourceKey, uploadKey("p", id));
    assert.equal(p.spec.width, 48);
    assert.equal(p.spec.transparentBackground, true);
  });
});
```

`tests/mcp/server.test.ts` — the constructor must satisfy the new required deps. Add imports `import { mkdtemp, rm } from "node:fs/promises"; import { tmpdir } from "node:os"; import { join } from "node:path"; import { LocalArtifactStore } from "../../src/storage/index.ts";`, a module-level `let root: string;`, and in `before`:

```ts
  root = await mkdtemp(join(tmpdir(), "mcp-route-test-"));
  const service = new ImagegenService({
    store: new InMemoryJobStore(),
    queue: new InMemoryJobQueue(),
    storage: new LocalArtifactStore({ dir: root, publicBaseUrl: "http://localhost:8080" }),
    config: { rateLimit: { createImagePerHour: 0, editImagePerHour: 0 }, uploadRetentionDays: 1 },
  });
```
and in `after`, after closing the server: `await rm(root, { recursive: true, force: true });`

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test --experimental-strip-types --disable-warning=ExperimentalWarning tests/config.test.ts tests/mcp/service.test.ts`
Expected: FAIL — `loadConfig().uploads` is undefined; `service.uploadImage is not a function`.

- [ ] **Step 3: Implement config**

`src/config.ts` — add to `Config` after `storage`: `uploads: { corsOrigins: string[]; retentionDays: number };` and in the returned object after `storage,`:

```ts
    uploads: {
      // The signed POST policy is the credential; CORS only decides which
      // pages may send it, so any origin is the default.
      corsOrigins: str("UPLOAD_CORS_ORIGINS", "*")
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean),
      // A bucket lifecycle rule counts whole days, one at least.
      retentionDays: Math.max(1, int("UPLOAD_RETENTION_DAYS", 1)),
    },
```

- [ ] **Step 4: Implement the service**

`src/mcp/service.ts`:
- imports: add to the contracts value import `MAX_UPLOAD_BYTES, UPLOAD_TTL_SECONDS, newUploadId, uploadKey`; add to the type import `UploadContentType`; add

```ts
import type { ArtifactStore } from "../storage/index.ts";
import { decodeInlineUpload, inspectUpload } from "../uploads.ts";
import type { UploadInfo } from "../uploads.ts";
```
- `ServiceConfig` gains `uploadRetentionDays: number;` ; `ServiceDeps` gains `storage: ArtifactStore;` ; the class gains `#storage: ArtifactStore;` set in the constructor.
- Update the file header's "NEARLY STATELESS" paragraph: replace "It only: validates input, normalizes the image spec, writes a job record, pushes work onto the queue, and then reads status back out." with "It only: validates input (including the bytes of uploaded images), normalizes the image spec, writes a job record, pushes work onto the queue, and then reads status back out."
- Add above `#stillSource`:

```ts
/** What an edit or an animation starts from: a version of the asset or an upload. */
interface StillSource {
  key: string;
  width: number;
  height: number;
  transparent: boolean;
  format: OutputFormat;
  /** Null for an upload: it is not a version of the asset. */
  parentVersion: number | null;
}
```
(place this interface at module level, next to `JobHandle`.)

- New methods in the class (after `animateImage`):

```ts
  // ---------------------------------------------------------------
  // upload_image — the client's own image, for the other tools to use
  // ---------------------------------------------------------------
  async uploadImage(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const projectId = sanitizeIdentifier(raw.project_id, "project");
    const uploadId = newUploadId();
    const key = uploadKey(projectId, uploadId);

    if (raw.data_base64 !== undefined) {
      const body = decodeInlineUpload(String(raw.data_base64));
      const info = await inspectUpload(body);
      await this.#storage.putObject(key, body, `image/${info.format}`);
      return {
        upload_id: uploadId,
        status: "stored",
        bytes: info.bytes,
        width: info.width,
        height: info.height,
        format: info.format,
      };
    }

    const contentType = raw.content_type as UploadContentType | undefined;
    if (contentType === undefined) {
      throw new ImagegenError(
        "UNSUPPORTED_FORMAT",
        "Pass content_type to get a POST target, or send the image inline as data_base64.",
      );
    }
    const target = await this.#storage.presignUpload(key, contentType, MAX_UPLOAD_BYTES, UPLOAD_TTL_SECONDS);
    return {
      upload_id: uploadId,
      status: "pending",
      expires_at: new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000).toISOString(),
      max_bytes: MAX_UPLOAD_BYTES,
      upload: { method: "POST", url: target.url, fields: target.fields, file_field: "file" },
    };
  }

  /**
   * Looks an upload up and inspects its bytes, so a missing or bad file
   * fails the tool call instead of a queued job.
   */
  async #upload(projectId: string, uploadId: string): Promise<{ key: string; info: UploadInfo }> {
    const key = uploadKey(projectId, uploadId);
    if (!(await this.#storage.headObject(key))) {
      throw new ImagegenError(
        "UPLOAD_NOT_FOUND",
        `No upload ${uploadId} in project ${projectId}: its POST has not finished, it belongs to ` +
          `another project, or it expired (uploads are kept ${this.#cfg.uploadRetentionDays} day(s)).`,
      );
    }
    return { key, info: await inspectUpload(await this.#storage.download(key)) };
  }

  async #source(projectId: string, assetId: string, raw: Record<string, unknown>): Promise<StillSource> {
    const version = raw.source_version as number | undefined;
    const uploadId = raw.source_upload_id as string | undefined;
    if (uploadId !== undefined) {
      if (version !== undefined) {
        throw new ImagegenError("UNSUPPORTED_FORMAT", "Pass source_version or source_upload_id, not both.");
      }
      const { key, info } = await this.#upload(projectId, uploadId);
      return {
        key,
        width: info.width,
        height: info.height,
        transparent: info.hasAlpha,
        format: info.format === "webp" ? "webp" : "png",
        parentVersion: null,
      };
    }
    const src = await this.#stillSource(projectId, assetId, version);
    return {
      key: src.key,
      width: src.width,
      height: src.height,
      transparent: src.transparent,
      format: src.mimeType === "image/webp" ? "webp" : "png",
      parentVersion: src.version,
    };
  }
```

- `createImage`: after the `compIn` line and before `const spec`, add

```ts
    const referenceKeys: string[] = [];
    for (const id of new Set((raw.reference_upload_ids as string[] | undefined) ?? [])) {
      referenceKeys.push((await this.#upload(projectId, id)).key);
    }
```
and in its `enqueue({...})` add the last property `...(referenceKeys.length > 0 ? { referenceKeys } : {}),`.

- `editImage`: delete `const sourceVersion = …` and replace `const src = await this.#stillSource(projectId, assetId, sourceVersion); const outputFormat … ;` with

```ts
    const src = await this.#source(projectId, assetId, raw);
    const outputFormat = src.format;
```
then change `this.#newRecord(jobId, spec, version, src.version, principal)` → `this.#newRecord(jobId, spec, version, src.parentVersion, principal)` and in the payload `parentVersion: src.version` → `parentVersion: src.parentVersion`. (`sourceKey: src.key`, `width: src.width`, `height: src.height`, `src.transparent` already match the new shape.)

- `animateImage`: replace `const src = await this.#stillSource(projectId, assetId, raw.source_version as number | undefined);` with `const src = await this.#source(projectId, assetId, raw);` and both `src.version` uses with `src.parentVersion`.

- [ ] **Step 5: Wire it in `src/index.ts`**

Replace the service construction inside `if (servesMcp) { … }` with:

```ts
  const service = new ImagegenService({
    store,
    queue,
    storage,
    config: { rateLimit: config.mcp.rateLimit, uploadRetentionDays: config.uploads.retentionDays },
  });
  mountMcp(app, { service });
  if (config.storage.kind === "local") mountArtifacts(app, config.storage.dir);
  // Not awaited: uploads are a side door, and a bucket that refuses CORS
  // or lifecycle must not keep the MCP endpoint from starting.
  void storage
    .configureUploads(config.uploads)
    .catch((e: unknown) => log.warn("could not configure the bucket for uploads", { error: (e as Error).message }));
```

- [ ] **Step 6: Run them and watch them pass, then the suite and typecheck**

Run the Step 2 command → Expected: all pass.
Run: `npm test > /tmp/claude-1000/t5.log 2>&1; echo rc=$?; grep -E '^# (pass|fail)' /tmp/claude-1000/t5.log` → Expected: `rc=0`, `# fail 0`.
Run: `npm run typecheck > /tmp/claude-1000/tc5.log 2>&1; echo rc=$?; head -20 /tmp/claude-1000/tc5.log` → Expected: `rc=0`.

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/index.ts src/mcp/service.ts tests/config.test.ts tests/mcp/service.test.ts tests/mcp/server.test.ts
git commit -m "feat(mcp): accept uploads as references and as edit/animate sources"
```

---

### Task 6: Register `upload_image` and tell the other tools about uploads

**Files:**
- Modify: `src/mcp/server.ts`, `src/contracts/schemas.ts` (`PUBLIC_TOOLS`)
- Test: `tests/mcp/server.test.ts` (extend)

**Interfaces:**
- Consumes: `uploadImageSchema` (Task 2), `ImagegenService.uploadImage` (Task 5).
- Produces: tool `upload_image` over `/mcp`; `PUBLIC_TOOLS` has 7 names.

- [ ] **Step 1: Write the failing tests** — append to `tests/mcp/server.test.ts` (add `import sharp from "sharp";` to the imports):

```ts
async function callTool(name: string, args: Record<string, unknown>) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }),
  });
  assert.equal(res.status, 200);
  const data = (await res.text()).split("\n").find((l) => l.startsWith("data: "));
  assert.ok(data, "an SSE data line");
  return JSON.parse(data.slice("data: ".length)).result as { content: { text: string }[]; isError?: boolean };
}

test("upload_image takes an image type or inline data, and needs a project", async () => {
  const tool = (await listTools()).find((t) => t.name === "upload_image");
  assert.ok(tool, "upload_image is registered");
  assert.deepEqual(tool.inputSchema.required, ["project_id"]);
  assert.deepEqual(tool.inputSchema.properties.content_type?.enum, ["image/png", "image/jpeg", "image/webp"]);
  assert.ok("data_base64" in tool.inputSchema.properties);
});

test("the tools that consume an upload accept its id", async () => {
  const tools = await listTools();
  const props = (n: string) => tools.find((t) => t.name === n)!.inputSchema.properties;
  assert.ok("reference_upload_ids" in props("create_image"));
  assert.ok("source_upload_id" in props("edit_image"));
  assert.ok("source_upload_id" in props("animate_image"));
});

test("upload_image explains the POST: fields first, the file last", async () => {
  const listed = (await listTools()) as unknown as { name: string; description: string }[];
  const d = listed.find((t) => t.name === "upload_image")!.description;
  assert.match(d, /multipart\/form-data/);
  assert.match(d, /fields.*first/i);
  assert.match(d, /file last|last.*file/i);
  assert.match(d, /204/);
});

test("an inline upload over the real route comes back stored", async () => {
  const png = await sharp({ create: { width: 20, height: 20, channels: 4, background: "#36c" } }).png().toBuffer();
  const r = await callTool("upload_image", { project_id: "p", data_base64: png.toString("base64") });
  assert.notEqual(r.isError, true);
  const body = JSON.parse(r.content[0]!.text) as { status: string; upload_id: string };
  assert.equal(body.status, "stored");
  assert.match(body.upload_id, /^upl_[0-9a-f]{32}$/);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test --experimental-strip-types --disable-warning=ExperimentalWarning tests/mcp/server.test.ts`
Expected: FAIL — `upload_image is registered` fails; the tools/call returns an error result for an unknown tool.

- [ ] **Step 3: Implement**

`src/contracts/schemas.ts` — `PUBLIC_TOOLS`: change the doc comment to `/** Names of the 7 tools Claude Design gets to see. */` and add `"upload_image",` after `"animate_image",`.

`src/mcp/server.ts` — import `uploadImageSchema` with the other schemas; register right after `create_image`:

```ts
  server.registerTool(
    "upload_image",
    {
      title: "Upload your own image",
      description:
        "Stores an image of YOUR OWN (a logo, a photo, a sketch) so the other " +
        "tools can use it: pass the returned upload_id to create_image " +
        "(reference_upload_ids: Codex looks at it while drawing), edit_image " +
        "(source_upload_id) or animate_image (source_upload_id).\n\n" +
        "Two ways in:\n" +
        "1. Small image: send data_base64 (raw base64 or a data: URI, at most " +
        "700 KB decoded). It is stored at once.\n" +
        "2. Up to 20 MB: send only content_type. You get upload.url and " +
        "upload.fields. POST to upload.url as multipart/form-data with every " +
        "entry of upload.fields first, in order, and the file last under the " +
        "field name in upload.file_field. A 204 response means it is stored. " +
        "The POST target expires after 15 minutes.\n\n" +
        "Accepted: PNG, JPEG or WebP, a still image, 16-4096 px per side. " +
        "Uploads are private and deleted automatically after about a day.",
      inputSchema: uploadImageSchema,
    },
    async (args) => {
      try {
        return ok(await service.uploadImage(args as Record<string, unknown>));
      } catch (e) {
        return fail(e);
      }
    },
  );
```
Append one sentence to each existing description string:
- `create_image`: `"\n\nTo draw from an image of your own, upload it with upload_image and pass reference_upload_ids."`
- `edit_image`: `" To edit an image of your own instead, upload it with upload_image and pass source_upload_id."`
- `animate_image`: `" To animate an image of your own, upload it with upload_image and pass source_upload_id."`

- [ ] **Step 4: Run them and watch them pass, then the suite**

Run the Step 2 command → Expected: all pass (including the existing "exposes exactly the public tools").
Run: `npm test > /tmp/claude-1000/t6.log 2>&1; echo rc=$?; grep -E '^# (pass|fail)' /tmp/claude-1000/t6.log` → Expected: `rc=0`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts src/contracts/schemas.ts tests/mcp/server.test.ts
git commit -m "feat(mcp): upload_image tool"
```

---

### Task 7: Worker — reference files, upright upload sources, expired uploads

**Files:**
- Modify: `src/worker/prompt.ts` (`buildCreatePrompt` gains `references`)
- Modify: `src/worker/consumer.ts`
- Test: `tests/worker/consumer.test.ts` (extend)

**Interfaces:**
- Consumes: `JobPayload.referenceKeys`, `isUploadKey` (Task 2); `normaliseUpload` (Task 3).
- Produces: `buildCreatePrompt(spec: ImageSpec, outputDir: string, references: readonly string[] = []): string`; job folder files `reference-<n>.png`; failure code `UPLOAD_NOT_FOUND` when an upload is gone at run time.

- [ ] **Step 1: Write the failing tests** — append to `tests/worker/consumer.test.ts` (it already imports `sharp`, `readdir`/`join` if not, add `readdir` to the `node:fs/promises` import):

```ts
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
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test --experimental-strip-types --disable-warning=ExperimentalWarning tests/worker/consumer.test.ts`
Expected: FAIL — no `reference-1.png` in the job folder; the edit source is 40x20 JPEG bytes named `.png`; the expired-upload job fails with a different code.

- [ ] **Step 3: Implement**

`src/worker/prompt.ts` — change the signature to `export function buildCreatePrompt(spec: ImageSpec, outputDir: string, references: readonly string[] = []): string` and, right after the `if (spec.stylePrompt) { … }` block, add:

```ts
  if (references.length > 0) {
    lines.push(
      "",
      "Reference images (already in the working directory; look at them before drawing):",
      ...references.map((r) => `${outputDir}/${r}`),
      "Use them as visual reference for the subject and style. Do not copy text, logos or " +
        "watermarks from them unless the description asks for it.",
    );
  }
```

`src/worker/consumer.ts`:
- imports: add `isUploadKey` to the contracts value import, `OutputFormat` to the contracts type import, and `import { normaliseUpload } from "../uploads.ts";`
- replace the edit/create prompt block with:

```ts
      let prompt: string;
      if (payload.kind === "edit") {
        const sourceFilename = `source.${spec.outputFormat}`;
        const buf = await this.#input(payload.sourceKey!, spec.outputFormat);
        await writeFile(join(jobDir, sourceFilename), buf, { mode: 0o600 });
        prompt = buildEditPrompt(spec, payload.instructions ?? "", sourceFilename, jobDir);
      } else {
        const references = await this.#writeReferences(payload.referenceKeys ?? [], jobDir);
        prompt = buildCreatePrompt(spec, jobDir, references);
      }
```
- in `#animate`, replace `const source = await this.#storage.download(payload.sourceKey!);` with `const source = await this.#input(payload.sourceKey!, "png");`
- add these private methods next to `#animate`:

```ts
  /**
   * A job's input image. Uploads come from clients, so they are turned
   * upright and stripped of metadata; artifacts are the worker's own
   * output and are used as stored.
   */
  async #input(key: string, format: OutputFormat): Promise<Buffer> {
    if (!isUploadKey(key)) return this.#storage.download(key);
    let buf: Buffer;
    try {
      buf = await this.#storage.download(key);
    } catch {
      // A long queue can outlive the upload's retention window.
      throw new ImagegenError("UPLOAD_NOT_FOUND", "The uploaded image expired before the job ran; upload it again.");
    }
    return normaliseUpload(buf, format);
  }

  async #writeReferences(keys: readonly string[], jobDir: string): Promise<string[]> {
    const names: string[] = [];
    for (const [i, key] of keys.entries()) {
      const name = `reference-${i + 1}.png`;
      await writeFile(join(jobDir, name), await this.#input(key, "png"), { mode: 0o600 });
      names.push(name);
    }
    return names;
  }
```

- [ ] **Step 4: Run them and watch them pass, then the suite and typecheck**

Run the Step 2 command → Expected: all pass.
Run: `npm test > /tmp/claude-1000/t7.log 2>&1; echo rc=$?; grep -E '^# (pass|fail)' /tmp/claude-1000/t7.log` → Expected: `rc=0`, `# fail 0`.
Run: `npm run typecheck > /tmp/claude-1000/tc7.log 2>&1; echo rc=$?` → Expected: `rc=0`.

- [ ] **Step 5: Commit**

```bash
git add src/worker/prompt.ts src/worker/consumer.ts tests/worker/consumer.test.ts
git commit -m "feat(worker): reference images and upright upload sources"
```

---

### Task 8: Docs, chart and version 0.8.0

**Files:**
- Modify: `README.md`, `docs/architecture.md`, `docs/configuration.md`
- Modify: `charts/codex-imagegen-mcp/{Chart.yaml,values.yaml,README.md,templates/_helpers.tpl}`
- Modify: `package.json`, `package-lock.json` (version), `src/version.ts`
- Modify: `docs/superpowers/specs/2026-10-29-image-upload-design.md` (status line)

- [ ] **Step 1: Tool tables** — in `README.md` and `docs/architecture.md`, add after the `animate_image` row:

```markdown
| `upload_image` | Stores an image of your own for the other tools: inline base64 up to 700 KB, or a presigned POST target for up to 20 MB. Pass the `upload_id` as `reference_upload_ids` to `create_image`, or as `source_upload_id` to `edit_image` / `animate_image`. Private; deleted after a day by default. |
```
Then run `rg -n "does not (touch|read|write)|never (touches|reads|writes).*(storage|bucket)|only Redis" README.md docs/` and correct any sentence that says the MCP role never touches object storage: since 0.8.0 it presigns, inspects and writes uploads.

- [ ] **Step 2: Configuration** — in `docs/configuration.md`, in the "The endpoint" table after `RATE_LIMIT_EDIT_IMAGE_PER_HOUR`:

```markdown
| `UPLOAD_CORS_ORIGINS` | `*` | Comma-separated origins allowed to POST an upload from a browser. The signed POST policy is the credential; this only limits which pages may send it. |
| `UPLOAD_RETENTION_DAYS` | `1` | Days before the bucket deletes `uploads/`. Applied as a lifecycle rule at startup; at least 1. |
```
and one paragraph below the table:

```markdown
With S3 storage the MCP role needs the bucket credentials too: it presigns
upload targets, writes inline uploads and inspects every upload before a job
is queued. At startup it sets the bucket's CORS and lifecycle rules,
replacing any that were there.
```

- [ ] **Step 3: Chart** — `charts/codex-imagegen-mcp/values.yaml`, after the `rateLimit:` block:

```yaml
# upload_image: browser origins allowed to POST, and days before uploads/ is deleted.
uploads:
  corsOrigins: "*"
  retentionDays: 1
```
`templates/_helpers.tpl`, inside `{{- if ne $role "worker" }}` after `RATE_LIMIT_EDIT_IMAGE_PER_HOUR`:

```yaml
- name: UPLOAD_CORS_ORIGINS
  value: {{ $.Values.uploads.corsOrigins | quote }}
- name: UPLOAD_RETENTION_DAYS
  value: {{ $.Values.uploads.retentionDays | quote }}
```
`README.md` of the chart, after the `rateLimit.*` row:

```markdown
| `uploads.*` | `*`, 1 day | `upload_image`: origins allowed to POST from a browser, and days before uploads are deleted. |
```
`Chart.yaml`: `version: 0.4.0`, `appVersion: "0.8.0"`.

- [ ] **Step 4: Version** — `npm version 0.8.0 --no-git-tag-version > /dev/null` and set `export const VERSION = "0.8.0";` in `src/version.ts`. In the spec, change `Status: draft for review.` to `Status: approved design, implemented in 0.8.0.`

- [ ] **Step 5: Verify**

```bash
npm test > /tmp/claude-1000/t8.log 2>&1; echo rc=$?; grep -E '^# (pass|fail)' /tmp/claude-1000/t8.log
npm run typecheck > /tmp/claude-1000/tc8.log 2>&1; echo rc=$?
helm lint charts/codex-imagegen-mcp > /dev/null && echo lint-ok
helm template x charts/codex-imagegen-mcp --set s3.endpoint=http://s3 --set s3.bucket=b --set s3.publicBaseUrl=https://p/b | grep -c 'UPLOAD_'
```
Expected: `rc=0` / `# fail 0`; `rc=0`; `lint-ok`; a count ≥ 2 (the MCP deployment carries both variables; the worker carries neither). If the template needs other required values to render, add them with `--set` rather than changing the chart.

- [ ] **Step 6: Commit**

```bash
git add README.md docs charts package.json package-lock.json src/version.ts
git commit -m "docs: upload_image, its settings, and 0.8.0"
```

---

### Task 9: Release and roll out (needs the human partner's go-ahead after the branch is merged)

Runs only after `sdd-orca:finishing-a-development-branch` merged `feat/image-upload` into `main` and the human partner approved the release. Pushing, tagging and GitOps commits are outward-facing.

**Files (dc-fpt-argocd-platform):**
- Modify: `custom-applications/imagegen-mcp/values.yaml` (both `tag:` → `"0.8.0"`, `imagegen.uploads`)
- Modify: `custom-applications/imagegen-mcp/Chart.yaml` (`appVersion: "0.8.0"`)
- Modify: `custom-applications/imagegen-mcp/templates/imagegen-mcp.yaml` (bucket Secret, `UPLOAD_*` env, comment)
- Modify: `custom-applications/imagegen-mcp/templates/networkpolicy.yaml` (MCP egress to RGW, comment)
- Modify (second commit): `custom-applications/agentgateway/values.yaml` (four allowlists)

- [ ] **Step 1: Publish v0.8.0**

```bash
cd ~/Workspace/codex-imagegen-mcp
git log @{u}.. --format=%B | grep -ciE 'co-authored-by|claude-session'   # must print 0
git push -q origin main && git tag v0.8.0 && git push -q origin v0.8.0
gh run list --workflow publish --limit 1 --json databaseId -q '.[0].databaseId'
```
Then `gh run watch <id> --exit-status` in the background and wait for its notification; afterwards `gh release view v0.8.0 --json url -q .url` and `docker manifest inspect ghcr.io/tinyorbitvn/codex-imagegen-mcp:0.8.0 > /dev/null && echo image-ok`.
Expected: run succeeded, a Release URL, `image-ok`.

- [ ] **Step 2: GitOps commit 1 — image, credentials, env, egress**

In `custom-applications/imagegen-mcp/values.yaml`: both `tag: "0.7.0"` → `tag: "0.8.0"`; under `imagegen:`, after its `rateLimit:` block:

```yaml
  # upload_image (0.8.0): ảnh tạm ở uploads/ bị lifecycle bucket xoá sau N ngày; CORS "*" vì chữ ký POST mới là khoá.
  uploads:
    corsOrigins: "*"
    retentionDays: 1
```
`Chart.yaml`: `appVersion: "0.8.0"`.

`templates/imagegen-mcp.yaml`: replace the 3-line comment above `{{- include "imagegen-mcp.storageEnv" . | nindent 12 }}` with

```yaml
            # Từ 0.8.0 vai `mcp` ký URL POST cho upload_image, ghi ảnh inline và đọc ảnh upload để kiểm
            # trước khi xếp việc — nên cần khoá bucket như worker.
```
add before that include:

```yaml
            - name: UPLOAD_CORS_ORIGINS
              value: {{ $ig.uploads.corsOrigins | quote }}
            - name: UPLOAD_RETENTION_DAYS
              value: {{ $ig.uploads.retentionDays | quote }}
```
and right after the include (same indentation as `env:`):

```yaml
          envFrom:
            - secretRef:
                name: {{ .Values.storage.existingSecret }}
                optional: true
```
`templates/networkpolicy.yaml`, MCP egress: replace the header comment with
`# Egress của imagegen-mcp: Redis, OTLP, và RGW từ 0.8.0 (ký/kiểm ảnh upload). Không ra Internet, không gọi Keycloak.`
and append to its `egress:` list:

```yaml
    # RGW chạy hostNetwork nên chỉ khai `ports`, bỏ trống `to` — lý do ở egress của worker bên dưới.
    - ports:
        - { protocol: TCP, port: 80 }
```

Verify, commit, push:

```bash
cd ~/Workspace/dc-fpt-argocd-platform
helm template imagegen-mcp custom-applications/imagegen-mcp -n mcp-system > /tmp/claude-1000/ig.yaml; echo rc=$?
grep -E 'image: .*codex-imagegen' /tmp/claude-1000/ig.yaml | sort | uniq -c        # 2 × :0.8.0
grep -c 'UPLOAD_' /tmp/claude-1000/ig.yaml                                          # 2
git status --porcelain | grep -E 'Chart.lock|charts/'                               # nothing
git add custom-applications/imagegen-mcp
git commit -q -m "feat(imagegen-mcp): nâng 0.8.0 — tool upload_image (ảnh tự đưa vào làm tham chiếu/nguồn)"
git log -1 --format=%B | grep -ciE 'co-authored-by|claude-session'                  # 0
git push -q
```

- [ ] **Step 3: Wait for both Deployments on 0.8.0**

Run with Bash `run_in_background: true` and wait for the notification:

```bash
export KUBECONFIG=~/Workspace/RKE2/playbooks/kubeconfig
kubectl -n argocd annotate application imagegen-mcp argocd.argoproj.io/refresh=normal --overwrite > /dev/null
for i in $(seq 1 60); do
  out=$(kubectl -n mcp-system get deploy -o json | jq -r '.items[]
    | select(.spec.template.spec.containers[0].image | test("codex-imagegen"))
    | "\(.metadata.name) \(.spec.template.spec.containers[0].image | split(":")[1]) \(.status.updatedReplicas // 0)/\(.spec.replicas) unavail=\(.status.unavailableReplicas // 0)"')
  n=$(echo "$out" | grep -c ' 0.8.0 ')
  bad=$(echo "$out" | awk '{split($3,a,"/"); if (a[1]!=a[2] || $4!="unavail=0") print}' | wc -l)
  [ "$n" -ge 2 ] && [ "$bad" -eq 0 ] && { echo "ROLLED t=$((i*15))s"; break; }
  sleep 15
done
echo "$out"; kubectl -n argocd get application imagegen-mcp -o jsonpath='{.status.sync.status}/{.status.health.status}{"\n"}'
```
Expected: `ROLLED`, both lines on `0.8.0`, `Synced/Healthy`. Then:

```bash
kubectl -n mcp-system logs deploy/imagegen-mcp --since=10m | grep -c 'could not configure the bucket'   # 0
```
Re-run the Task 1 spike without `--apply` (read-only): `before.cors` and `before.lifecycle` must now show the service's own rules.

- [ ] **Step 4: GitOps commit 2 — open the tool at the gateway**

```bash
f=custom-applications/agentgateway/values.yaml
sed -i 's/"cancel_image_job"\]/"cancel_image_job", "upload_image"]/g' $f
grep -c '"upload_image"' $f        # must print 4
```
Validate the rendered gateway config with the gateway's own binary (`helm template` does not check the config tree). The dependency update happens in a scratch copy so no `Chart.lock` or `charts/` lands in the repo:

```bash
S=/tmp/claude-1000/agw-0.8; rm -rf $S && mkdir -p $S && cp -r custom-applications/agentgateway $S/c
helm dependency update $S/c > /dev/null 2>&1 && helm template agentgateway $S/c -n mcp-system > $S/r.yaml; echo render=$?
python3 -I - "$S" <<'EOF'
import sys, yaml
S = sys.argv[1]
for d in yaml.safe_load_all(open(S + "/r.yaml")):
    if not d: continue
    if d["kind"] == "ConfigMap" and "config.yaml" in (d.get("data") or {}):
        open(S + "/config.yaml", "w").write(d["data"]["config.yaml"])
    if d["kind"] == "Deployment":
        for c in d["spec"]["template"]["spec"]["containers"]:
            if "agentgateway" in c["image"]: open(S + "/image", "w").write(c["image"])
EOF
docker run --rm -v $S/config.yaml:/cfg.yaml:ro -e OIDC_CLIENT_SECRET=x -e AGW_DB_PASSWORD=x \
  -e OIDC_COOKIE_SECRET=$(openssl rand -hex 32) "$(cat $S/image)" -f /cfg.yaml --validate-only 2>&1 | tail -1
```
Expected: `render=0`, then `Configuration is valid!`. Then:

```bash
git status --porcelain | grep -E 'Chart.lock|charts/'      # nothing
git add $f && git commit -q -m "feat(agentgateway): mở allowlist cho upload_image" && git push -q
```
Wait for ArgoCD sync (all apps Synced/Healthy at the new revision).

- [ ] **Step 5: Live check** (through the session's `tinyorbit-imagegen` MCP tools once `upload_image` appears; if the session has not picked up the new tool list, port-forward `svc/imagegen-mcp` and call `/mcp` with JSON-RPC `tools/call`):

1. `upload_image` inline with a 64 px PNG made by sharp → `status: "stored"`.
2. `upload_image` with `content_type: "image/png"` → POST the target with `curl` (`-F` for every field in order, then `-F file=@icon.png`) → HTTP 204. A second target POSTed with a 21 MB file → 400 `EntityTooLarge`.
3. `curl -si -X OPTIONS https://s3.tinyorbit.vn/mcp-artifacts -H 'Origin: https://claude.ai' -H 'Access-Control-Request-Method: POST'` → 200 with `Access-Control-Allow-Origin`.
4. `curl -s -o /dev/null -w '%{http_code}' https://s3.tinyorbit.vn/mcp-artifacts/uploads/<project>/<id>` → 403.
5. `animate_image` with `source_upload_id` from (2), motion `spin` → completed; look at one frame.
6. `create_image` with `reference_upload_ids: [<id from 2>]` and a description that names the referenced object → completed (uses **one** ChatGPT quota unit); look at the result.
7. Tell the human partner: verify on 2026-10-31 that the uploads from this check are gone (lifecycle runs daily); and reconnect their MCP client to see `upload_image`.
