// MCP tool contract.
//
// *** ARTIFACT-ORIENTED, NOT generate_image(prompt) ***
// Every request is tied to an artifact with an identity (`project_id` +
// `asset_id`), not a free-floating prompt. That's what gives us
// versioning, the ability to edit again, and lets Claude reference the
// same object again in a later turn.
//
// Using zod because the MCP SDK accepts a zod shape and auto-generates the
// JSON Schema for tools/list — one source of truth, no schema written
// twice and left to drift.

import { z } from "zod";
import {
  ANIMATION_INTENSITIES,
  ANIMATION_MOTIONS,
  MAX_ANIMATION_DURATION_MS,
  MIN_ANIMATION_DURATION_MS,
} from "./animation.ts";
import { MAX_REFERENCE_UPLOADS, UPLOAD_CONTENT_TYPES } from "./upload.ts";

export const ASPECT_RATIOS = ["1:1", "3:2", "2:3", "16:9", "9:16"] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

export const OUTPUT_FORMATS = ["png", "webp"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/**
 * Default dimensions per aspect ratio.
 *
 * Kept close to a 1536 long edge — the size OpenAI's image model generates
 * most cleanly. Pick arbitrary odd numbers and the image gets rescaled and
 * loses sharpness.
 */
export const DEFAULT_CANVAS: Record<AspectRatio, { width: number; height: number }> = {
  "1:1": { width: 1536, height: 1536 },
  "3:2": { width: 1536, height: 1024 },
  "2:3": { width: 1024, height: 1536 },
  "16:9": { width: 1536, height: 864 },
  "9:16": { width: 864, height: 1536 },
};

// Dimension cap: stops a 20000x20000 request from making Codex run forever
// and hit the timeout, burning quota for nothing.
const dimension = z.number().int().min(256).max(4096);

export const createImageSchema = {
  project_id: z
    .string()
    .describe('Project id, e.g. "tinyorbit-cloud". a-z, 0-9, "-", "_" only.'),
  asset_id: z
    .string()
    .describe('Artifact id within the project, e.g. "homepage-hero-vps".'),
  description: z.string().describe("Description of the subject to draw."),
  reference_upload_ids: z
    .array(z.string())
    .min(1)
    .max(MAX_REFERENCE_UPLOADS)
    .optional()
    .describe(
      "upload_ids from upload_image. Codex looks at these images while " +
        "drawing: a logo to include, a product or character to keep " +
        "consistent, a layout to follow.",
    ),
  style: z
    .object({
      reference: z
        .string()
        .optional()
        .describe(
          'Name of a reusable style profile, e.g. "tinyorbit-cloud-v1". ' +
            "Prefer this over copying the whole style description into " +
            "every call — the style profile is the source of truth for " +
            "the brand identity.",
        ),
      prompt: z
        .string()
        .optional()
        .describe("Extra style instructions, appended AFTER the style profile."),
    })
    .optional(),
  canvas: z
    .object({
      aspect_ratio: z.enum(ASPECT_RATIOS).optional(),
      width: dimension.optional(),
      height: dimension.optional(),
    })
    .optional(),
  transparent_background: z
    .boolean()
    .optional()
    .describe(
      "true for a transparent background (alpha channel). Defaults to " +
        "true because a web artifact almost always needs to be composited " +
        "onto another background.",
    ),
  output_format: z.enum(OUTPUT_FORMATS).optional(),
  composition: z
    .object({
      isolated_object: z
        .boolean()
        .optional()
        .describe(
          "true means draw EXACTLY one object, nothing else in the frame. " +
            "Must be enabled when objects are meant to move independently " +
            "on the web page — each object must be its own artifact, see " +
            "the tool description.",
        ),
      safe_padding_percent: z.number().int().min(0).max(40).optional(),
    })
    .optional(),
  wait: z
    .boolean()
    .optional()
    .describe(
      "Defaults to true: WAIT until the image is done before returning, " +
        "reporting progress along the way via notifications/progress. Set " +
        "to false to get a job_id back immediately and poll " +
        "get_image_job yourself — only use this when running several jobs " +
        "in parallel.",
    ),
  timeout_seconds: z
    .number()
    .int()
    .min(10)
    .max(600)
    .optional()
    .describe(
      "Only has an effect when wait=true. Maximum wait time, defaults to " +
        "300. Timing out is NOT an error and does NOT cancel the job: the " +
        "current status is returned with timed_out=true — call " +
        "get_image_job(job_id) to keep following it.",
    ),
};

export const getImageJobSchema = {
  job_id: z.string().describe("job_id returned by create_image, edit_image or animate_image."),
};

export const editImageSchema = {
  project_id: z.string(),
  asset_id: z.string(),
  source_version: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Source version. Omit for the latest version."),
  source_upload_id: z
    .string()
    .optional()
    .describe(
      "upload_id from upload_image: edit your own image instead of an " +
        "existing version. Do not combine with source_version.",
    ),
  instructions: z.string().describe("The change to apply."),
  transparent_background: z.boolean().optional(),
  wait: z
    .boolean()
    .optional()
    .describe(
      "Defaults to true: WAIT until the image is done before returning, " +
        "reporting progress along the way via notifications/progress. Set " +
        "to false to get a job_id back immediately and poll " +
        "get_image_job yourself — only use this when running several jobs " +
        "in parallel.",
    ),
  timeout_seconds: z
    .number()
    .int()
    .min(10)
    .max(600)
    .optional()
    .describe(
      "Only has an effect when wait=true. Maximum wait time, defaults to " +
        "300. Timing out is NOT an error and does NOT cancel the job: the " +
        "current status is returned with timed_out=true — call " +
        "get_image_job(job_id) to keep following it.",
    ),
};

export const animateImageSchema = {
  project_id: z.string(),
  asset_id: z.string(),
  source_version: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Still image to animate. Omit for the latest version."),
  source_upload_id: editImageSchema.source_upload_id,
  motion: z
    .enum(ANIMATION_MOTIONS)
    .describe(
      "spin: one full turn. pulse: grow and shrink. shake: a damped wobble, " +
        "like a ringing bell. bounce: a hop with a squash on landing. " +
        "float: drift up and down.",
    ),
  duration_ms: z
    .number()
    .int()
    .optional()
    .describe(
      `One loop in milliseconds. Defaults per motion; clamped to ` +
        `${MIN_ANIMATION_DURATION_MS}-${MAX_ANIMATION_DURATION_MS}.`,
    ),
  intensity: z
    .enum(ANIMATION_INTENSITIES)
    .optional()
    .describe("How far the object moves. Defaults to medium."),
  wait: editImageSchema.wait,
  timeout_seconds: editImageSchema.timeout_seconds,
};

export const getArtifactSchema = {
  project_id: z.string(),
  asset_id: z.string(),
  version: z.number().int().min(1).optional().describe("Omit for the latest version."),
};

export const cancelImageJobSchema = {
  job_id: z.string(),
};

export const uploadImageSchema = {
  project_id: z
    .string()
    .describe("Project the upload belongs to; only tools in this project can use it."),
  content_type: z
    .enum(UPLOAD_CONTENT_TYPES)
    .optional()
    .describe("Required unless data_base64 is sent: it is signed into the POST target."),
  data_base64: z
    .string()
    .optional()
    .describe(
      "The image inline, as raw base64 or a data: URI, at most 700 KB " +
        "decoded. Omit it to get a POST target for files up to 20 MB.",
    ),
};

/** Names of the 6 tools Claude Design gets to see. */
export const PUBLIC_TOOLS = [
  "create_image",
  "edit_image",
  "animate_image",
  "get_image_job",
  "get_artifact",
  "cancel_image_job",
] as const;
export type PublicTool = (typeof PUBLIC_TOOLS)[number];
