# Troubleshooting

## Every job fails immediately after a fresh install

The worker has no Codex sign-in. No image ships with credentials, and nothing
creates one for you. Check it:

```bash
docker compose exec codex-image-worker codex login status
# or
kubectl -n <ns> exec deploy/<release>-worker -- codex login status
```

See [codex-authentication.md](codex-authentication.md).

## The sign-in disappears after a restart

`CODEX_HOME` is not on a volume that survives the container. In compose that
is the `codex-home` volume; in the chart it is the `-codex-home` claim, which
is only created when `worker.persistence.codexHome.enabled` is true. With
persistence off, the chart falls back to an `emptyDir`, which is exactly as
temporary as it sounds.

## "The model is not supported when using Codex with a ChatGPT account"

The full error looks like:

```
400 {"detail":"The '<model>' model is not supported when using Codex with a ChatGPT account."}
```

This is not a wrong model name. Measured on 2026-09-11 against Codex CLI
0.48.0, the backend returned it for every model tried, including invented
ones, while the account was an active Plus subscription. Old CLI versions stop
being served for the ChatGPT session auth flow.

The fix is to use a Codex version the backend still accepts. The images pin an
exact version in `services/codex-image-worker/Dockerfile` (`CODEX_VERSION`),
currently 0.154.0. Pinning is deliberate: the worker builds a fixed command
line, and Codex renames flags often enough that following `latest` eventually
breaks every job at once.

## Images generate but the URL does not open

The link is `S3_PUBLIC_BASE_URL` plus the object key, an unsigned GET. Two
things break it:

- **The bucket is not publicly readable.** Either allow anonymous download, or
  switch the storage layer to presigned URLs (`signedUrl()` in
  `packages/artifact-storage/src/s3.ts`).
- **The base URL only resolves server-side.** Pointing it at a cluster service
  name or a compose container name produces links that work nowhere else. It
  has to be the address the MCP client can reach.

## Uploads fail with a DNS error rather than an S3 error

Virtual-hosted-style addressing puts the bucket in the hostname, which needs
wildcard DNS that MinIO, Ceph RGW and most self-hosted gateways do not have.
Set `S3_FORCE_PATH_STYLE=true`, which is the default here for that reason.

## Jobs sit queued and never run

Check the worker is actually consuming: `/health/ready` on the worker reports
the queue connection. If the MCP server and the worker point at different
`REDIS_URL` values, the MCP server happily accepts work nobody will collect.

`create_image` returning `timed_out=true` is not a failure. It means the tool
call gave up waiting, not that the job did; `get_image_job(job_id)` keeps
following it.

## New calls are rejected while the queue is fine

Two limits can do that, and they say which one it is. `QUEUE_LIMIT` caps how
many jobs may be waiting. The per-caller hourly limits cap how many a single
principal may start. Without an authenticating proxy in front, every caller is
`anonymous` and shares one bucket, so one busy client exhausts everyone's
allowance.

## The Codex volume keeps growing

Codex writes its own copy of every generated image under
`$CODEX_HOME/generated_images`, about 0.7 MB per job, whether the job
succeeded or not. Measured 2026-09-12: 9 files and 5.9 MB after one afternoon
of testing. The worker prunes copies older than
`GENERATED_IMAGE_RETENTION_HOURS`, 24 by default. Nothing else does.

## Do not add Python to the worker image

On 2026-09-12 a bug where an image was generated but never landed in the
expected place looked like Codex self-checking with
`python -c "from PIL import Image ..."` against an image that genuinely has no
Python. Installing `python3`, `python3-pil` and `python-is-python3` and
rerunning a real job broke in exactly the same way. The cause was in the
prompt the worker builds, not the image. Adding Python adds weight and fixes
nothing.
