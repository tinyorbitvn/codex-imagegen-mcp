# codex-imagegen-mcp Helm chart

Deploys the MCP image generator. By default that is **one pod and nothing
else**: the queue lives in the process and images are written to a volume and
served from the same port.

```bash
helm install imagegen ./charts/codex-imagegen-mcp \
  --namespace imagegen --create-namespace \
  --set publicBaseUrl=https://mcp.example.com
```

`publicBaseUrl` is the one thing you must supply, because it is the URL
clients are handed for a generated image and only you know what resolves from
where they run. Enable the ingress instead and it is taken from the host.

Then sign in to ChatGPT once, into the pod's volume:

```bash
kubectl -n imagegen exec -it deploy/imagegen-codex-imagegen-mcp -- codex login --device-auth
```

No image contains credentials. Until that sign-in exists, every job fails.

## Growing out of one pod

| Want | Set |
|---|---|
| A real queue | `redis.url` |
| Object storage instead of a volume | `s3.endpoint`, `s3.bucket`, `s3.publicBaseUrl`, and credentials |
| The MCP endpoint scaled or restarted without touching the Codex process | `split=true`, which then requires both of the above |

Each of those is independent. Storage can move to S3 while the queue stays in
the process, and the chart refuses only the combinations that cannot work.

## What gets created

| Object | When |
|---|---|
| Deployment + Service | always. Runs both roles, or the MCP role when split. |
| Deployment + Service `-worker` | only with `split=true` |
| PVC `-codex-home` | the ChatGPT sign-in. `helm.sh/resource-policy: keep`, so uninstalling does not throw it away. |
| PVC `-artifacts` | when images are stored locally. Also kept on uninstall, because URLs already handed out point at it. |
| PVC `-work` | only when `persistence.work.enabled` |
| Secret `-s3` | only when `s3.endpoint` is set without `s3.existingSecret` |
| Deployment + Service `-redis` | only with `redis.deploy=true`. Evaluation only: one pod, no persistence. |
| Ingress | only with `ingress.enabled=true` |

## Values worth knowing about

| Key | Default | Note |
|---|---|---|
| `split` | `false` | One process, so no Redis and no object storage needed. |
| `replicaCount` | `1` | Only raisable with `split=true`. Without it, each replica would hold its own queue and its own sign-in, and the chart refuses. |
| `worker.concurrency` | `1` | One ChatGPT sign-in drives one Codex process. |
| `worker.jobTimeoutSeconds` | `900` | Real jobs take 30 to 140 seconds. |
| `worker.generatedImageRetentionHours` | `24` | Codex keeps its own copy of every image, roughly 0.7 MB per job. This is how long those copies live. |
| `persistence.artifacts.size` | `10Gi` | Only used when images are stored locally. |
| `rateLimit.*` | 10 create, 20 edit per hour | Per caller, read from `x-agentgateway-principal`, `x-jwt-sub` or `x-user`. With no proxy in front, every caller is `anonymous` and shares one bucket. |
| `otlp.endpoint` | `""` | Empty disables OpenTelemetry export. |

The chart fails to render, naming the value to set, rather than letting pods
crash-loop on a missing variable.

## Exposure

The service authenticates nobody. Anything that can reach `/mcp` can spend
your ChatGPT quota. Put an authenticating proxy in front of the Ingress, or
keep it inside the cluster and port-forward.
