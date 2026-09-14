// Configuration comes entirely from environment variables — there is no
// config file. Whatever deploys this container (Helm, Compose, plain
// `docker run`) sets them at start time.
//
// Do NOT read OPENAI_API_KEY anywhere. Not touching that variable at all
// is the first line of defense against accidentally billing through a
// personal API key instead of the ChatGPT subscription this service is
// built around; the second line of defense is the allowlist in runner.ts.
//
// *** ONE CONFIG FOR ALL THREE ROLES ***
// This used to be two files, one per service, and they drifted: the same
// variable had to be declared twice and a default changed in one place
// stayed wrong in the other. One process now runs either or both roles, so
// there is one loader, and the role only decides which combinations are
// REFUSED (see the checks at the bottom of loadConfig).

import type { StorageConfig } from "./storage/s3.ts";

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

/**
 * What this process runs.
 *
 * "all" is one process serving MCP and generating images, which is the
 * whole point of the single-image deployment: it needs no Redis and no
 * bucket. "mcp" and "worker" split the same code across two deployments
 * and then DO need both, because two processes share neither memory nor a
 * local disk.
 */
export type Role = "all" | "mcp" | "worker";

const ROLES: readonly Role[] = ["all", "mcp", "worker"];

export interface Config {
  role: Role;
  port: number;
  /** Base of the URLs handed back to MCP clients. Must resolve from OUTSIDE the container. */
  publicBaseUrl: string;
  otlpEndpoint: string;
  queue: { kind: "redis" | "memory"; url: string; limit: number };
  storage:
    | { kind: "s3"; s3: StorageConfig }
    | { kind: "local"; dir: string; publicBaseUrl: string };
  mcp: {
    rateLimit: { createImagePerHour: number; editImagePerHour: number };
  };
  worker: {
    workDir: string;
    codexHome: string;
    codexBinary: string;
    jobTimeoutSeconds: number;
    concurrency: number;
    generatedImageRetentionHours: number;
  };
}

function loadRole(): Role {
  const raw = process.env.ROLE;
  if (raw === undefined || raw === "") return "all";
  const role = ROLES.find((r) => r === raw);
  if (!role) {
    throw new Error(`ROLE must be one of: ${ROLES.join(", ")} (got: ${raw})`);
  }
  return role;
}

export function loadConfig(): Config {
  const role = loadRole();
  const port = int("PORT", 8080);
  const publicBaseUrl = str("PUBLIC_BASE_URL", `http://localhost:${port}`).replace(/\/+$/, "");

  // An empty REDIS_URL means the queue lives in this process's memory.
  // That is a real deployment mode, not a fallback for a misconfiguration:
  // with one process there is no one else to share the queue with.
  const redisUrl = process.env.REDIS_URL ?? "";
  const queueKind = redisUrl === "" ? "memory" : "redis";
  if (queueKind === "memory" && role !== "all") {
    throw new Error(
      `ROLE=${role} needs a shared queue: an in-process queue cannot be seen by the other ` +
        "process. Set REDIS_URL, or run ROLE=all in a single process.",
    );
  }

  // An empty S3_ENDPOINT means artifacts go to a directory on disk and are
  // served from /artifacts on this same port.
  const s3Endpoint = process.env.S3_ENDPOINT ?? "";
  const storage: Config["storage"] =
    s3Endpoint === ""
      ? {
          kind: "local",
          dir: str("ARTIFACT_DIR", "/data/artifacts"),
          publicBaseUrl,
        }
      : {
          kind: "s3",
          s3: {
            endpoint: s3Endpoint,
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
  if (storage.kind === "local" && role === "worker") {
    throw new Error(
      "ROLE=worker needs storage both processes can reach: the MCP process is what serves " +
        "/artifacts, and it cannot serve a directory that only exists inside the worker. " +
        "Set S3_ENDPOINT, S3_BUCKET and S3_PUBLIC_BASE_URL, or run ROLE=all in a single process.",
    );
  }

  return {
    role,
    port,
    publicBaseUrl,
    // Empty = OTLP export fully disabled. Point this at whatever collector
    // you already run instead of standing up a new one; leaving it empty
    // is fine for local runs and tests.
    otlpEndpoint: str("OTEL_EXPORTER_OTLP_ENDPOINT", ""),
    queue: { kind: queueKind, url: redisUrl, limit: int("QUEUE_LIMIT", 64) },
    storage,
    mcp: {
      rateLimit: {
        createImagePerHour: int("RATE_LIMIT_CREATE_IMAGE_PER_HOUR", 10),
        editImagePerHour: int("RATE_LIMIT_EDIT_IMAGE_PER_HOUR", 20),
      },
    },
    worker: {
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
    },
  };
}
