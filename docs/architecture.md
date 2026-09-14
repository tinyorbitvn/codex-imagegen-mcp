# Architecture

One process by default. Two roles inside it, which can be pulled apart when a
deployment outgrows one pod.

```
MCP client (Claude Design, Claude Code, any MCP client)
        |  Streamable HTTP, POST /mcp
        v
+---------------------------------------------------+
|  codex-imagegen-mcp                                |
|                                                    |
|   MCP role  --enqueue-->  queue  --dequeue-->  worker role
|                        (memory or Redis)           |   runs `codex exec`
|                                                    |   v
|   GET /artifacts/<key>  <----------------  store   |  ChatGPT / Codex
|                        (local dir or S3)           |
+---------------------------------------------------+
```

## Why one process is the default

Every extra moving part is something a new user has to install, secure and
keep running before they can generate a single image. A queue and an object
store earn their place at scale, not on a laptop. So both have a local
implementation: an in-process queue, and a directory served over the same HTTP
port. `docker compose up -d` is the whole installation.

## Why the roles still exist

Splitting is worth it when you want to restart or scale the MCP endpoint
without touching the process that holds the ChatGPT session, or when you want
the endpoint reachable from a network that the Codex process is kept off.

`ROLE` selects: `all` (default), `mcp`, `worker`. The image is the same in all
three cases. Splitting requires `REDIS_URL` and the `S3_*` variables, because
two processes share neither memory nor a local disk, and the configuration
refuses the combinations that cannot work rather than failing later.

## Why a queue at all

An image takes 30 to 140 seconds, and a single Codex sign-in runs one job at a
time. Without a queue, a second caller would either hold an HTTP connection
open for two minutes or be refused. With one, callers get a job id immediately
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
live in `src/contracts/styles.ts`; add your own there.

## Transport

MCP Streamable HTTP in session-less mode: every call is a self-contained
`POST /mcp`. `GET /mcp` and `DELETE /mcp`, the session-based part of the
protocol, deliberately return an error. Being stateless is what lets the MCP
role run several replicas behind one address with no sticky sessions.

The same server also exposes `/health/live`, `/health/ready`, `/metrics` in
Prometheus text format, and `/artifacts/<key>` when images are stored locally.

## Where the image actually comes from

The worker shells out to the official Codex CLI, pinned to an exact version,
with `exec --skip-git-repo-check`. It does not call any private endpoint. The
environment handed to that process is an allowlist, so an `OPENAI_API_KEY` set
on the host is never forwarded: the point is to spend the subscription, not
the API balance.

The prompt sent to Codex is written by the worker, not by the caller. User
text only ever lands in predefined slots. Codex is a coding agent, so passing
a caller's string straight through as the prompt would hand them the ability
to make it read files or run commands. Every instruction about the filesystem
comes from the worker, and the caller can never choose the output path.

Codex writes the generated image into the job's working directory. The worker
uploads it to the store and returns the public URL. Codex also keeps its own
copy under `$CODEX_HOME/generated_images`, about 0.7 MB per job, which the
worker prunes on a retention window because nothing else will.

## Source layout

| Path | Contents |
|---|---|
| `src/index.ts` | The only entrypoint. Reads the role, builds the queue and the store, assembles one HTTP server. |
| `src/config.ts` | Every environment variable, and the rules that pick a queue and a store. |
| `src/contracts/` | Job and artifact types, error codes, log redaction, style profiles. |
| `src/queue/` | Queue interface, in-memory implementation, Redis implementation. |
| `src/storage/` | Store interface, local directory implementation, S3 implementation. |
| `src/mcp/` | Tool registration, transport, and the service behind the tools. |
| `src/worker/` | The consumer loop, the Codex runner, prompt building, image inspection, metrics. |
