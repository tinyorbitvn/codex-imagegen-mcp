# Architecture

Two services, one queue, one bucket.

```
MCP client (Claude Design, Claude Code, any MCP client)
        |  Streamable HTTP, POST /mcp
        v
  imagegen-mcp  ------ enqueue ------>  Redis
        ^                                 |
        |  poll job state                 | dequeue
        |                                 v
        +---------------------------  codex-image-worker
                                           |  runs `codex exec`
                                           v
                                     ChatGPT / Codex
                                           |
                                           v
                                   S3 bucket -> image URL
```

## Why it is split in two

The MCP server never touches credentials. It parses the call, validates it,
puts a job on the queue and reports progress. The worker is the only process
that runs Codex, and the only one with the ChatGPT session on a volume.

That split is what makes the MCP endpoint safe to scale and to expose
internally: a compromised or busy MCP replica has nothing to steal. It also
means the expensive part, one Codex process at a time, is a separate scaling
decision from the cheap part.

## Why a queue instead of a direct call

An image takes 30 to 140 seconds. A single Codex sign-in runs one job at a
time. Without a queue, a second caller would either block an HTTP connection
for two minutes or get a failure; with one, callers get a job id immediately
and the worker drains the backlog at whatever rate the account allows.

The queue also gives cancellation and progress a place to live. `create_image`
waits by default and reports progress while it waits, so callers do not have
to poll, but `wait=false` hands back the job id straight away for callers that
want several images in flight.

## The tools

| Tool | What it does |
|---|---|
| `create_image` | Generates one image. Waits by default; returns `timed_out=true` rather than failing if it runs long. |
| `edit_image` | Applies a change to an existing artifact and saves it as a NEW version. Never overwrites. |
| `get_image_job` | Job state: queued, running, completed, failed, cancelled. |
| `get_artifact` | Artifact metadata and URL. Omit the version for the latest. |
| `cancel_image_job` | Cancels a queued or running job. A finished job cannot be cancelled. |

`create_image` takes an `isolated_object` flag. For animated web graphics, ask
for each independently moving object in its own call with that flag set. One
combined scene cannot be cut into layers afterwards.

Style profiles let a caller send `style.reference: "tinyorbit-cloud-v1"`
instead of repeating a paragraph of style description on every call. Profiles
live in `packages/contracts/src/styles.ts`; add your own there.

## Transport

MCP Streamable HTTP in session-less mode: every call is a self-contained
`POST /mcp`. `GET /mcp` and `DELETE /mcp`, the session-based part of the
protocol, deliberately return an error. Being stateless is what lets the MCP
server run several replicas behind one address with no sticky sessions.

Both services also serve `/health/live`, `/health/ready` and `/metrics`
(Prometheus text format).

## Where the image actually comes from

The worker shells out to the official Codex CLI, pinned to an exact version,
with `exec --skip-git-repo-check`. It does not call any private endpoint. The
environment handed to that process is an allowlist, so an `OPENAI_API_KEY` set
on the pod is never forwarded: the point of the project is to spend the
subscription, not the API balance.

Codex writes the generated image into the job's working directory. The worker
uploads it to S3 and returns `S3_PUBLIC_BASE_URL` plus the object key. Codex
also keeps its own copy under `$CODEX_HOME/generated_images`, about 0.7 MB per
job, which the worker prunes on a retention window because nothing else will.

## Packages

| Package | Contents |
|---|---|
| `packages/contracts` | Job and artifact types, error codes, log redaction, style profiles. Shared by both services so their view of a job cannot drift. |
| `packages/job-queue` | Queue interface with a Redis implementation and an in-memory one used by the tests. |
| `packages/artifact-storage` | S3 upload, public URL construction, presigned URLs. |
