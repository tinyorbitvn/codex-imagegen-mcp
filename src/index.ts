// The only entrypoint. One process, one port, one image.
//
// ROLE decides what runs here:
//   all      the MCP endpoint and the image worker together. Needs nothing
//            else running: an empty REDIS_URL keeps the queue in this
//            process's memory and an empty S3_ENDPOINT writes images to
//            ARTIFACT_DIR, served from /artifacts on this same port.
//   mcp      the MCP endpoint only, for a split deployment.
//   worker   the image worker only, for a split deployment.
//
// The split roles need a real Redis and real object storage, and
// loadConfig() refuses to start without them rather than letting a
// two-process deployment quietly fail to share anything.

import express from "express";

import { log, setServiceName } from "./contracts/index.ts";
import { loadConfig } from "./config.ts";
import { createArtifactStore } from "./storage/index.ts";
import {
  InMemoryJobQueue,
  InMemoryJobStore,
  RedisJobQueue,
  RedisJobStore,
} from "./queue/index.ts";
import type { JobStore } from "./queue/index.ts";
import { ImagegenService } from "./mcp/service.ts";
import { mountMcp } from "./mcp/server.ts";
import { mountArtifacts } from "./artifacts.ts";
import { startWorker } from "./worker/main.ts";
import type { ReapableQueue, RunningWorker } from "./worker/main.ts";
import { metrics } from "./worker/metrics.ts";
import { startTelemetry } from "./telemetry.ts";

const config = loadConfig();

// One service name for every role: they are one process and one image now,
// and splitting the name by role would split the logs and traces of a
// single deployment into two halves that look unrelated.
setServiceName("codex-imagegen-mcp");
await startTelemetry("codex-imagegen-mcp", config.otlpEndpoint);

// --- Queue and store -------------------------------------------------
let store: JobStore;
let queue: ReapableQueue;
let queueCheck: { name: string; probe: () => Promise<boolean> };

if (config.queue.kind === "redis") {
  const redisStore = new RedisJobStore({ url: config.queue.url, queueLimit: config.queue.limit });
  store = redisStore;
  queue = new RedisJobQueue({ url: config.queue.url, queueLimit: config.queue.limit });
  // Keeps the name the readiness payload has always used, so an existing
  // scraper or runbook that looks for checks.redis still finds it.
  queueCheck = {
    name: "redis",
    probe: async () => {
      try {
        await redisStore.client.ping();
        return true;
      } catch {
        return false;
      }
    },
  };
} else {
  store = new InMemoryJobStore();
  queue = new InMemoryJobQueue(config.queue.limit);
  // Nothing to ping: the queue is this process's own memory, so if this
  // probe is running at all, the queue is up.
  queueCheck = { name: "queue", probe: async () => true };
}

const storage = createArtifactStore(config.storage);

// --- The one app -----------------------------------------------------
const app = express();
const servesMcp = config.role === "all" || config.role === "mcp";
const runsWorker = config.role === "all" || config.role === "worker";

if (servesMcp) {
  const service = new ImagegenService({
    store,
    queue,
    config: { rateLimit: config.mcp.rateLimit },
  });
  mountMcp(app, { service });
  // Only the MCP roles serve images: the worker has no route in front of
  // it and clients are never handed its address.
  if (config.storage.kind === "local") mountArtifacts(app, config.storage.dir);
}

let worker: RunningWorker | null = null;
if (runsWorker) {
  worker = await startWorker({
    store,
    queue,
    storage,
    config: config.worker,
    queueCheck,
  });
}

// live: only asks whether the process is still running. Does NOT check
// external dependencies — otherwise a Redis blip would make kubelet kill
// the whole pod fleet at once, and it shouldn't kill a worker that is
// busy generating an image either.
app.get("/health/live", (_req, res) => {
  res.json({ status: "ok" });
});

// ready: the checks for whatever this role actually runs, merged into the
// same { status, checks } shape both services have always returned.
app.get("/health/ready", async (_req, res) => {
  const checks: Record<string, boolean> = {};
  if (worker) Object.assign(checks, await worker.checks());
  if (servesMcp) {
    checks.mcp = true;
    // In ROLE=all the worker's checks already include the queue; probing
    // it a second time in the same request buys nothing.
    if (!(queueCheck.name in checks)) checks[queueCheck.name] = await queueCheck.probe();
  }
  const ready = Object.values(checks).every(Boolean);
  res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not-ready", checks });
});

/** Queue depth, the one metric the MCP half owns. */
async function renderQueueMetrics(): Promise<string> {
  let depth = -1;
  try {
    depth = await queue.depth();
  } catch {
    /* keep -1 to distinguish "couldn't read" from "empty" */
  }
  return [
    "# HELP imagegen_queue_depth Number of jobs waiting in the queue",
    "# TYPE imagegen_queue_depth gauge",
    `imagegen_queue_depth ${depth}`,
    "",
  ].join("\n");
}

// One endpoint for the whole process: in ROLE=all both registries are
// rendered and concatenated, because a scraper sees one pod and one port
// and must not have to know which halves are running inside it. Each
// registry's text already ends in a newline, so they concatenate cleanly.
app.get("/metrics", async (_req, res) => {
  const parts: string[] = [];
  if (servesMcp) parts.push(await renderQueueMetrics());
  if (runsWorker) parts.push(metrics.render());
  res.type("text/plain; version=0.0.4").send(parts.join(""));
});

const server = app.listen(config.port, () => {
  // ONE line naming everything that was chosen for us, first thing in the
  // log. A deployment that meant to use Redis and silently got the
  // in-process queue is otherwise invisible until jobs stop being picked
  // up by the other pod twenty minutes later.
  log.info("codex-imagegen-mcp listening", {
    port: config.port,
    role: config.role,
    queue: config.queue.kind,
    storage: config.storage.kind,
    public_base_url: config.publicBaseUrl,
  });
});

// Graceful shutdown: stop accepting new work, wait for in-flight work to
// finish, then close connections.
let stopping = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    // A second signal while already draining is ignored: SIGINT twice from
    // a terminal must not run the teardown twice.
    if (stopping) return;
    stopping = true;
    log.info("received stop signal, waiting for in-flight job to finish", { signal: sig });

    // Stops accepting NEW connections. Requests already in flight keep
    // their socket, so a client waiting on create_image is not cut off
    // just for being slow.
    server.close();

    void (async () => {
      if (worker) await worker.shutdown();
      await Promise.allSettled([store.close(), queue.close()]);
      // Exiting here drops any connection still open. That is safe: the
      // job record is already durable in the store, so a client whose
      // stream was cut reads the finished artifact back with
      // get_image_job.
      process.exit(0);
    })();
  });
}
