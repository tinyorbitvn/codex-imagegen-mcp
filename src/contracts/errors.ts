// Error codes returned to MCP clients.
//
// Messages returned to the outside world must be SAFE AND ACTIONABLE: tell
// the caller what to do, with NO credentials, NO environment variable
// dumps, and NO raw stderr from a child process (Codex's stderr can
// contain token paths or fragments of auth headers).

export const ERROR_CODES = [
  "CODEX_NOT_AUTHENTICATED",
  "CODEX_NOT_AVAILABLE",
  // The ChatGPT account/session can log in but has NO image generation
  // capability. This needs an explicit capability error instead of
  // silently falling back to OPENAI_API_KEY — a dedicated code so
  // operations can tell "not logged in" apart from "logged in but the
  // plan doesn't support it".
  "IMAGE_CAPABILITY_UNAVAILABLE",
  // The account is logged in and CAN generate images, but has spent its
  // ChatGPT usage limit. Separate from IMAGE_GENERATION_FAILED because
  // the answer is "wait or buy credits", not "look at the logs", and
  // separate from RATE_LIMITED because that one is THIS service's own
  // per-principal counter, which an operator can raise. Observed
  // 2026-09-18: five jobs died on a spent quota and every one of them
  // came back as the generic code, so the real reason only existed in
  // the worker's logs.
  "CODEX_QUOTA_EXHAUSTED",
  "IMAGE_GENERATION_FAILED",
  "JOB_NOT_FOUND",
  "JOB_CANCELLED",
  "STORAGE_UPLOAD_FAILED",
  "INVALID_ASSET_ID",
  "INVALID_PROJECT",
  "UNSUPPORTED_FORMAT",
  "UNKNOWN_STYLE_PROFILE",
  "RATE_LIMITED",
  "UNAUTHORIZED",
  "FORBIDDEN",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class ImagegenError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "ImagegenError";
    this.code = code;
  }

  /** Shape to put into an MCP structuredContent. */
  toJSON(): { error: { code: ErrorCode; message: string } } {
    return { error: { code: this.code, message: this.message } };
  }
}

/**
 * Turns an arbitrary error into an ImagegenError.
 *
 * Errors that are NOT an ImagegenError (bugs, network errors, SDK errors)
 * DELIBERATELY have their original message swallowed: their message text
 * often carries a full URL, headers, or an internal path. The real detail
 * is still logged server-side (redacted) so operations can trace it, but
 * it never leaves through MCP.
 */
export function toImagegenError(err: unknown, fallback: ErrorCode): ImagegenError {
  if (err instanceof ImagegenError) return err;
  return new ImagegenError(
    fallback,
    "Operation failed. Check the service logs for this job_id for details.",
  );
}
