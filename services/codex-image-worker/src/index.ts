// codex-image-worker — consumes the queue, runs Codex, pushes the artifact.
//
// Exposes NO MCP, has NO HTTPRoute. The only HTTP port serves health
// probes and metrics, listening in-cluster only.

import express from "express";
import { access, constants, mkdir } from "node:fs/promises";

import { log, setServiceName } from "@tinyorbit/contracts";
import { RedisJobQueue, RedisJobStore } from "@tinyorbit/job-queue";
import { ArtifactStorage } from "@tinyorbit/artifact-storage";

import { loadConfig } from "./config.ts";
import { Consumer } from "./consumer.ts";
import { isCodexAuthenticated, isCodexAvailable } from "./runner.ts";
import { metrics } from "./metrics.ts";
import { startTelemetry } from "./telemetry.ts";

setServiceName("codex-image-worker");
const config = loadConfig();
await startTelemetry("codex-image-worker", config.otlpEndpoint);

const store = new RedisJobStore({ url: config.redisUrl, queueLimit: config.queueLimit });
const queue = new RedisJobQueue({ url: config.redisUrl, queueLimit: config.queueLimit });
const storage = new ArtifactStorage(config.s3);

const consumer = new Consumer({
  store,
  queue,
  storage,
  config: {
    workDir: config.workDir,
    codexHome: config.codexHome,
    codexBinary: config.codexBinary,
    jobTimeoutSeconds: config.jobTimeoutSeconds,
    concurrency: config.concurrency,
    generatedImageRetentionHours: config.generatedImageRetentionHours,
  },
});

// Anything still sitting in the `processing` list at startup is a
// leftover from a previous death: its Codex process went down with the
// pod and will never continue. Mark it failed right away, instead of
// leaving the job stuck in "running" while Claude polls forever.
const stale = await queue.reapStale();
for (const p of stale) {
  await store.markFailed(
    p.jobId,
    "IMAGE_GENERATION_FAILED",
    "Worker restarted while the job was running",
  );
}
if (stale.length > 0) {
  log.warn("marked stale jobs from the previous run as failed", { count: stale.length });
}

const app = express();

// live: only asks whether the process is still running. Does NOT check
// external dependencies — a Redis blip shouldn't get kubelet to kill a
// worker that's busy generating an image.
app.get("/health/live", (_req, res) => {
  res.json({ status: "ok" });
});

// ready: whether we're fit to take work.
//
// DELIBERATELY does NOT generate a test image — the probe runs every few
// tens of seconds, and every image generated is real ChatGPT quota spent.
app.get("/health/ready", async (_req, res) => {
  const checks: Record<string, boolean> = {
    work_dir_writable: false,
    codex_present: false,
    codex_authenticated: false,
    storage_reachable: false,
    redis: false,
  };

  try {
    await mkdir(config.workDir, { recursive: true });
    await access(config.workDir, constants.W_OK);
    checks.work_dir_writable = true;
  } catch {
    /* leave false */
  }

  checks.codex_present = await isCodexAvailable(config.codexBinary);
  checks.codex_authenticated = await isCodexAuthenticated(config.codexHome);
  checks.storage_reachable = await storage.isReachable();
  try {
    await store.client.ping();
    checks.redis = true;
  } catch {
    /* leave false */
  }

  const ready = Object.values(checks).every(Boolean);
  // ChatGPT session expired -> ready=false. The worker does NOT silently
  // fall back to OPENAI_API_KEY — no code path does that.
  res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not-ready", checks });
});

app.get("/metrics", (_req, res) => {
  res.type("text/plain; version=0.0.4").send(metrics.render());
});

const server = app.listen(config.port, () => {
  log.info("codex-image-worker listening", {
    port: config.port,
    concurrency: config.concurrency,
  });
});

void consumer.run();

// Graceful shutdown: stop accepting new work, wait for in-flight work to
// finish, then close connections.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    log.info("received stop signal, waiting for in-flight job to finish", { signal: sig });
    consumer.stop();
    server.close(() => {
      void Promise.allSettled([store.close(), queue.close()]).then(() => process.exit(0));
    });
  });
}
