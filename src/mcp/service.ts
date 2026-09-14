// Business logic of imagegen-mcp.
//
// *** NEARLY STATELESS ***
// This service does NOT run Codex, does NOT hold ChatGPT credentials,
// does NOT keep jobs in memory. It only: validates input, normalizes the
// image spec, writes a job record, pushes work onto the queue, and then
// reads status back out.
//
// Thanks to that it can run many replicas and restart freely — all real
// state lives in Redis.

import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import {
  DEFAULT_CANVAS,
  ImagegenError,
  MIME_BY_FORMAT,
  jobToResult,
  resolveStyle,
  sanitizeFreeText,
  sanitizeIdentifier,
} from "../contracts/index.ts";
import type {
  AspectRatio,
  ImageSpec,
  JobRecord,
  OutputFormat,
} from "../contracts/index.ts";
import type { JobQueue, JobStore } from "../queue/index.ts";

export interface ServiceConfig {
  rateLimit: {
    createImagePerHour: number;
    editImagePerHour: number;
  };
}

export interface ServiceDeps {
  store: JobStore;
  queue: JobQueue;
  config: ServiceConfig;
}

export interface JobHandle {
  job_id: string;
  status: "queued";
}

/**
 * `job_id` in the form img_<uuid without dashes>.
 *
 * The random part is wide enough that someone else's job can't be
 * guessed — get_image_job only checks the job_id, so guessing it means
 * reading it.
 */
function newJobId(): string {
  return `img_${randomUUID().replace(/-/g, "")}`;
}

/** Fingerprint of the resolved image spec, written into the artifact metadata. */
function specHash(spec: ImageSpec, extra = ""): string {
  return createHash("sha256").update(JSON.stringify(spec) + extra, "utf8").digest("hex");
}

/**
 * Polling interval for Redis while waiting on a job.
 *
 * 3 seconds: tight enough for the client to see "live" progress, loose
 * enough that a 140-second job only costs ~47 Redis reads. It's also the
 * cadence for emitting notifications/progress, so the stream is never
 * idle — this matters because the network path in front of this service
 * enforces an HTTP idle-stream timeout of around 300s (measured
 * 2026-09-12), and a fully silent connection risks getting killed before
 * the job finishes.
 */
const WAIT_POLL_MS = 3_000;

export class ImagegenService {
  #store: JobStore;
  #queue: JobQueue;
  #cfg: ServiceConfig;

  constructor(deps: ServiceDeps) {
    this.#store = deps.store;
    this.#queue = deps.queue;
    this.#cfg = deps.config;
  }

  // ---------------------------------------------------------------
  // create_image
  // ---------------------------------------------------------------
  async createImage(raw: Record<string, unknown>, principal: string): Promise<JobHandle> {
    await this.#checkRate(principal, this.#cfg.rateLimit.createImagePerHour, 3_600_000);

    const projectId = sanitizeIdentifier(raw.project_id, "project");
    const assetId = sanitizeIdentifier(raw.asset_id, "asset_id");
    const description = sanitizeFreeText(raw.description, "description");

    const styleIn = (raw.style ?? {}) as Record<string, unknown>;
    const extraStyle =
      styleIn.prompt !== undefined
        ? sanitizeFreeText(styleIn.prompt, "style.prompt")
        : undefined;

    let style: { prompt: string; reference: string | null };
    try {
      style = resolveStyle(styleIn.reference as string | undefined, extraStyle);
    } catch (e) {
      // An unknown style profile is a CALLER-fixable error — spell out
      // which names are valid instead of letting it become a vague
      // "generation failed".
      throw new ImagegenError("UNKNOWN_STYLE_PROFILE", (e as Error).message);
    }

    const canvasIn = (raw.canvas ?? {}) as Record<string, unknown>;
    const aspectRatio = ((canvasIn.aspect_ratio as AspectRatio) ?? "1:1") as AspectRatio;
    const defaults = DEFAULT_CANVAS[aspectRatio] ?? DEFAULT_CANVAS["1:1"];

    const outputFormat = ((raw.output_format as OutputFormat) ?? "png") as OutputFormat;
    if (!(outputFormat in MIME_BY_FORMAT)) {
      throw new ImagegenError("UNSUPPORTED_FORMAT", "output_format only accepts png or webp");
    }

    const compIn = (raw.composition ?? {}) as Record<string, unknown>;

    const spec: ImageSpec = {
      projectId,
      assetId,
      description,
      stylePrompt: style.prompt,
      styleReference: style.reference,
      aspectRatio,
      width: (canvasIn.width as number | undefined) ?? defaults.width,
      height: (canvasIn.height as number | undefined) ?? defaults.height,
      // Defaults to TRUE: a web artifact almost always has to be
      // composited onto another background, and a transparent background
      // that wrongly comes out opaque means regenerating from scratch.
      transparentBackground: (raw.transparent_background as boolean | undefined) ?? true,
      outputFormat,
      isolatedObject: (compIn.isolated_object as boolean | undefined) ?? true,
      safePaddingPercent: (compIn.safe_padding_percent as number | undefined) ?? 12,
      // The filename is decided by the WORKER, never taken from the user.
      filename: `artifact.${outputFormat}`,
    };

    const version = (await this.#store.highestAllocatedVersion(projectId, assetId)) + 1;
    const jobId = newJobId();

    await this.#store.create(this.#newRecord(jobId, spec, version, null, principal));
    await this.#queue.enqueue({
      jobId,
      kind: "create",
      spec,
      version,
      parentVersion: null,
      sourceKey: null,
      instructions: null,
    });

