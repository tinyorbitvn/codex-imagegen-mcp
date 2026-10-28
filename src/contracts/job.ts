// Job model SHARED between the MCP role and the worker role.
//
// This is the reason the `contracts` package exists: the two services run
// in two different pods but must agree exactly on the shape of a job.
// Defining it twice would drift sooner or later — and the drift would show
// up as a job silently breaking, not as a compile error.

import type { AnimationInfo, AnimationRequest } from "./animation.ts";
import type { AspectRatio, OutputFormat } from "./schemas.ts";

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

/** Terminal states — once a job is here, it never changes again. */
export const TERMINAL_STATUSES: readonly JobStatus[] = [
  "completed",
  "failed",
  "cancelled",
];

export function isTerminal(s: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(s);
}

/**
 * NORMALIZED image spec.
 *
 * imagegen-mcp takes raw MCP input, sanitizes it and fills in defaults, and
 * only then builds this structure. The worker NEVER sees a raw user string
 * except the three filtered text fields below — which means the part that
 * builds the Codex command only has to trust one source.
 */
export interface ImageSpec {
  projectId: string;
  assetId: string;
  description: string;
  /** Already merged: style profile (if any) + the caller's extra prompt. */
  stylePrompt: string;
  /** Name of the style profile used, to record in metadata. */
  styleReference: string | null;
  aspectRatio: AspectRatio;
  width: number;
  height: number;
  transparentBackground: boolean;
  outputFormat: OutputFormat;
  isolatedObject: boolean;
  safePaddingPercent: number;
  /** Output filename inside the job directory. Set by the worker, not the user. */
  filename: string;
}

/** The work the worker has to do. */
export interface JobPayload {
  jobId: string;
  kind: "create" | "edit" | "animate";
  spec: ImageSpec;
  version: number;
  /** Present when kind is "edit" or "animate". */
  parentVersion: number | null;
  /** S3 key of the source image, present when kind is "edit" or "animate". */
  sourceKey: string | null;
  /** Only present when kind="edit": sanitized edit instructions. */
  instructions: string | null;
  /** Only present when kind="animate". */
  animation?: AnimationRequest;
}

export interface ArtifactRef {
  projectId: string;
  assetId: string;
  version: number;
  parentVersion: number | null;
  key: string;
  url: string;
  mimeType: string;
  width: number;
  height: number;
  transparent: boolean;
  specHash: string;
  createdAt: string;
  /**
   * Set only on animate_image output. edit_image and animate_image refuse
   * such a source: both work on a single still frame.
   */
  animation?: AnimationInfo;
}

export interface JobRecord {
  jobId: string;
  status: JobStatus;
  projectId: string;
  assetId: string;
  version: number;
  parentVersion: number | null;
  /** Calling principal, taken from the JWT claim forwarded by agentgateway. */
  principal: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  artifact: ArtifactRef | null;
  errorCode: string | null;
  errorMessage: string | null;
  /** OpenTelemetry trace_id, to link job logs with the gateway trace. */
  traceId: string | null;
}

export const MIME_BY_FORMAT: Record<OutputFormat, string> = {
  png: "image/png",
  webp: "image/webp",
};

/** Shape returned to the MCP client. */
export function jobToResult(job: JobRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {
    job_id: job.jobId,
    status: job.status,
  };

  if (job.status === "completed" && job.artifact) {
    const a = job.artifact;
    const artifact: Record<string, unknown> = {
      project_id: a.projectId,
      asset_id: a.assetId,
      version: a.version,
      parent_version: a.parentVersion,
      url: a.url,
      mime_type: a.mimeType,
      width: a.width,
      height: a.height,
      transparent: a.transparent,
      created_at: a.createdAt,
    };
    if (a.animation) {
      artifact.animation = {
        motion: a.animation.motion,
        intensity: a.animation.intensity,
        duration_ms: a.animation.durationMs,
        frames: a.animation.frames,
        fps: a.animation.fps,
        gif_url: a.animation.gif.url,
      };
    }
    out.artifact = artifact;
  }

  if (job.status === "failed") {
    out.error = { code: job.errorCode, message: job.errorMessage };
  }

  return out;
}
