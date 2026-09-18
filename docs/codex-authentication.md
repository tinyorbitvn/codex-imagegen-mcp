# Codex authentication

The worker signs in to OpenAI **as a ChatGPT account on a paid plan**, through
the Codex CLI's own device-auth flow. Not with an API key. That is the whole
reason this project exists: the subscription you already pay for can generate
images, and an API key would bill you a second time.

## Nothing is automatic, and that is deliberate

The sign-in is a browser flow against your own account. It cannot be scripted,
and no image here ships with credentials. Expect to do this by hand once per
deployment, and again whenever the session expires.

## Where the credential lives

The Codex CLI writes `auth.json` into `$CODEX_HOME`, which the images set to
`/home/codex/.codex`. That path must be a volume that outlives the container:

| Deployment | What holds it |
|---|---|
| Docker Compose | the named volume `codex-home` |
| Helm chart | the PersistentVolumeClaim `<release>-codex-home` |

The chart's claim carries `helm.sh/resource-policy: keep`, so uninstalling the
release does not delete the sign-in. Losing that volume means signing in
again, nothing worse.

The claim is ReadWriteOnce on purpose. If someone raises the replica count,
the second pod gets stuck Pending because it cannot mount the volume.
That is the failure landing in the right place: two Codex processes racing to
rewrite the same token file would be worse and much harder to notice. A
ReadWriteMany storage class would quietly remove that guard.

`auth.json` belongs on that volume and nowhere else. Never in git, never in a
ConfigMap, never baked into an image, never in Helm values, never in a log
line, never in anything returned over MCP.

## Signing in

### Docker Compose

```bash
docker compose exec codex-imagegen-mcp codex login --device-auth
```

It prints a short URL and a code; open the URL anywhere you have a browser,
enter the code, approve. The process notices the new session on its own, so
no restart is needed. Confirm:

```bash
docker compose exec codex-imagegen-mcp codex login status
```

### Kubernetes

```bash
kubectl -n <namespace> exec -it deploy/<release> -- codex login --device-auth
```

Same flow. With `split=true`, target the `-worker` Deployment instead, since
that is the pod holding the session. The pod becomes ready again within about
one readiness period, so a restart is usually unnecessary. Confirm:

```bash
kubectl -n <namespace> exec deploy/<release> -- \
  node -e "fetch('http://127.0.0.1:8080/health/ready').then(r=>r.text()).then(console.log)"
```

The images are Node images with nothing else in them, so use `node`, not
`curl` or `wget`. Neither is installed.

A healthy worker answers something like:

```json
{"status":"ready","checks":{"work_dir_writable":true,
 "codex_present":true,"codex_authenticated":true,
 "storage_reachable":true,"redis":true}}
```

`--device-auth` is the flag to use because the container has no browser and
cannot receive a loopback OAuth callback. It exists in Codex CLI 0.154.0,
which the image pins. On a build without it, plain `codex login` waits on a
loopback port, and you have to forward that port to your own machine before
opening the login URL. Codex prints the port it chose, commonly 1455.

## When it expires

It is a session, so it expires or can be revoked. The symptoms:

- the pod stays Running but not Ready
- `/health/ready` returns 503 with `codex_authenticated: false`
- `create_image` fails with `CODEX_NOT_AUTHENTICATED`

Fix it by signing in again the same way. There is no automatic refresh, and
there is deliberately no fallback to an API key.

**The readiness check only tests that `auth.json` exists**, not that the token
inside is still good. A token that expired while the file remains still passes
the probe, and the failure shows up on the next real job instead. That is a
chosen tradeoff: verifying the token properly would mean generating an image
inside a probe that runs every fifteen seconds, spending real quota to answer
a health check.

## A different failure that looks similar

`IMAGE_CAPABILITY_UNAVAILABLE` means the sign-in is valid but the account or
plan cannot generate images. Signing in again will not fix it; the account
needs a plan that supports image generation. There is no API-key path around
this either.

`CODEX_QUOTA_EXHAUSTED` means the sign-in is valid and the account can
generate images, but its usage limit is spent. Signing in again will not fix
that one either: it needs time or credits. See
[Troubleshooting](troubleshooting.md).

## Why an API key cannot leak in by accident

Three independent places would each have to be changed for the worker to use
one:

1. `src/config.ts` never reads `OPENAI_API_KEY`.
2. `src/worker/runner.ts` builds the Codex child
   process's environment from an allowlist: `CODEX_HOME`, `HOME`, `PATH`,
   `TMPDIR`, `LANG`, `TERM`. Anything not on that list is invisible to Codex
   even when the container has it set.
3. The Dockerfile never declares the variable.

A test asserts the child environment contains exactly the allowlisted keys and
nothing else, naming `OPENAI_API_KEY` and the S3 credentials specifically. If
you deliberately want API billing, you are changing three files and a test,
which is the point.

## Upgrading the Codex CLI

The version is pinned in `Dockerfile` as `CODEX_VERSION`. The worker builds a fixed command line, and Codex renames
flags often enough that following `latest` would eventually break every job at
once.

To bump it: change the ARG, rebuild, run `npm test`, then check
`codex exec --help` still has `--skip-git-repo-check`, and generate one real
image before trusting it. `auth.json` survives minor version bumps, so the
volume does not need recreating.

Do not downgrade below 0.154.0 without checking: on 2026-09-11, version 0.48.0
was refused by the backend for every model, including invented names, on an
active paid account, with `400 {"detail":"The '<model>' model is not supported
when using Codex with a ChatGPT account."}`. Old clients stop being served for
this auth flow.
