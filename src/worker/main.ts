// The image worker: consumes the queue, runs Codex, pushes the artifact.
//
// *** THIS FILE STARTS A LOOP, IT DOES NOT START A SERVER ***
// It used to be a service entrypoint with its own express app, its own
// /health and /metrics routes and its own signal handlers. In ROLE=all the
// MCP endpoint and the worker share one process and therefore one port, so
// the HTTP side and the signal handling live in src/index.ts and this file
// hands back the two things the process needs from it: the readiness
// checks, and a way to stop.

import { access, constants, mkdir } from "node:fs/promises";

import { log } from "../contracts/index.ts";
import type { JobPayload } from "../contracts/index.ts";
import type { JobQueue, JobStore } from "../queue/index.ts";
import type { ArtifactStore } from "../storage/index.ts";
import type { Config } from "../config.ts";

import { Consumer } from "./consumer.ts";
import { isCodexAuthenticated, isCodexAvailable } from "./runner.ts";

/**
 * The queue, plus stale-job reaping.
 *
 * reapStale() is deliberately NOT on the JobQueue interface: it only makes
 * sense for a queue that can lose track of claimed work when a process
 * dies, which is a property of the implementation (Redis BRPOPLPUSH leaves
 * a `processing` list behind) rather than of the contract. Both shipped
 * implementations have it, so asking for it here costs nothing.
 */
export type ReapableQueue = JobQueue & { reapStale(): Promise<JobPayload[]> };

export interface WorkerDeps {
  store: JobStore;
  queue: ReapableQueue;
  storage: ArtifactStore;
  config: Config["worker"];
  /**
   * The queue's own health check, named the way the readiness payload
   * reports it. Built by the caller because only it knows whether the
   * queue is Redis (ping it) or in-process (nothing to ping).
   */
  queueCheck: { name: string; probe: () => Promise<boolean> };
}

export interface RunningWorker {
  /** Readiness checks for the worker half of the process. */
  checks(): Promise<Record<string, boolean>>;
  /** Stops taking new work and waits for the job in flight to finish. */
  shutdown(): Promise<void>;
}

export async function startWorker(deps: WorkerDeps): Promise<RunningWorker> {
  const { store, queue, storage, config, queueCheck } = deps;

  const consumer = new Consumer({ store, queue, storage, config });

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

  // The loop runs until stop() is called; run() resolves once the job in
  // flight has finished, which is what shutdown() below waits on.
  const loop = consumer.run();
  log.info("worker started", { concurrency: config.concurrency });

  return {
    // Whether we're fit to take work.
    //
    // DELIBERATELY does NOT generate a test image — the probe runs every few
    // tens of seconds, and every image generated is real ChatGPT quota spent.
    //
    // ChatGPT session expired -> ready=false. The worker does NOT silently
    // fall back to OPENAI_API_KEY — no code path does that.
    async checks(): Promise<Record<string, boolean>> {
      const checks: Record<string, boolean> = {
        work_dir_writable: false,
        codex_present: false,
        codex_authenticated: false,
        storage_reachable: false,
        [queueCheck.name]: false,
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
      checks[queueCheck.name] = await queueCheck.probe();
      return checks;
    },

    async shutdown(): Promise<void> {
      log.info("stopping the worker, waiting for the job in flight to finish");
      consumer.stop();
      await loop;
    },
  };
}
