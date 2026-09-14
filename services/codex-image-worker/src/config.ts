// Config loaded from environment variables.
//
// Do NOT read OPENAI_API_KEY anywhere. Not touching that variable at all
// is the first line of defense against accidentally billing through a
// personal API key instead of the ChatGPT subscription this service is
// built around; the second line of defense is the allowlist in runner.ts.

import type { StorageConfig } from "@tinyorbit/artifact-storage";

function str(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} must be an integer, got: ${v}`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v === "true" || v === "1";
}

export interface Config {
  port: number;
  redisUrl: string;
  queueLimit: number;
  workDir: string;
  codexHome: string;
  codexBinary: string;
  jobTimeoutSeconds: number;
  concurrency: number;
  generatedImageRetentionHours: number;
  otlpEndpoint: string;
  s3: StorageConfig;
}

export function loadConfig(): Config {
  return {
    port: int("PORT", 8080),
    redisUrl: str("REDIS_URL"),
    queueLimit: int("QUEUE_LIMIT", 64),
    workDir: str("WORK_DIR", "/work/jobs"),
    codexHome: str("CODEX_HOME", "/home/codex/.codex"),
    codexBinary: str("CODEX_BINARY", "codex"),
    jobTimeoutSeconds: int("JOB_TIMEOUT_SECONDS", 900),
    // Default 1: one ChatGPT session can only drive one Codex process at a
    // time. The setting exists to raise later, but do NOT raise the default.
    concurrency: int("WORKER_CONCURRENCY", 1),
    // Codex's image-generation tool ALWAYS leaves a copy behind in
    // $CODEX_HOME/generated_images/, even when the job succeeds and the
    // image already made it to S3 — meaning this directory grows without
    // bound on the PVC. Measured 2026-09-12: 9 files / 5.9MB after one
    // afternoon of testing, ~0.7MB per job.
    // Keep a short retention window so we can still salvage an image
    // (salvageGeneratedImage) and still inspect it when something goes
    // wrong; clean up once it's past that window.
    generatedImageRetentionHours: int("GENERATED_IMAGE_RETENTION_HOURS", 24),
    otlpEndpoint: str("OTEL_EXPORTER_OTLP_ENDPOINT", ""),
    s3: {
      endpoint: str("S3_ENDPOINT"),
      bucket: str("S3_BUCKET"),
      region: str("S3_REGION", "us-east-1"),
      // Default TRUE, not FALSE: self-hosted S3 gateways usually don't
      // have the wildcard DNS that virtual-hosted-style addressing needs,
      // so that style breaks against them. A wrong default here produces
      // a hard-to-guess DNS error rather than a clear S3 error.
      forcePathStyle: bool("S3_FORCE_PATH_STYLE", true),
      publicBaseUrl: str("S3_PUBLIC_BASE_URL").replace(/\/+$/, ""),
      signedUrlTtlSeconds: int("S3_SIGNED_URL_TTL_SECONDS", 86400),
      accessKeyId: str("AWS_ACCESS_KEY_ID", ""),
      secretAccessKey: str("AWS_SECRET_ACCESS_KEY", ""),
    },
  };
}
