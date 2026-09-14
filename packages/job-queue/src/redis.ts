// Redis implementation of JobStore + JobQueue.
//
// Key layout:
//   job:<jobId>                 STRING(JSON)  job record
//   queue:imagegen              LIST          pending work (FIFO)
//   queue:imagegen:processing   LIST          claimed work, not yet acked
//   cancel:<jobId>              STRING        cancellation flag
//   artifact:<proj>:<asset>     ZSET          version -> jobId (every non-failed job)
//   done:<proj>:<asset>         ZSET          version -> jobId (completed jobs only)
//   principal:<name>            ZSET          timestamp -> jobId (rate limiting)
//
// *** WHY BRPOPLPUSH INSTEAD OF BRPOP ***
// BRPOP removes work from the queue and loses track of it: if the worker
// dies mid-job, the work vanishes and the job hangs at "queued" forever.
// BRPOPLPUSH atomically moves it into the `processing` list, leaving a
// trace to clean up. `reapStale()` reads that list when the worker
// restarts.

import { Redis } from "ioredis";
import { ImagegenError } from "@tinyorbit/contracts";
import type { ArtifactRef, JobPayload, JobRecord } from "@tinyorbit/contracts";
import type { JobQueue, JobStore } from "./types.ts";

const QUEUE = "queue:imagegen";
const PROCESSING = "queue:imagegen:processing";

/** Jobs are kept for 30 days and then expire on their own — long enough to look up, without growing forever. */
const JOB_TTL_SECONDS = 30 * 24 * 3600;

export interface RedisOptions {
  url: string;
  /** Cap on pending jobs. Exceeding it means an IMMEDIATE rejection instead of queueing without limit. */
  queueLimit: number;
}

function connect(url: string): Redis {
  return new Redis(url, {
    // Bounded retries: a Redis blip reconnects on its own, but a Redis
    // that's actually down must surface as an error instead of hanging an
    // MCP request indefinitely.
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 200, 2000),
    enableReadyCheck: true,
  });
}

export class RedisJobStore implements JobStore {
  #r: Redis;

  constructor(opts: RedisOptions) {
    this.#r = connect(opts.url);
  }

  get client(): Redis {
    return this.#r;
  }

  async create(job: JobRecord): Promise<void> {
    const m = this.#r.multi();
    m.set(`job:${job.jobId}`, JSON.stringify(job), "EX", JOB_TTL_SECONDS);
    // Write to the "allocated" index RIGHT AT creation, before the job
    // runs — that's what keeps two parallel jobs from being handed the
    // same version.
    m.zadd(`artifact:${job.projectId}:${job.assetId}`, job.version, job.jobId);
    m.zadd(`principal:${job.principal}`, Date.now(), job.jobId);
    // Clean up rate-limit entries older than 24h so the ZSET doesn't grow without bound.
    m.zremrangebyscore(`principal:${job.principal}`, 0, Date.now() - 24 * 3600_000);
    await m.exec();
  }

  async get(jobId: string): Promise<JobRecord | null> {
    const raw = await this.#r.get(`job:${jobId}`);
    return raw ? (JSON.parse(raw) as JobRecord) : null;
  }

