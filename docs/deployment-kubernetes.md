# Deploying on Kubernetes

The chart in `charts/codex-imagegen-mcp` has no chart dependencies, so a clone
installs with nothing to fetch first.

## What you need first

- A bucket on any S3-compatible storage, reachable from the cluster, that
  allows anonymous download of its objects. The URLs handed to MCP clients are
  unsigned GETs.
- A Redis the cluster can reach. For a first look, `redis.deploy=true` runs a
  throwaway one inside the release.
- A StorageClass that can give the worker a small ReadWriteOnce volume. That
  volume holds the ChatGPT sign-in.

## Install

```bash
helm install imagegen ./charts/codex-imagegen-mcp \
  --namespace imagegen --create-namespace \
  --set s3.endpoint=https://s3.example.com \
  --set s3.bucket=imagegen-artifacts \
  --set s3.publicBaseUrl=https://s3.example.com/imagegen-artifacts \
  --set s3.existingSecret=imagegen-s3 \
  --set redis.url=redis://redis-master.redis:6379
```

The chart refuses to render if object storage or the queue is unset, naming
the value that is missing. That is deliberate: the alternative is pods that
crash-loop on a missing environment variable.

With `s3.existingSecret`, the Secret must hold the keys `AWS_ACCESS_KEY_ID`
and `AWS_SECRET_ACCESS_KEY`. Leave it empty and set `s3.accessKeyId` and
`s3.secretAccessKey` to have the chart create the Secret instead.

## Sign in, once

```bash
kubectl -n imagegen exec -it deploy/imagegen-codex-imagegen-mcp-worker -- codex login --device-auth
kubectl -n imagegen rollout restart deploy/imagegen-codex-imagegen-mcp-worker
kubectl -n imagegen exec deploy/imagegen-codex-imagegen-mcp-worker -- codex login status
```

The session is written to the `-codex-home` claim, which carries
`helm.sh/resource-policy: keep`, so `helm uninstall` leaves it alone and a
reinstall picks the same session back up. Details and the renewal procedure
are in [codex-authentication.md](codex-authentication.md).

## Scaling

The MCP server is stateless. Raise `mcp.replicaCount` freely; there are no
sticky sessions to preserve, because the transport runs in session-less mode.

The worker is not. One sign-in drives one Codex process, so
`worker.replicaCount` stays at 1 and `worker.concurrency` stays at 1 unless
you have given each replica its own sign-in volume. The chart blocks the
combination that would silently share one credential file across replicas.

The worker Deployment uses the `Recreate` strategy whenever its volume is
enabled: a ReadWriteOnce claim cannot be held by an old and a new pod at once,
and a rolling update would deadlock waiting for it.

## Exposing it

The MCP endpoint authenticates nobody. Anything that can reach `/mcp` can
spend your ChatGPT quota.

Keep it inside the cluster and port-forward, or put an authenticating proxy in
front of the Ingress. If that proxy passes the caller's identity in
`x-agentgateway-principal`, `x-jwt-sub` or `x-user`, the per-caller hourly
limits start applying per person instead of lumping everyone into one
`anonymous` bucket.

## Watching it

Both Deployments serve `/metrics` in Prometheus text format on port 8080, and
the worker has its own Service so a scrape can find it. Set `otlp.endpoint` to
send traces to a collector; leaving it empty disables the exporter entirely
rather than making it retry into the void.

## Storage growth

Codex keeps its own copy of every image it generates under `$CODEX_HOME`,
about 0.7 MB per job, and nothing else cleans them up. The worker deletes
copies older than `worker.generatedImageRetentionHours`, 24 by default. If you
shorten that window to nothing, you lose the ability to recover an image whose
upload failed.
