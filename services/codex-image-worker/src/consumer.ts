// Queue-consuming loop that runs Codex.
//
// This is the ONLY component that touches the ChatGPT credential. Neither
// agentgateway, imagegen-mcp, nor Redis can mount the codex-home PVC.

import { mkdir, writeFile, rm, access, readdir, stat, copyFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ImagegenError,
  MIME_BY_FORMAT,
  log,
  toImagegenError,
} from "@tinyorbit/contracts";
import type { ArtifactRef, JobPayload } from "@tinyorbit/contracts";
import type { JobQueue, JobStore } from "@tinyorbit/job-queue";
import type { ArtifactStorage } from "@tinyorbit/artifact-storage";

import { buildCreatePrompt, buildEditPrompt, specHash } from "./prompt.ts";
import { classifyCodexFailure, runCodex } from "./runner.ts";
import type { CodexResult } from "./runner.ts";
import { metrics } from "./metrics.ts";
import { readImageInfo } from "./imagesize.ts";

/** Lets tests swap the real Codex for a fake function. */
export type CodexRunner = (opts: {
  binary: string;
  codexHome: string;
  prompt: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}) => Promise<CodexResult>;

export interface ConsumerConfig {
  workDir: string;
  codexHome: string;
  codexBinary: string;
  jobTimeoutSeconds: number;
  concurrency: number;
  /** Defaults to 24 if not passed. 0 = never clean up. */
  generatedImageRetentionHours?: number;
}

export interface ConsumerDeps {
  store: JobStore;
  queue: JobQueue;
  storage: ArtifactStorage;
  config: ConsumerConfig;
  runner?: CodexRunner;
}

/** S3 key layout for the artifact. Built from already-sanitized pieces. */
export function artifactKey(
  projectId: string,
  assetId: string,
  version: number,
  filename: string,
): string {
  return `projects/${projectId}/${assetId}/v${version}/${filename}`;
}

/**
 * Salvages an image Codex ALREADY GENERATED but never put in the right place.
 *
 * Codex's image-generation tool saves into
 * $CODEX_HOME/generated_images/<session>/ and Codex is then supposed to
 * copy it to the path we requested. That copy step can fail to happen
 * while the process STILL EXITS CODE 0 — a silent failure. Measured in a
 * real pod on 2026-09-12: 9 orphaned PNG files (5.3M), timestamps lining
 * up exactly with the "failed" jobs. The image had already been
 * generated and had ALREADY SPENT a unit of ChatGPT quota; throwing it
 * away is throwing away real money.
 *
 * The root cause has been found and fixed in prompt.ts (specifically, the
 * clause forbidding reads outside our own directory, which made Codex
 * refuse to copy back the image it had just generated). This function
 * stays in place as a SAFETY NET: Codex's exit code never reflects
 * whether the file actually exists, so as long as we depend on it
 * copying the file itself, we still need a backstop here. Logged at warn
 * level so we can see the frequency — if it drops to zero for a long
 * stretch, the prompt fix is doing its job well enough on its own.
 *
 * WARNING if you touch this: do NOT try to "fix" it by installing python
 * in the image. Tried this 2026-09-12 (on the theory that Codex was
 * failing a self-check using PIL) — rebuilt the image with python3 +
 * PIL, ran a real job, STILL BROKE THE SAME WAY.
 *
 * The `>= startedAtMs` cutoff is a mandatory guard: an image from a
 * previous job must never slip through, since handing back the wrong
 * image is worse than reporting a failure.
 */
export async function salvageGeneratedImage(
  codexHome: string,
  target: string,
  startedAtMs: number,
): Promise<string | null> {
  const root = join(codexHome, "generated_images");
  let sessions: string[];
  try {
    sessions = await readdir(root);
  } catch {
    return null;
  }

  let best: { path: string; mtimeMs: number } | null = null;
  for (const session of sessions) {
    let files: string[];
    try {
      files = await readdir(join(root, session));
    } catch {
      continue; // not a directory, or was just cleaned up
    }
    for (const f of files) {
      if (!/\.(png|jpe?g|webp)$/i.test(f)) continue;
      const full = join(root, session, f);
      try {
        const st = await stat(full);
        if (st.mtimeMs >= startedAtMs && (!best || st.mtimeMs > best.mtimeMs)) {
          best = { path: full, mtimeMs: st.mtimeMs };
        }
      } catch {
        // file disappeared mid-scan
      }
    }
  }

  if (!best) return null;
  await copyFile(best.path, target);
  return best.path;
}


