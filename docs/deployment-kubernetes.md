# Deploying on Kubernetes

The chart in `charts/codex-imagegen-mcp` has no chart dependencies, so a clone
installs with nothing to fetch first. The default is one pod that needs
nothing else in the cluster.

## What you need first

- A StorageClass that can give the pod two small ReadWriteOnce volumes: one
  holds the ChatGPT sign-in, one holds the generated images.
- A URL that resolves for your clients. Either set `publicBaseUrl` or enable
  the ingress, which the chart reads the host from.

That is all. A queue and object storage are optional and covered below.

## Install

```bash
helm install imagegen ./charts/codex-imagegen-mcp \
  --namespace imagegen --create-namespace \
  --set publicBaseUrl=https://mcp.example.com
```

The chart refuses to render when something essential is unset, naming the
value. That is deliberate: the alternative is pods that crash-loop on a
missing environment variable, or links that resolve nowhere.

## Sign in, once

```bash
kubectl -n imagegen exec -it deploy/imagegen-codex-imagegen-mcp -- codex login --device-auth
kubectl -n imagegen exec deploy/imagegen-codex-imagegen-mcp -- codex login status
```

With `split=true` the target is the `-worker` Deployment instead, since that
is the pod holding the session.

The session is written to the `-codex-home` claim, which carries
`helm.sh/resource-policy: keep`, so `helm uninstall` leaves it alone and a
reinstall picks the same session back up. Details and the renewal procedure
are in [codex-authentication.md](codex-authentication.md).

## Growing out of one pod

Three independent steps, in the order most people need them.

**A real queue.** Set `redis.url`. The in-process queue is lost on restart,
taking any waiting jobs with it; Redis survives that and is a prerequisite for
splitting.

**Object storage.** Set `s3.endpoint`, `s3.bucket`, `s3.publicBaseUrl` and
credentials. The artifacts volume then goes away, and generated URLs point at
the bucket rather than at this service. Use it when you want images to outlive
the deployment, or to be served by something built for it.

**Splitting the roles.** Set `split=true`, which requires both of the above.
You get a Deployment serving MCP and a Deployment running Codex. Restarting or
scaling the endpoint then no longer disturbs the process that holds the
ChatGPT session.

## Scaling

The MCP role is stateless: raise `replicaCount` freely once `split=true`.
There are no sticky sessions to preserve, because the transport runs in
session-less mode.

The worker is not. One sign-in drives one Codex process, so the worker stays
at one replica and `worker.concurrency` stays at 1 unless you have given each
replica its own sign-in volume. Without `split`, `replicaCount` above 1 is
refused: each pod would hold its own in-process queue and its own sign-in,
which is not a scaled service but several disconnected ones.

Any Deployment holding the ReadWriteOnce volumes uses the `Recreate` strategy.
A rolling update would deadlock waiting for a volume the old pod still holds.

## Exposing it

The MCP endpoint authenticates nobody. Anything that can reach `/mcp` can
spend your ChatGPT quota.

Keep it inside the cluster and port-forward, or put an authenticating proxy in
front of the Ingress. If that proxy passes the caller's identity in
`x-agentgateway-principal`, `x-jwt-sub` or `x-user`, the per-caller hourly
limits start applying per person instead of lumping everyone into one
`anonymous` bucket.

Note that `/artifacts/` is served by the same port as `/mcp` when storage is
local. Whatever can read a generated image can also reach the MCP endpoint, so
do not treat the image URLs as a separately protected surface.

## Watching it

The pod serves `/metrics` in Prometheus text format on port 8080, covering
whichever roles it runs. Set `otlp.endpoint` to send traces to a collector;
leaving it empty disables the exporter entirely rather than making it retry
into the void.

## Storage growth

Two things grow. Generated images accumulate on the artifacts volume until you
remove them, which is why that claim defaults to 10Gi and is kept on
uninstall. Separately, Codex keeps its own copy of every image it generates
under `$CODEX_HOME`, about 0.7 MB per job, and the process deletes copies
older than `worker.generatedImageRetentionHours`, 24 by default. Shortening
that window to nothing loses the ability to recover an image whose upload
failed.
