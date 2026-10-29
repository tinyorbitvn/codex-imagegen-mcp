# upload_image: let a client hand the server its own image

Date: 2026-10-29. Status: approved design, implemented in 0.8.0.

## Goal

Let an MCP client give the server an image of its own (a logo, a photo, a
sketch) and then use it in three ways:

- as a **reference** for `create_image`: Codex draws a new image while looking
  at it;
- as the **source** of `edit_image`: Codex edits the uploaded image;
- as the **source** of `animate_image`: the uploaded still is animated.

The first client is Claude Design. It keeps images the user pastes in an
`upload/` folder, has no shell, and is expected to work out on its own how to
call the upload tool. This spec covers the server only; nothing is built on the
Claude Design side.

## Why the bytes do not travel inside a tool call

A model sees a pasted image but cannot copy its bytes into a tool argument, and
MCP has no file-input primitive yet (SEP-2356 and SEP-2631 are drafts). So the
main path is a **presigned S3 POST**: the tool returns a URL and form fields, and
whatever on the client side can make an HTTP request (a preview page's
JavaScript, a shell, a script) sends the file straight to the bucket. A second,
inline path takes base64 in the tool call itself, for clients that can produce
it and for images small enough to fit the 1 MB `/mcp` body limit.

## Success criteria

- `upload_image` without data returns a POST target that accepts a PNG, JPEG
  or WebP of up to 20 MB from a browser on another origin (CORS) and from
  `curl`, and rejects a larger file at S3 itself.
- `upload_image` with `data_base64` stores the image in one call.
- An uploaded image can be passed to `create_image`, `edit_image` and
  `animate_image` by its `upload_id`, and the result is an ordinary artifact.
- A bad upload (not an image, animated, too large, unknown or expired id) is
  refused when the job is **submitted**, with a message that names the reason,
  not halfway through a Codex run.
- Uploads are not publicly readable and are deleted by the bucket after
  `UPLOAD_RETENTION_DAYS` (default 1).

## Non-goals

- Anything on the Claude Design side (helper pages, instructions in its
  project). The tool description is the only guidance it gets.
- Fetching an image from an arbitrary URL (SSRF exposure, not needed now).
- Keeping uploads as artifacts or listing them. An upload lives only as long as
  the retention window.
- Non-image files.

## The tool: `upload_image`

Input:

| Field | Type | Notes |
|---|---|---|
| `project_id` | string | Same rules as the other tools. The upload is usable only inside this project. |
| `content_type` | `image/png` \| `image/jpeg` \| `image/webp` | Required for the POST path (it goes into the signed policy); ignored for inline data, where the bytes are sniffed. |
| `data_base64` | string, optional | Inline path. Raw base64 or a `data:` URI. At most 700 KB decoded, so the request stays under the 1 MB body limit. |

Output, POST path (no `data_base64`):

```json
{
  "upload_id": "upl_3f0c…",
  "status": "pending",
  "expires_at": "2026-10-29T10:15:00.000Z",
  "max_bytes": 20971520,
  "upload": {
    "method": "POST",
    "url": "https://s3.tinyorbit.vn/mcp-artifacts",
    "fields": { "key": "uploads/p/upl_3f0c…", "Content-Type": "image/png", "Policy": "…", "X-Amz-Signature": "…" },
    "file_field": "file"
  }
}
```

Output, inline path: `{ "upload_id", "status": "stored", "bytes", "width", "height", "format" }`.
Inline bytes are inspected (rules below) before they are stored, so a bad
inline image is refused by `upload_image` itself.

The tool description says, in a few sentences: send `multipart/form-data` with
every entry of `fields` first and the file last under `file_field`; a 204 means
it is stored; then pass `upload_id` to the tools below. It names the 15-minute
expiry and the 20 MB / 700 KB caps.

`upload_id` is `upl_` plus 32 hex characters from a CSPRNG. The object key is
`uploads/<project_id>/<upload_id>`, so an id is only ever looked up under the
project it was issued for.

The POST URL is reusable until it expires: a second POST overwrites the same
key. The URL is shown only to the client that asked for it, and anything it
writes is still validated before use, so this is accepted rather than guarded
with a Redis record.

## Using an upload

| Tool | New field | Rule |
|---|---|---|
| `create_image` | `reference_upload_ids: string[]` (1–4) | Codex receives each as a reference image. |
| `edit_image` | `source_upload_id: string` | Mutually exclusive with `source_version`. |
| `animate_image` | `source_upload_id: string` | Mutually exclusive with `source_version`. |

