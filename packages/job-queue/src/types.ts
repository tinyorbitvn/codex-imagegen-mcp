// Job queue + status store abstraction.
//
// *** WHY THIS ABSTRACTION LAYER EXISTS ***
// Redis is the current choice, not a permanent one. The two interfaces
// below are the entirety of what imagegen-mcp and codex-image-worker are
// allowed to know; switching to Postgres/NATS/SQS later only means writing
// one new implementation, without touching business logic.
//
// This is NOT premature abstraction for its own sake: keeping Redis
// replaceable is a deliberate goal, and the cost of that here is exactly
// two interfaces.

import type { JobPayload, JobRecord, JobStatus, ArtifactRef } from "@tinyorbit/contracts";

/**
 * Job status store. MUST be durable across restarts: restarting
 * imagegen-mcp / worker / gateway must not lose the artifact metadata of a
 * completed job.
 */
export interface JobStore {
  create(job: JobRecord): Promise<void>;
  get(jobId: string): Promise<JobRecord | null>;

  markRunning(jobId: string): Promise<void>;
  markCompleted(jobId: string, artifact: ArtifactRef): Promise<void>;
  markFailed(jobId: string, code: string, message: string): Promise<void>;
  /** Returns false if the job is already in a terminal state (can't cancel back out of it). */
  markCancelled(jobId: string): Promise<boolean>;

  /**
   * Highest version number ALREADY ALLOCATED for an artifact, including a
   * job that's still running. Allocating a new number must be based on
   * this, NOT on the highest completed version — otherwise two parallel
   * jobs on the same asset get handed the same number and the later one
   * overwrites the earlier one in object storage.
   */
  highestAllocatedVersion(projectId: string, assetId: string): Promise<number>;

  /** Omit `version` for the latest completed version. */
  getArtifact(
    projectId: string,
    assetId: string,
    version?: number,
  ): Promise<JobRecord | null>;

  /** Counts a principal's jobs since a timestamp — used for rate limiting. */
  countSince(principal: string, sinceMs: number): Promise<number>;

  close(): Promise<void>;
}

/** Work queue between imagegen-mcp (producer) and the worker (consumer). */
export interface JobQueue {
  /** Pushes work onto the queue. Throws RATE_LIMITED when the queue is already full. */
  enqueue(payload: JobPayload): Promise<void>;

  /**
   * Waits to claim a piece of work. Returns null once `timeoutMs` elapses
   * with nothing available — so the consumer loop can still check a stop
   * signal instead of blocking forever.
   */
  dequeue(timeoutMs: number): Promise<JobPayload | null>;

  /** Reports a job as done processing so the queue drops it from the running list. */
  ack(jobId: string): Promise<void>;

  /** Sets the cancellation flag. The worker reads this flag between stages and while running Codex. */
  requestCancel(jobId: string): Promise<void>;
  isCancelled(jobId: string): Promise<boolean>;

  /** Number of jobs pending — used for metrics and for the rejection threshold. */
  depth(): Promise<number>;

  close(): Promise<void>;
}

export type { JobPayload, JobRecord, JobStatus, ArtifactRef };