    return { job_id: jobId, status: "queued" };
  }

  // ---------------------------------------------------------------
  // edit_image — NEVER overwrites
  // ---------------------------------------------------------------
  async editImage(raw: Record<string, unknown>, principal: string): Promise<JobHandle> {
    await this.#checkRate(principal, this.#cfg.rateLimit.editImagePerHour, 3_600_000);

    const projectId = sanitizeIdentifier(raw.project_id, "project");
    const assetId = sanitizeIdentifier(raw.asset_id, "asset_id");
    const instructions = sanitizeFreeText(raw.instructions, "instructions");
    const sourceVersion = raw.source_version as number | undefined;

    const source = await this.#store.getArtifact(projectId, assetId, sourceVersion);
    if (!source?.artifact) {
      throw new ImagegenError(
        "JOB_NOT_FOUND",
        `No artifact ${projectId}/${assetId}` +
          (sourceVersion ? ` version ${sourceVersion}` : ""),
      );
    }

    const src = source.artifact;
    const outputFormat: OutputFormat = src.mimeType === "image/webp" ? "webp" : "png";

    const spec: ImageSpec = {
      projectId,
      assetId,
      description: instructions,
      stylePrompt: "",
      styleReference: null,
      aspectRatio: "1:1",
      width: src.width,
      height: src.height,
      transparentBackground:
        (raw.transparent_background as boolean | undefined) ?? src.transparent,
      outputFormat,
      isolatedObject: true,
      safePaddingPercent: 12,
      filename: `artifact.${outputFormat}`,
    };

    const version = (await this.#store.highestAllocatedVersion(projectId, assetId)) + 1;
    const jobId = newJobId();

    await this.#store.create(this.#newRecord(jobId, spec, version, src.version, principal));
    await this.#queue.enqueue({
      jobId,
      kind: "edit",
      spec,
      version,
      parentVersion: src.version,
      sourceKey: src.key,
      instructions,
    });

    return { job_id: jobId, status: "queued" };
  }

  // ---------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------
  async getImageJob(jobId: string): Promise<Record<string, unknown>> {
    const job = await this.#store.get(jobId);
    if (!job) throw new ImagegenError("JOB_NOT_FOUND", `No job ${jobId}`);
    return jobToResult(job);
  }

  /**
   * Waits for a job to reach a final state, REPORTING PROGRESS along the
   * way.
   *
   * *** WHY THIS TOOL IS NEEDED INSTEAD OF LETTING THE CLIENT POLL ***
   * Generating an image takes 30-140 seconds. If the client looped
   * get_image_job itself, each round would be a separate tool call, the
   * model would have to decide how long to wait, and the user would stare
   * at a screen showing nothing happening. Folding it into one call that
   * emits `notifications/progress` lets the client show real progress.
   *
   * Holds NO state in the process: it still reads Redis every round, so
   * multiple replicas stay correct. The only thing "stuck" to one pod is
   * the open HTTP connection of this call itself.
   *
   * Timing out is NOT an error: the job keeps running on the worker, we
   * just stop waiting. Returns timed_out=true so the client knows to call
   * again — cancelling the job here would waste ChatGPT quota already
   * spent.
   */
  async waitForImage(
    raw: Record<string, unknown>,
    opts: {
      signal?: AbortSignal;
      onProgress?: (info: { status: string; elapsedMs: number }) => void | Promise<void>;
      /**
       * Polling interval, injectable only for TESTS. NOT exposed in the
       * tool's schema: an MCP caller has no reason to tune the server's
       * Redis read cadence. Tests need it because with the real 3-second
       * cadence, a state transition that happens within a few
       * milliseconds would get missed between two samples.
       */
      pollMs?: number;
    } = {},
  ): Promise<Record<string, unknown>> {
    const jobId = String(raw.job_id ?? "");
    const timeoutMs = Math.round(((raw.timeout_seconds as number | undefined) ?? 300) * 1000);

    const started = Date.now();
    let last: string | null = null;

    for (;;) {
      const job = await this.#store.get(jobId);
      if (!job) throw new ImagegenError("JOB_NOT_FOUND", `No job ${jobId}`);

      if (job.status !== last) {
        last = job.status;
        await opts.onProgress?.({ status: job.status, elapsedMs: Date.now() - started });
      }

      if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
        return { ...jobToResult(job), timed_out: false, waited_seconds: Math.round((Date.now() - started) / 1000) };
      }

      // Client gave up (closed connection/cancelled request): stop waiting,
      // do NOT cancel the job.
      if (opts.signal?.aborted) {
        return { ...jobToResult(job), timed_out: false, aborted: true, waited_seconds: Math.round((Date.now() - started) / 1000) };
      }

      if (Date.now() - started >= timeoutMs) {
        return { ...jobToResult(job), timed_out: true, waited_seconds: Math.round((Date.now() - started) / 1000) };
      }

      await new Promise((r) => setTimeout(r, opts.pollMs ?? WAIT_POLL_MS));
    }
  }

  async getArtifact(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const projectId = sanitizeIdentifier(raw.project_id, "project");
    const assetId = sanitizeIdentifier(raw.asset_id, "asset_id");
    const version = raw.version as number | undefined;

    const job = await this.#store.getArtifact(projectId, assetId, version);
    if (!job) {
      throw new ImagegenError(
        "JOB_NOT_FOUND",
        `No artifact ${projectId}/${assetId}` + (version ? ` v${version}` : ""),
      );
    }
    return jobToResult(job);
  }

  async cancelImageJob(jobId: string): Promise<Record<string, unknown>> {
    const job = await this.#store.get(jobId);
    if (!job) throw new ImagegenError("JOB_NOT_FOUND", `No job ${jobId}`);

    // Cancelling a finished job must NOT delete the artifact — a
    // published version is immutable.
    if (job.status === "completed") {
      throw new ImagegenError("JOB_CANCELLED", "Job already completed, can no longer be cancelled.");
    }

    await this.#queue.requestCancel(jobId);
    const changed = await this.#store.markCancelled(jobId);
    return { job_id: jobId, status: changed ? "cancelled" : job.status };
  }

  // ---------------------------------------------------------------
  #newRecord(
    jobId: string,
    spec: ImageSpec,
    version: number,
    parentVersion: number | null,
    principal: string,
  ): JobRecord {
    void specHash;
    return {
      jobId,
      status: "queued",
      projectId: spec.projectId,
      assetId: spec.assetId,
      version,
      parentVersion,
      principal,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      artifact: null,
      errorCode: null,
      errorMessage: null,
      traceId: null,
    };
  }

  /**
   * The rate limit counts in Redis, not in process memory.
   *
   * This is required because imagegen-mcp runs MULTIPLE replicas: a local
   * count would multiply the effective limit by the replica count, which
   * means it's no longer a limit at all.
   */
  async #checkRate(principal: string, limit: number, windowMs: number): Promise<void> {
    const used = await this.#store.countSince(principal, Date.now() - windowMs);
    if (used >= limit) {
      throw new ImagegenError(
        "RATE_LIMITED",
        `Exceeded the limit of ${limit} calls per ${Math.round(windowMs / 60000)} minutes.`,
      );
    }
  }
}