When the source is an upload, the asset need not exist yet: the result is the
asset's next version (v1 for a new asset) with `parent_version: null`.

**At submit time** the MCP role downloads each upload and inspects it with
sharp (shared code in `src/uploads.ts`):

- format is PNG, JPEG or WebP (sniffed from the bytes, not the declared type);
- one page only (an animated WebP is refused);
- at most 20 MB and at most 4096 px on either side, at least 16 px.

Failures: an id that is malformed, missing or expired → `UPLOAD_NOT_FOUND`
(new code); bytes that fail inspection → `UNSUPPORTED_FORMAT` with the reason.
The job payload carries the upload keys.

**In the worker**, each upload is downloaded again, normalised with sharp
(auto-orient, strip metadata) and written into the job folder:
`reference-1.png` … for references, `source.<output_format>` for an edit
source, matching what `edit_image` already does. The create prompt gains one
line per reference: the path, and "use it as visual reference; do not copy
text, logos or watermarks unless the description asks for them". `animate`
reads the normalised buffer directly.

Rate limits and quota are unchanged: references and upload sources cost what
the tool they are passed to costs; `upload_image` itself costs nothing.

## Storage

`ArtifactStore` gains three methods, implemented by both stores:

- `putObject(key, body, contentType)` — inline uploads;
- `headObject(key)` → `{ bytes } | null` — cheap existence check;
- `presignUpload(key, contentType, maxBytes, ttlSeconds)` → `{ url, fields }`
  — S3 only, via `@aws-sdk/s3-presigned-post` with a `content-length-range`
  condition. The returned URL uses `S3_PUBLIC_BASE_URL`, since the policy
  signature does not cover the host. The local store throws
  `UNSUPPORTED_FORMAT` ("presigned uploads need S3 storage; pass data_base64"),
  so a single-process deployment keeps the inline path.

**Bucket configuration**, applied by the MCP role at startup when storage is
S3, idempotently, logging a warning (not crashing) on failure:

- CORS: allow `POST` from `UPLOAD_CORS_ORIGINS` (default `*`; the signed
  policy is the credential, CORS protects nothing here) and keep `GET` for
  artifacts.
- Lifecycle: expire `uploads/` after `UPLOAD_RETENTION_DAYS` days.

The bucket policy already grants anonymous `GetObject` on `projects/*` only, so
`uploads/` stays private without a change.

## Deployment (dc-fpt-argocd-platform)

- The `imagegen-mcp` Deployment gets the storage env and the bucket Secret the
  worker already has (`imagegen-mcp.storageEnv` + `envFrom` the OBC Secret). It
  needs credentials to presign, inspect and write inline uploads.
- Rollout follows the rule from 0.7.0: bump the image for both Deployments,
  wait until both run it, then add `upload_image` to the **four**
  `mcp.tool.name in [...]` allowlists in `agentgateway/values.yaml`, in a
  separate commit. A 0.7.x worker would ignore the new payload fields and run
  an edit or create without the upload.

## Testing

- `tests/uploads.test.ts`: inspection accepts PNG/JPEG/WebP, refuses GIF,
  animated WebP, garbage, 4097 px, 15 px, and 20 MB + 1 byte; normalisation
  strips EXIF and applies orientation.
- Schema tests: `source_upload_id` and `source_version` together are refused;
  `reference_upload_ids` accepts 1–4.
- Service tests with an in-memory store: inline upload stored and inspected;
  unknown id → `UPLOAD_NOT_FOUND`; cross-project id not found; payload carries
  the keys; new asset gets v1.
- Consumer tests: references written as `reference-N.png` and named in the
  prompt; upload source used for edit and animate.
- Live check after rollout: a `curl` multipart POST to the returned target
  (204), a CORS preflight with a foreign `Origin`, a 21 MB POST refused by
  S3, then one `create_image` with a reference (one quota unit) and one
  `animate_image` from an upload.

## Risks

- **RGW 20.2.4 and POST policy.** RGW implements browser POST uploads, but
  `content-length-range`, the CORS response on POST and lifecycle on this
  cluster are unverified. The plan's first task proves all three against the
  real bucket with `curl` before any code depends on them.
- **Claude Design may still be unable to send the POST** (no network from its
  preview, or a CSP). That is outside this spec; the inline path is the
  fallback for small images.
