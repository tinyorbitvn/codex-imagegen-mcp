// Sanitizes every user-supplied string BEFORE it touches the filesystem or
// a command line.
//
// Principle: an ALLOW LIST, not a deny list. Banning "../" and patching
// holes one by one is a race you never win (`....//`, `%2e%2e%2f`, unicode
// characters that look like a dot...). Here only one exact character set
// is accepted and everything else is rejected.

import { ImagegenError } from "./errors.ts";

/**
 * Safe identifier for `project` and `asset_id`.
 *
 * Allowed: lowercase a-z, digits, hyphen, underscore.
 * Must start and end with a letter or digit.
 * Length 1..64 characters.
 *
 * Consequence: NO dots, NO slashes, NO null bytes, NO whitespace. That
 * means there is no valid string that can escape the parent directory, and
 * no valid string that a shell could interpret as syntax.
 */
const SAFE_ID = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

export function sanitizeIdentifier(
  value: unknown,
  field: "project" | "asset_id" | "artifact_id",
): string {
  if (typeof value !== "string") {
    throw new ImagegenError(
      field === "project" ? "INVALID_PROJECT" : "INVALID_ASSET_ID",
      `${field} must be a string`,
    );
  }

  // Normalize to NFKC BEFORE validating. Skip this step and pre-composed
  // characters that look exactly like ASCII would still slip through the
  // regex in a different form.
  const normalized = value.normalize("NFKC").trim().toLowerCase();

  if (!SAFE_ID.test(normalized)) {
    throw new ImagegenError(
      field === "project" ? "INVALID_PROJECT" : "INVALID_ASSET_ID",
      `${field} may only contain a-z, 0-9, "-", "_", length 1..64, ` +
        `and must start and end with a letter or digit`,
    );
  }

  return normalized;
}

/**
 * User-chosen output filename (optional).
 *
 * Only the basename is taken and it is forced through the same filter as
 * an identifier, then the extension is ALWAYS appended based on `format`
 * — the extension the user sent is NEVER trusted. This leaves no path
 * that can produce ".." or "/etc/passwd" or "x.webp.sh".
 */
export function sanitizeFilename(
  value: string | undefined,
  format: "png" | "webp",
  fallback: string,
): string {
  if (value === undefined || value === "") {
    return `${fallback}.${format}`;
  }

  const base = value
    .normalize("NFKC")
    .split(/[/\\]/)
    .pop()!
    .replace(/\.[A-Za-z0-9]+$/, "")
    .trim()
    .toLowerCase();

  if (!SAFE_ID.test(base)) {
    throw new ImagegenError(
      "UNSUPPORTED_FORMAT",
      "output.filename may only contain a-z, 0-9, \"-\", \"_\"",
    );
  }

  return `${base}.${format}`;
}

/**
 * Free text going into the Codex prompt (description, style.prompt,
 * instructions).
 *
 * This does NOT filter by character allow-list — doing so would break
 * accented Vietnamese text and any meaningful description. Instead:
 *
 *   1. Strip control characters (including NUL) — they carry no meaning in
 *      an image description and are raw material for every kind of
 *      injection trick.
 *   2. Cap the length, so a giant description can't blow up memory or be
 *      used as a prompt-stuffing lever.
 *
 * COMMAND SAFETY DOES NOT DEPEND ON THIS FUNCTION. The prompt is passed to
 * Codex as ONE ELEMENT of the argv array (see codex/runner.ts), never
 * concatenated into a shell string. Even if the string contains
 * "; rm -rf /", it's still just one argument, not syntax. This function is
 * the second line of defense.
 */
export function sanitizeFreeText(
  value: unknown,
  field: string,
  maxLength = 4000,
): string {
  if (typeof value !== "string") {
    throw new ImagegenError("IMAGE_GENERATION_FAILED", `${field} must be a string`);
  }

  // The character class below DELIBERATELY contains control characters
  // (written as escapes so the file stays plain text — a previous version
  // accidentally wrote raw bytes and git started treating the file as
  // binary).
  const cleaned = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .trim();

  if (cleaned.length === 0) {
    throw new ImagegenError("IMAGE_GENERATION_FAILED", `${field} must not be empty`);
  }

  if (cleaned.length > maxLength) {
    throw new ImagegenError(
      "IMAGE_GENERATION_FAILED",
      `${field} is longer than ${maxLength} characters`,
    );
  }

  return cleaned;
}

/**
 * S3 key for an artifact. Built FROM already-sanitized pieces, never
 * assembled from a raw string.
 *
 * Layout:
 *   projects/<project>/<artifact_id>/v<version>/<filename>
 */
export function artifactKey(
  project: string,
  artifactId: string,
  version: number,
  filename: string,
): string {
  if (!Number.isInteger(version) || version < 1) {
    throw new ImagegenError("IMAGE_GENERATION_FAILED", "version must be an integer >= 1");
  }
  return `projects/${project}/${artifactId}/v${version}/${filename}`;
}