/**
 * Cleans up old images in the image-generation tool's own private store.
 *
 * Codex leaves a copy behind in $CODEX_HOME/generated_images/<session>/
 * AFTER EVERY job — including successful ones, once the image is already
 * safely on S3. Without cleanup, the codex-home PVC grows without bound:
 * measured 2026-09-12 at 9 files / 5.9MB after one afternoon of testing,
 * roughly 0.7MB per run.
 *
 * Cleans up by AGE, not by job: this function runs after a job finishes,
 * while salvageGeneratedImage() needs to read this same store while a job
 * is still in flight. Cutting by age means the two never step on each
 * other, even once concurrency is later raised above 1.
 *
 * All errors are swallowed: this is housekeeping, not worth failing an
 * otherwise-completed job over.
 */
export async function pruneGeneratedImages(
  codexHome: string,
  maxAgeMs: number,
  now = Date.now(),
): Promise<number> {
  if (maxAgeMs <= 0) return 0;
  const root = join(codexHome, "generated_images");
  let sessions: string[];
  try {
    sessions = await readdir(root);
  } catch {
    return 0;
  }

  let removed = 0;
  for (const session of sessions) {
    const dir = join(root, session);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    let remaining = files.length;
    for (const f of files) {
      const full = join(dir, f);
      try {
        const st = await stat(full);
        if (now - st.mtimeMs <= maxAgeMs) continue;
        await rm(full, { force: true });
        removed += 1;
        remaining -= 1;
      } catch {
        /* ignore */
      }
    }
    // Drop an empty session directory right away, so we don't end up
    // leaving hundreds of empty directories behind.
    if (remaining === 0) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return removed;
}

export class Consumer {
  #store: JobStore;
  #queue: JobQueue;
  #storage: ArtifactStorage;
  #cfg: ConsumerConfig;
  #runCodex: CodexRunner;
  #stopping = false;
  #active = 0;

  constructor(deps: ConsumerDeps) {
    this.#store = deps.store;
    this.#queue = deps.queue;
    this.#storage = deps.storage;
    this.#cfg = deps.config;
    this.#runCodex = deps.runner ?? runCodex;
  }

  get active(): number {
    return this.#active;
  }

  stop(): void {
    this.#stopping = true;
  }

  /**
   * Main loop. Runs until stop() is called.
   *
   * Concurrency defaults to 1: one ChatGPT session can only drive one
   * Codex process at a time. Configurable to raise later, but do NOT raise the default.
   */
  async run(): Promise<void> {
    log.info("consumer started", {
      concurrency: this.#cfg.concurrency,
      work_dir: this.#cfg.workDir,
    });

    while (!this.#stopping) {
      if (this.#active >= this.#cfg.concurrency) {
        await sleep(100);
        continue;
      }

      let payload: JobPayload | null = null;
      try {
        // Wait up to 5 seconds, then recheck the stop flag — so the pod
        // shuts down within a few seconds instead of hanging until
        // kubelet SIGKILLs it.
        payload = await this.#queue.dequeue(5000);
      } catch (err) {
        log.error("failed to read from queue", { err });
        await sleep(1000);
        continue;
      }
      if (!payload) continue;

      this.#active += 1;
      void this.#handle(payload).finally(() => {
        this.#active -= 1;
      });
    }

    // Wait for in-flight work to finish before returning control to the caller.
    while (this.#active > 0) await sleep(100);
    log.info("consumer stopped");
  }

  async #handle(payload: JobPayload): Promise<void> {
    const started = Date.now();
    const { jobId, spec } = payload;
    const jobDir = join(this.#cfg.workDir, jobId);
    const controller = new AbortController();

    metrics.jobStarted();
    let codexExitCode = -1;
    let uploadMs = 0;
    let ok = false;

    try {
      // If the job was cancelled while still sitting in the queue, don't
      // spend a Codex run on it — that's real quota.
      if (await this.#queue.isCancelled(jobId)) {
        await this.#store.markCancelled(jobId);
        return;
      }

      await this.#store.markRunning(jobId);

      // A SEPARATE directory per job. The name contains a UUID and the
      // worker never builds a path from a user-supplied string, so no job
      // can ever read another job's directory.
      await mkdir(jobDir, { recursive: true, mode: 0o700 });

      let prompt: string;
      if (payload.kind === "edit") {
        const sourceFilename = `source.${spec.outputFormat}`;
        const buf = await this.#storage.download(payload.sourceKey!);
        await writeFile(join(jobDir, sourceFilename), buf, { mode: 0o600 });
        prompt = buildEditPrompt(spec, payload.instructions ?? "", sourceFilename, jobDir);
      } else {
        prompt = buildCreatePrompt(spec, jobDir);
      }

      // Watch the cancel flag while Codex is running: without this loop,
      // cancel_image_job would only flip a status on paper while the
      // Codex process kept running to completion and still burned quota.
      const watcher = setInterval(() => {
        void this.#queue.isCancelled(jobId).then((c) => {
          if (c) controller.abort();
        });
      }, 2000);

      let result: CodexResult;
      try {
        result = await this.#runCodex({
          binary: this.#cfg.codexBinary,
          codexHome: this.#cfg.codexHome,
          prompt,
          cwd: jobDir,
          timeoutMs: this.#cfg.jobTimeoutSeconds * 1000,
          signal: controller.signal,
        });
      } finally {
        clearInterval(watcher);
      }

      codexExitCode = result.exitCode;
      metrics.codexRan(result.durationMs / 1000);

      if (result.exitCode !== 0) {
        const code = classifyCodexFailure(result.stderrTail);
        // stderr ONLY goes to server-side logs (secrets already filtered
        // out), NEVER back over MCP.
        log.warn("codex exited with non-zero status", {
          job_id: jobId,
          codex_exit_code: result.exitCode,
          classified: code,
          stderr_tail: result.stderrTail,
        });
        throw new ImagegenError(code, messageFor(code));
      }

      // Codex exiting 0 does NOT guarantee the file landed where expected
      // — see salvageGeneratedImage. Check, then salvage, before
      // concluding it failed.
      const outPath = join(jobDir, spec.filename);
      try {
        await access(outPath);
      } catch {
        const saved = await salvageGeneratedImage(this.#cfg.codexHome, outPath, started);
        if (!saved) {
          log.warn("codex exited 0 but produced no image, and none could be salvaged", {
            job_id: jobId,
          });
          throw new ImagegenError(
            "IMAGE_GENERATION_FAILED",
            messageFor("IMAGE_GENERATION_FAILED"),
          );
        }
        // Warn level rather than silent: this is a workaround for
        // erratic Codex behavior, and we need visibility into how often
        // it happens to know when upstream has actually fixed it.
        log.warn("codex did not place the image correctly — salvaged it from generated_images", {
          job_id: jobId,
        });
      }

      // *** MEASURE THE REAL IMAGE, DON'T ECHO THE REQUEST ***
      // The old version wrote `width: spec.width` — i.e. it re-declared
      // the number we ASKED FOR, not the number we ACTUALLY GOT. Measured
      // on a real job 2026-09-12: asked for 1536x1536, Codex returned
      // 1254x1254, and the metadata still claimed 1536x1536. Claude reads
      // that metadata and builds a layout on the wrong assumption, with
      // no one the wiser.
      //
      // If the header can't be read, FALL BACK to the spec and log it,
      // rather than failing the whole job: the image is still usable,
      // just with a less trustworthy measurement.
      const info = await readImageInfo(outPath);
      if (!info) {
        log.warn("could not read image dimensions, falling back to the spec's numbers", {
          job_id: jobId,
          output_format: spec.outputFormat,
        });
      } else if (info.width !== spec.width || info.height !== spec.height) {
        // Not an error: the generation model has its own sense of aspect
        // ratio. Logged so we can see how large the typical drift is.
        log.info("image dimensions differ from the spec", {
          job_id: jobId,
          requested: `${spec.width}x${spec.height}`,
          received: `${info.width}x${info.height}`,
        });
      }
      if (info && spec.transparentBackground && !info.hasAlpha) {
        // THIS is actually worth flagging: we asked for a transparent
        // background but the image has no alpha channel, so it's
        // definitely not transparent.
        log.warn("requested a transparent background but the image has no alpha channel", {
          job_id: jobId,
        });
      }

      const mimeType = MIME_BY_FORMAT[spec.outputFormat];
      const key = artifactKey(spec.projectId, spec.assetId, payload.version, spec.filename);
      const upload = await this.#storage.uploadArtifact(outPath, key, mimeType);
      uploadMs = upload.durationMs;
      metrics.uploaded(uploadMs / 1000);

      const artifact: ArtifactRef = {
        projectId: spec.projectId,
        assetId: spec.assetId,
        version: payload.version,
        parentVersion: payload.parentVersion,
        key,
        url: upload.url,
        mimeType,
        width: info?.width ?? spec.width,
        height: info?.height ?? spec.height,
        // `transparent` describes the FILE, so it's taken from the file.
        // The boundary of this flag is documented on ImageInfo.hasAlpha:
        // "has an alpha channel", not "has transparent pixels".
        transparent: info?.hasAlpha ?? spec.transparentBackground,
        specHash: specHash(prompt),
        createdAt: new Date().toISOString(),
      };

      // metadata.json sits next to the image. Contains NO credentials,
      // and NOT the raw spec — only its hash.
      await this.#storage.uploadMetadata(
        artifactKey(spec.projectId, spec.assetId, payload.version, "metadata.json"),
        {
          project_id: artifact.projectId,
          asset_id: artifact.assetId,
          version: artifact.version,
          parent_version: artifact.parentVersion,
          job_id: jobId,
          content_type: artifact.mimeType,
          width: artifact.width,
          height: artifact.height,
          transparent: artifact.transparent,
          style_reference: spec.styleReference,
          spec_hash: artifact.specHash,
          generator: "codex-chatgpt-image",
          created_at: artifact.createdAt,
        },
      );

      await this.#store.markCompleted(jobId, artifact);
      ok = true;
    } catch (err) {
      if (controller.signal.aborted || (err as Error).message === "CANCELLED") {
        await this.#store.markCancelled(jobId);
      } else {
        const e = toImagegenError(err, "IMAGE_GENERATION_FAILED");
        await this.#store.markFailed(jobId, e.code, e.message);
      }
    } finally {
      // Clean up the job directory whether it succeeded or failed: the
      // image has already made it to object storage, so keeping it
      // around only fills up the emptyDir until the node runs out of
      // disk.
      await rm(jobDir, { recursive: true, force: true }).catch(() => {});

      // Clean up Codex's own image store (see pruneGeneratedImages).
      // Don't let this break the job's exit path: the function already
      // swallows its own errors, this is one more layer of protection.
      try {
        const retentionHours = this.#cfg.generatedImageRetentionHours ?? 24;
        const n = await pruneGeneratedImages(this.#cfg.codexHome, retentionHours * 3_600_000);
        if (n > 0) log.info("cleaned up old images in Codex's store", { files_removed: n });
      } catch {
        /* a failed cleanup is not worth failing over */
      }
      await this.#queue.ack(jobId);

      const durationMs = Date.now() - started;
      metrics.jobFinished(durationMs / 1000, ok);
      const final = await this.#store.get(jobId).catch(() => null);
      log.info("job finished", {
        job_id: jobId,
        project_id: spec.projectId,
        asset_id: spec.assetId,
        version: payload.version,
        status: final?.status ?? "unknown",
        duration_ms: durationMs,
        codex_exit_code: codexExitCode,
        artifact_upload_duration_ms: uploadMs,
      });
    }
  }
}

function messageFor(code: string): string {
  switch (code) {
    case "CODEX_NOT_AUTHENTICATED":
      return (
        "The worker's ChatGPT login session has expired. " +
        "An operator needs to run `codex login --device-auth` in the pod again."
      );
    case "IMAGE_CAPABILITY_UNAVAILABLE":
      // State plainly that the capability is missing, and make it
      // explicit that there is NO fallback through an API key — so no one
      // tries to "fix" it that way.
      return (
        "The currently logged-in ChatGPT account cannot use Codex's " +
        "image-generation capability. The platform does NOT automatically fall " +
        "back to an OpenAI API key; an account/plan with image-generation " +
        "support is required."
      );
    default:
      return "Codex failed to generate the image. Check codex-image-worker's logs for this job_id.";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
