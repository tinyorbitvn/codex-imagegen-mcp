# codex-imagegen-mcp

An MCP server that generates images with the **Codex CLI**, so the work is
billed to a **ChatGPT subscription you already pay for** instead of the
per-image OpenAI API.

## Why this exists

Claude Design can ask for images, but every image API call costs money on top
of whatever you already pay OpenAI. A ChatGPT subscription can already
generate images, and the official Codex CLI can drive it. What was missing was
a way for an MCP client to reach that.

So: sign in to Codex once with your ChatGPT account, run one container, and
point any MCP client at it. Images come back as URLs. Nothing here ever reads
`OPENAI_API_KEY` — the Codex process's environment is built from an allowlist,
so even if that variable is set on the host it is never forwarded. Spending
the subscription is the entire point.

What you should know before relying on it:

- **One sign-in means one job at a time.** A single ChatGPT session drives a
  single Codex process. The queue absorbs the backlog; it does not make the
  account faster.
- **An image takes 30 to 140 seconds.** The MCP tool waits for you and reports
  progress, so clients do not have to poll.
- **Your account's terms and quotas apply.** This automates the official CLI
  with your own credentials. It does not bypass anything, and it gives you no
  more capacity than your plan already has.

## Quick start

One container. No database, no object storage, no message broker: with
neither Redis nor S3 configured the process keeps its queue in memory and
writes images to a volume, serving them from the same port it serves MCP on.

Requires Docker with the Compose plugin, and a ChatGPT account that can use
Codex.

```bash
git clone https://github.com/tinyorbitvn/codex-imagegen-mcp.git
cd codex-imagegen-mcp
docker compose up -d
```

One step is left, because no image ships with credentials:

```bash
docker compose exec codex-imagegen-mcp codex login --device-auth
```

Follow the printed URL and code to sign in with your ChatGPT account. The
container reports ready within a few seconds:

```bash
docker compose exec codex-imagegen-mcp codex login status
```

Now connect a client. For Claude Code:

```bash
claude mcp add --transport http imagegen http://localhost:8080/mcp
```

Any MCP client that speaks Streamable HTTP works the same way; the endpoint is
`POST /mcp` and there is no session handshake.

Ask for an image and you get back a URL served by the same container. Stop it
with `docker compose down`; add `-v` to throw away the sign-in and the images
too.

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

## Growing beyond one container

The same image runs three ways, chosen by the `ROLE` environment variable.
`all` is the default and does everything in one process. `mcp` and `worker`
split the endpoint from the Codex process, which lets you restart or scale the
endpoint without touching the session that holds your ChatGPT sign-in.

Splitting needs a shared queue and shared storage, because two processes share
neither memory nor a local disk. Set `REDIS_URL` and the `S3_*` variables and
they replace the in-process queue and the local artifact directory. Each is
independent: storage can move to S3 while the queue stays in the process.

## Kubernetes

```bash
helm install imagegen ./charts/codex-imagegen-mcp \
  --namespace imagegen --create-namespace \
  --set publicBaseUrl=https://mcp.example.com
```

That is one pod, one volume for the sign-in and one for the images. Then sign
in once inside the pod, the same way as above. See
[charts/codex-imagegen-mcp/README.md](charts/codex-imagegen-mcp/README.md) and
[docs/deployment-kubernetes.md](docs/deployment-kubernetes.md).

**The MCP endpoint authenticates nobody.** Anything that can reach it can
spend your ChatGPT quota. Keep it inside your network, or put an
authenticating proxy in front.

## Image

Published to GitHub Packages on every `v*` tag, public, no login needed:

```bash
docker pull ghcr.io/tinyorbitvn/codex-imagegen-mcp:latest
```

## Documentation

- [Architecture](docs/architecture.md) — what runs where, and why it can be one process
- [Configuration](docs/configuration.md) — every environment variable
- [Codex authentication](docs/codex-authentication.md) — the sign-in, where it lives, how to renew it
- [Kubernetes deployment](docs/deployment-kubernetes.md)
- [Troubleshooting](docs/troubleshooting.md)

## Development

One npm package, no workspaces.

```bash
npm ci
npm run typecheck
npm test
docker build -t codex-imagegen-mcp:dev .
```

## License

MIT. See [LICENSE](LICENSE).