  async #update(jobId: string, fn: (j: JobRecord) => JobRecord | null): Promise<boolean> {
    const job = await this.get(jobId);
    if (!job) return false;
    const next = fn(job);
    if (!next) return false;
    await this.#r.set(`job:${jobId}`, JSON.stringify(next), "EX", JOB_TTL_SECONDS);
    return true;
  }

  async markRunning(jobId: string): Promise<void> {
    await this.#update(jobId, (j) =>
      j.status === "queued"
        ? { ...j, status: "running", startedAt: new Date().toISOString() }
        : null,
    );
  }

  async markCompleted(jobId: string, artifact: ArtifactRef): Promise<void> {
    const ok = await this.#update(jobId, (j) => ({
      ...j,
      status: "completed",
      completedAt: new Date().toISOString(),
      artifact,
    }));
    if (ok) {
      await this.#r.zadd(
        `done:${artifact.projectId}:${artifact.assetId}`,
        artifact.version,
        jobId,
      );
    }
  }

  async markFailed(jobId: string, code: string, message: string): Promise<void> {
    await this.#update(jobId, (j) =>
      // A job already in a terminal state is NEVER overwritten: a late
      // cleanup pass must not turn a successful job into a failed one.
      j.status === "completed" || j.status === "cancelled"
        ? null
        : {
            ...j,
            status: "failed",
            completedAt: new Date().toISOString(),
            errorCode: code,
            errorMessage: message,
          },
    );
    // Give the version number back for next time: a broken job must not hold a slot.
    const job = await this.get(jobId);
    if (job) {
      await this.#r.zrem(`artifact:${job.projectId}:${job.assetId}`, jobId);
    }
  }

  async markCancelled(jobId: string): Promise<boolean> {
    const changed = await this.#update(jobId, (j) =>
      j.status === "queued" || j.status === "running"
        ? { ...j, status: "cancelled", completedAt: new Date().toISOString() }
        : null,
    );
    if (changed) {
      const job = await this.get(jobId);
      if (job) await this.#r.zrem(`artifact:${job.projectId}:${job.assetId}`, jobId);
    }
    return changed;
  }

  async highestAllocatedVersion(projectId: string, assetId: string): Promise<number> {
    const top = await this.#r.zrevrange(`artifact:${projectId}:${assetId}`, 0, 0, "WITHSCORES");
    return top.length >= 2 ? Number(top[1]) : 0;
  }

  async getArtifact(
    projectId: string,
    assetId: string,
    version?: number,
  ): Promise<JobRecord | null> {
    const key = `done:${projectId}:${assetId}`;
    let jobId: string | undefined;

    if (version === undefined) {
      const top = await this.#r.zrevrange(key, 0, 0);
      jobId = top[0];
    } else {
      const ids = await this.#r.zrangebyscore(key, version, version);
      jobId = ids[0];
    }
    return jobId ? this.get(jobId) : null;
  }

  async countSince(principal: string, sinceMs: number): Promise<number> {
    return this.#r.zcount(`principal:${principal}`, sinceMs, "+inf");
  }

  async close(): Promise<void> {
    await this.#r.quit();
  }
}

export class RedisJobQueue implements JobQueue {
  #r: Redis;
  /** DEDICATED connection for the blocking command: BRPOPLPUSH holds the
   *  connection, so sharing one connection would queue every other
   *  command behind it. */
  #blocking: Redis;
  #limit: number;

  constructor(opts: RedisOptions) {
    this.#r = connect(opts.url);
    this.#blocking = connect(opts.url);
    this.#limit = opts.queueLimit;
  }

  async enqueue(payload: JobPayload): Promise<void> {
    const depth = await this.#r.llen(QUEUE);
    if (depth >= this.#limit) {
      throw new ImagegenError(
        "RATE_LIMITED",
        `Queue is full (${this.#limit} jobs pending). Try again later.`,
      );
    }
    await this.#r.lpush(QUEUE, JSON.stringify(payload));
  }

  async dequeue(timeoutMs: number): Promise<JobPayload | null> {
    // ioredis takes its timeout in SECONDS; 0 means wait forever, so it
    // must be floored at 1 so the consumer loop can still check for a stop
    // signal.
    const seconds = Math.max(1, Math.round(timeoutMs / 1000));
    const raw = await this.#blocking.brpoplpush(QUEUE, PROCESSING, seconds);
    return raw ? (JSON.parse(raw) as JobPayload) : null;
  }

  async ack(jobId: string): Promise<void> {
    // Remove exactly this job's element from `processing`. Scanning the
    // whole list is fine because it's very short (equal to the number of
    // jobs currently running, 1 by default).
    const items = await this.#r.lrange(PROCESSING, 0, -1);
    for (const it of items) {
      try {
        if ((JSON.parse(it) as JobPayload).jobId === jobId) {
          await this.#r.lrem(PROCESSING, 1, it);
          return;
        }
      } catch {
        // A corrupt element is dropped rather than left stuck forever.
        await this.#r.lrem(PROCESSING, 1, it);
      }
    }
  }

  /**
   * Work still sitting in `processing` when the worker starts up is a
   * leftover from a previous death — the Codex process went down with the
   * pod and will never resume. It's returned so the caller can mark it
   * `failed`, instead of leaving the job stuck at "running" while Claude
   * polls forever.
   */
  async reapStale(): Promise<JobPayload[]> {
    const items = await this.#r.lrange(PROCESSING, 0, -1);
    await this.#r.del(PROCESSING);
    const out: JobPayload[] = [];
    for (const it of items) {
      try {
        out.push(JSON.parse(it) as JobPayload);
      } catch {
        /* drop the corrupt element */
      }
    }
    return out;
  }

  async requestCancel(jobId: string): Promise<void> {
    // 1-hour TTL: the flag only needs to outlive one job, keeping it forever is just garbage.
    await this.#r.set(`cancel:${jobId}`, "1", "EX", 3600);
  }

  async isCancelled(jobId: string): Promise<boolean> {
    return (await this.#r.exists(`cancel:${jobId}`)) === 1;
  }

  async depth(): Promise<number> {
    return this.#r.llen(QUEUE);
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.#r.quit(), this.#blocking.quit()]);
  }
}
