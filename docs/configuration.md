# Configuration

Everything is environment variables. A missing required variable stops the
process at startup with the variable's name, rather than failing later on a
request.

## imagegen-mcp

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `REDIS_URL` | yes | | Queue connection, e.g. `redis://redis:6379`. |
| `PORT` | no | `8080` | HTTP port. |
| `QUEUE_LIMIT` | no | `64` | Jobs allowed to be waiting before new work is rejected. |
| `RATE_LIMIT_CREATE_IMAGE_PER_HOUR` | no | `10` | Per caller. |
| `RATE_LIMIT_EDIT_IMAGE_PER_HOUR` | no | `20` | Per caller. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no | `""` | Empty disables tracing export entirely. |

This service has no object storage configuration and no OpenAI configuration,
because it touches neither.

The caller identity behind the rate limit is taken from the first header
present out of `x-agentgateway-principal`, `x-jwt-sub`, `x-user`, and is
`anonymous` otherwise. With no authenticating proxy in front, every caller
shares the `anonymous` bucket.

## codex-image-worker

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `REDIS_URL` | yes | | Same queue as the MCP server. |
| `S3_ENDPOINT` | yes | | S3 API endpoint. |
| `S3_BUCKET` | yes | | Must already exist. |
| `S3_PUBLIC_BASE_URL` | yes | | Base of the URL handed back to clients. Trailing slashes are stripped. |
| `S3_REGION` | no | `us-east-1` | |
| `S3_FORCE_PATH_STYLE` | no | `true` | Bucket in the path, not the hostname. Keep it true for MinIO, Ceph RGW and most self-hosted gateways: virtual-hosted style needs wildcard DNS they usually lack, and the failure looks like a DNS error rather than an S3 one. |
| `S3_SIGNED_URL_TTL_SECONDS` | no | `86400` | Lifetime of presigned URLs. |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | usually | `""` | Omit only if the pod gets credentials another way, such as an instance role. |
| `PORT` | no | `8080` | Health and metrics only; the worker serves no client traffic. |
| `QUEUE_LIMIT` | no | `64` | |
| `WORKER_CONCURRENCY` | no | `1` | Jobs at once. One sign-in means one Codex process; raise only if you know the account tolerates more. |
| `JOB_TIMEOUT_SECONDS` | no | `900` | A job is abandoned after this. Real jobs take 30 to 140 seconds. |
| `GENERATED_IMAGE_RETENTION_HOURS` | no | `24` | How long Codex's own copies of generated images are kept before the worker deletes them. Roughly 0.7 MB per job, and nothing else prunes them. |
| `WORK_DIR` | no | `/work/jobs` | Scratch space for in-flight jobs. |
| `CODEX_HOME` | no | `/home/codex/.codex` | Where the ChatGPT sign-in lives. Must be on a volume that survives restarts. |
| `CODEX_BINARY` | no | `codex` | Override only if the CLI is somewhere unusual. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no | `""` | |

`OPENAI_API_KEY` is deliberately absent. The worker builds the Codex child
process's environment from an allowlist, so setting that variable on the pod
does not reach Codex. Billing an API key would defeat the point of the
project.

## The public URL

The link returned to an MCP client is `S3_PUBLIC_BASE_URL` + `/` + the object
key, a plain unsigned GET. The bucket therefore has to allow anonymous
download for those links to open. If you would rather not publish the bucket,
the storage layer can hand out presigned URLs instead; see `signedUrl()` in
`packages/artifact-storage/src/s3.ts`.

Whatever you set has to resolve from wherever the MCP client runs, not from
inside the cluster or the compose network. Pointing it at an internal service
name produces links that only work on the server.
