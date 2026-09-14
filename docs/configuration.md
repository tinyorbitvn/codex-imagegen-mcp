# Configuration

Everything is environment variables. A missing required variable stops the
process at startup with the variable's name, rather than failing later on a
request.

## What runs

| Variable | Default | Meaning |
|---|---|---|
| `ROLE` | `all` | `all` serves MCP and generates images in one process. `mcp` serves only the endpoint, `worker` only generates. Anything else is a startup error. |
| `PORT` | `8080` | HTTP port. |
| `PUBLIC_BASE_URL` | `http://localhost:${PORT}` | The base of the URL handed to clients for a generated image, when images are stored locally. It has to resolve from wherever the client runs, not from inside the container. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `""` | Empty disables tracing export entirely, so point it at a collector you already run rather than standing one up. |

## The queue

| Variable | Default | Meaning |
|---|---|---|
| `REDIS_URL` | `""` | Empty keeps the queue inside the process. Set it to share work between an `mcp` and a `worker` process. |
| `QUEUE_LIMIT` | `64` | Jobs allowed to be waiting before new work is rejected. |

An empty `REDIS_URL` is fatal in roles `mcp` and `worker`. Two processes
cannot share an in-process queue, and failing at startup beats a deployment
where the endpoint quietly accepts work nobody will ever collect.

## Storage

| Variable | Default | Meaning |
|---|---|---|
| `S3_ENDPOINT` | `""` | Empty stores images on local disk. Set it to use object storage. |
| `ARTIFACT_DIR` | `/data/artifacts` | Where images go when storage is local. Must be a volume that outlives the container, or every URL already handed out dies with it. |
| `S3_BUCKET` | | Required when `S3_ENDPOINT` is set. Must already exist. |
| `S3_PUBLIC_BASE_URL` | | Required when `S3_ENDPOINT` is set. Base of the URL handed to clients. Trailing slashes are stripped. |
| `S3_REGION` | `us-east-1` | |
| `S3_FORCE_PATH_STYLE` | `true` | Bucket in the path, not the hostname. Keep it true for MinIO, Ceph RGW and most self-hosted gateways: virtual-hosted style needs wildcard DNS they usually lack, and the failure looks like a DNS error rather than an S3 one. |
| `S3_SIGNED_URL_TTL_SECONDS` | `86400` | Lifetime of presigned URLs. |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | `""` | Omit only if the process gets credentials another way, such as an instance role. |

Local storage is fatal in role `worker`: the MCP process is what serves
`/artifacts`, so a split deployment needs a store both sides can reach.

With local storage the returned link is `PUBLIC_BASE_URL` + `/artifacts/` +
the key, served by this process. With S3 it is `S3_PUBLIC_BASE_URL` + `/` +
the key, a plain unsigned GET, so that bucket has to allow anonymous download.

## The worker

| Variable | Default | Meaning |
|---|---|---|
| `WORKER_CONCURRENCY` | `1` | Jobs at once. One sign-in means one Codex process; raise only if you know the account tolerates more. |
| `JOB_TIMEOUT_SECONDS` | `900` | A job is abandoned after this. Real jobs take 30 to 140 seconds. |
| `GENERATED_IMAGE_RETENTION_HOURS` | `24` | How long Codex's own copies of generated images are kept before deletion. Roughly 0.7 MB per job, and nothing else prunes them. |
| `WORK_DIR` | `/work/jobs` | Scratch space for in-flight jobs. |
| `CODEX_HOME` | `/home/codex/.codex` | Where the ChatGPT sign-in lives. Must be on a volume that survives restarts. |
| `CODEX_BINARY` | `codex` | Override only if the CLI is somewhere unusual. |

## The endpoint

| Variable | Default | Meaning |
|---|---|---|
| `RATE_LIMIT_CREATE_IMAGE_PER_HOUR` | `10` | Per caller. |
| `RATE_LIMIT_EDIT_IMAGE_PER_HOUR` | `20` | Per caller. |

The caller identity is taken from the first header present out of
`x-agentgateway-principal`, `x-jwt-sub`, `x-user`, and is `anonymous`
otherwise. With no authenticating proxy in front, every caller shares the
`anonymous` bucket.

## What is deliberately absent

`OPENAI_API_KEY` is never read. The worker builds the Codex child process's
environment from an allowlist, so setting that variable does not reach Codex.
Billing an API key would defeat the point of the project.
