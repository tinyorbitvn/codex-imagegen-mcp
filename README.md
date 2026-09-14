# codex-imagegen-mcp

An MCP server that generates images with the **Codex CLI**, so the work is
billed to a **ChatGPT subscription you already pay for** instead of the
per-image OpenAI API.

## Why this exists

Claude Design can ask for images, but every image API call costs money on top
of whatever you already pay OpenAI. A ChatGPT subscription can already
generate images, and the official Codex CLI can drive it. What was missing was
a way for an MCP client to reach that.

So: sign in to Codex once with your ChatGPT account, run these two services,
and point any MCP client at the endpoint. Images come back as URLs. Nothing
here ever reads `OPENAI_API_KEY` — the worker builds the Codex process's
environment from an allowlist, so even if that variable is set on the host it
is never forwarded. Spending the subscription is the entire point.

What you should know before relying on it:

- **One sign-in means one job at a time.** A single ChatGPT session drives a
  single Codex process. The queue absorbs the backlog; it does not make the
  account faster.
- **An image takes 30 to 140 seconds.** The MCP tool waits for you and reports
  progress, so clients do not have to poll.
- **Your account's terms and quotas apply.** This project automates the
  official CLI with your own credentials. It does not bypass anything, and it
  gives you no more capacity than your plan already has.

## Quick start

Requires Docker with the Compose plugin, and a ChatGPT account that can use
Codex.

```bash
git clone https://github.com/tinyorbitvn/codex-imagegen-mcp.git
cd codex-imagegen-mcp
cp .env.example .env
docker compose up -d
```

That brings up Redis, MinIO for storage, the MCP server on port 8080 and the
worker. One step is left, because no image ships with credentials:

```bash
docker compose run --rm codex-login
```

Follow the printed URL and code to sign in with your ChatGPT account, then
restart the worker so it picks the session up:

```bash
docker compose restart codex-image-worker
docker compose exec codex-image-worker codex login status
```

Now connect a client. For Claude Code:

```bash
claude mcp add --transport http imagegen http://localhost:8080/mcp
```

Any MCP client that speaks Streamable HTTP works the same way; the endpoint is
`POST /mcp` and there is no session handshake.

Ask for an image and you get back a URL served by MinIO. Stop everything with
`docker compose down`; add `-v` to throw away the sign-in and the images too.

## The tools

| Tool | What it does |
|---|---|
| `create_image` | Generates one image. Waits by default and reports progress; `wait=false` returns a job id immediately. |
| `edit_image` | Applies a change to an existing artifact as a NEW version. Never overwrites. |
| `get_image_job` | queued, running, completed, failed or cancelled, plus the artifact URL when done. |
| `get_artifact` | Artifact metadata and URL. Omit the version for the latest. |
| `cancel_image_job` | Cancels a queued or running job. |

For animated web graphics, ask for each independently moving object in its own
`create_image` call with `isolated_object: true`. A single combined scene
cannot be split into layers afterwards.

## Kubernetes

```bash
helm install imagegen ./charts/codex-imagegen-mcp \
  --namespace imagegen --create-namespace \
  --set s3.endpoint=https://s3.example.com \
  --set s3.bucket=imagegen-artifacts \
  --set s3.publicBaseUrl=https://s3.example.com/imagegen-artifacts \
  --set s3.accessKeyId=... --set s3.secretAccessKey=... \
  --set redis.url=redis://redis-master.redis:6379
```

Then sign in once inside the worker pod, the same way as above. The chart
keeps that sign-in on its own volume, annotated so an uninstall does not throw
it away. See [charts/codex-imagegen-mcp/README.md](charts/codex-imagegen-mcp/README.md)
and [docs/deployment-kubernetes.md](docs/deployment-kubernetes.md).

**The MCP endpoint authenticates nobody.** Anything that can reach it can
spend your ChatGPT quota. Keep it inside your network, or put an
authenticating proxy in front.

## Images

Published to GitHub Packages on every `v*` tag, public, no login needed:

```bash
docker pull ghcr.io/tinyorbitvn/imagegen-mcp:latest
docker pull ghcr.io/tinyorbitvn/codex-image-worker:latest
```

Both images always carry the same version: they live in one npm workspace and
share `packages/*`, so a matching pair is the only combination that is tested
together.

## Documentation

- [Architecture](docs/architecture.md) — what the two services do and why they are split
- [Configuration](docs/configuration.md) — every environment variable
- [Codex authentication](docs/codex-authentication.md) — the sign-in, where it lives, how to renew it
- [Kubernetes deployment](docs/deployment-kubernetes.md)
- [Troubleshooting](docs/troubleshooting.md)

## Development

An npm workspace. Both services depend on `packages/*` at version `*`, so
builds run from the repository root and the Dockerfiles copy `packages/` in.

```bash
npm ci
npm run typecheck
npm test
docker build -f services/imagegen-mcp/Dockerfile -t imagegen-mcp:dev .
```

## License

MIT. See [LICENSE](LICENSE).
