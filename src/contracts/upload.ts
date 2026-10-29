// The upload_image contract: limits, ids and where an upload lives.
//
// Pure values only. The sharp-based inspection lives in src/uploads.ts so
// that importing the contracts never loads a native image library.

import { randomBytes } from "node:crypto";
import { ImagegenError } from "./errors.ts";

export const UPLOAD_CONTENT_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type UploadContentType = (typeof UPLOAD_CONTENT_TYPES)[number];

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
/** Inline base64 grows by a third; this keeps the JSON-RPC body under the 1 MB /mcp limit. */
export const MAX_INLINE_UPLOAD_BYTES = 700 * 1024;
export const MAX_UPLOAD_SIDE = 4096;
export const MIN_UPLOAD_SIDE = 16;
/** Lifetime of a POST target, not of the upload: the bucket lifecycle decides that. */
export const UPLOAD_TTL_SECONDS = 900;
export const MAX_REFERENCE_UPLOADS = 4;

const UPLOAD_ID = /^upl_[0-9a-f]{32}$/;
const UPLOAD_PREFIX = "uploads/";

export function newUploadId(): string {
  return `upl_${randomBytes(16).toString("hex")}`;
}

/**
 * Where an upload lives. The project is part of the key, so an id only
 * resolves inside the project it was issued for, and the strict id format
 * means a caller's string never becomes a path.
 */
export function uploadKey(projectId: string, uploadId: string): string {
  if (!UPLOAD_ID.test(uploadId)) {
    throw new ImagegenError(
      "UPLOAD_NOT_FOUND",
      "upload_id must be one returned by upload_image (upl_ followed by 32 hex characters).",
    );
  }
  return `${UPLOAD_PREFIX}${projectId}/${uploadId}`;
}

export function isUploadKey(key: string): boolean {
  return key.startsWith(UPLOAD_PREFIX);
}
