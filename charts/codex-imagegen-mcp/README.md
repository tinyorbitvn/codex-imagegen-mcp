# codex-imagegen-mcp Helm chart

Deploys the MCP server and the Codex worker on Kubernetes.

```bash
helm install imagegen ./charts/codex-imagegen-mcp \
  --namespace imagegen --create-namespace \
  --set s3.endpoint=https://s3.example.com \
  --set s3.bucket=imagegen-artifacts \
  --set s3.publicBaseUrl=https://s3.example.com/imagegen-artifacts \
  --set s3.accessKeyId=... --set s3.secretAccessKey=... \
  --set redis.url=redis://redis-master.redis:6379
```

Then sign in to ChatGPT once, into the worker's volume:

```bash
kubectl -n imagegen exec -it deploy/imagegen-codex-imagegen-mcp-worker -- codex login --device-auth
kubectl -n imagegen rollout restart deploy/imagegen-codex-imagegen-mcp-worker
```

No image contains credentials. Until that sign-in exists, every job fails.

## What gets created

| Object | Purpose |
|---|---|
| Deployment + Service (MCP) | The `/mcp` endpoint. Stateless, scales horizontally. |
| Deployment + Service (worker) | Runs the Codex CLI. Holds the ChatGPT session. |
| PersistentVolumeClaim `-codex-home` | The sign-in. Annotated `helm.sh/resource-policy: keep`, so uninstalling the release does not throw it away. |
| Secret `-s3` | Object storage credentials, unless you point at `s3.existingSecret`. |
| Deployment + Service `-redis` | Only when `redis.deploy=true`. Evaluation only: one pod, no persistence. |
| Ingress | Only when `ingress.enabled=true`. |

## Values you have to set

| Key | Why |
|---|---|
| `s3.endpoint` | Where generated images are written. |
| `s3.bucket` | Must already exist; the chart does not create it. |
| `s3.publicBaseUrl` | The URL handed to MCP clients. Final link is this plus `/` plus the object key, unsigned, so the bucket must allow anonymous download. |
| `s3.existingSecret` or `s3.accessKeyId` + `s3.secretAccessKey` | Credentials for that bucket. |
| `redis.url` or `redis.deploy=true` | The queue between the two services. |

The chart refuses to render with a message naming the missing one, rather
than letting pods crash-loop on an unset variable.

## Values worth knowing about

| Key | Default | Note |
|---|---|---|
| `worker.replicaCount` | `1` | One ChatGPT sign-in drives one Codex process. More replicas need one sign-in volume each, and the chart blocks the combination that would silently share one. |
| `worker.concurrency` | `1` | Same reason, within a replica. |
| `worker.jobTimeoutSeconds` | `900` | Real jobs take 30 to 140 seconds. |
| `worker.generatedImageRetentionHours` | `24` | Codex keeps its own copy of every image, roughly 0.7 MB per job. This is how long those copies live. |
| `worker.persistence.codexHome.size` | `1Gi` | Holds the sign-in plus Codex's own image copies. |
| `mcp.replicaCount` | `2` | Stateless, so raise it freely. |
| `mcp.rateLimit.*` | 10 create, 20 edit per hour | Per caller, read from `x-agentgateway-principal`, `x-jwt-sub` or `x-user`. With no proxy in front, every caller is `anonymous` and shares one bucket. |
| `otlp.endpoint` | `""` | Empty disables OpenTelemetry export. |

## Exposure

The service authenticates nobody. Anything that can reach `/mcp` can spend
your ChatGPT quota. Put an authenticating proxy in front of the Ingress, or
keep it inside the cluster and port-forward.
