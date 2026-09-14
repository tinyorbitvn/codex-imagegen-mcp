// loadConfig decides the deployment shape: which halves run, whether the
// queue is shared, and where images go. Every case below is a combination
// someone can produce with one line of a compose file or a values.yaml, so
// the rules are pinned here rather than discovered in production.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config.ts";

/** Every variable loadConfig() reads. Cleared before each test. */
const READ_BY_LOADER = [
  "ROLE", "PORT", "PUBLIC_BASE_URL", "OTEL_EXPORTER_OTLP_ENDPOINT",
  "REDIS_URL", "QUEUE_LIMIT",
  "ARTIFACT_DIR",
  "S3_ENDPOINT", "S3_BUCKET", "S3_REGION", "S3_FORCE_PATH_STYLE",
  "S3_PUBLIC_BASE_URL", "S3_SIGNED_URL_TTL_SECONDS",
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
  "WORK_DIR", "CODEX_HOME", "CODEX_BINARY", "JOB_TIMEOUT_SECONDS",
  "WORKER_CONCURRENCY", "GENERATED_IMAGE_RETENTION_HOURS",
  "RATE_LIMIT_CREATE_IMAGE_PER_HOUR", "RATE_LIMIT_EDIT_IMAGE_PER_HOUR",
];

// Every test writes to process.env, which is process-wide and shared with
// every other test file running in the same worker. Snapshot and restore
// it around each one.
let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  saved = { ...process.env };
  // Start from a known-empty state instead of whatever the developer's
  // shell happens to export: WORK_DIR and CODEX_HOME in particular are set
  // in the image, so a test asserting their defaults would pass or fail
  // depending on where it ran.
  for (const k of READ_BY_LOADER) delete process.env[k];
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

function s3Env(): void {
  process.env.S3_ENDPOINT = "https://s3.example.invalid";
  process.env.S3_BUCKET = "artifacts";
  process.env.S3_PUBLIC_BASE_URL = "https://cdn.example.invalid/artifacts";
}

describe("loadConfig role selection", () => {
  test("defaults to the single-process role", () => {
    assert.equal(loadConfig().role, "all");
  });

  test("an unknown ROLE fails at startup and names the valid ones", () => {
    process.env.ROLE = "mcp-worker";
    assert.throws(
      () => loadConfig(),
      (e: unknown) => e instanceof Error && /all, mcp, worker/.test(e.message),
    );
  });
});

describe("loadConfig queue selection", () => {
  test("an empty REDIS_URL keeps the queue in this process", () => {
    const cfg = loadConfig();
    assert.equal(cfg.queue.kind, "memory");
    assert.equal(cfg.queue.url, "");
  });

  test("a REDIS_URL selects the shared queue", () => {
    process.env.REDIS_URL = "redis://redis:6379";
    const cfg = loadConfig();
    assert.equal(cfg.queue.kind, "redis");
    assert.equal(cfg.queue.url, "redis://redis:6379");
  });

  test("a split role refuses to start on an in-process queue", () => {
    for (const role of ["mcp", "worker"]) {
      process.env.ROLE = role;
      // The worker role also needs storage both sides can reach; give it
      // one so the queue is the only thing left to complain about.
      s3Env();
      assert.throws(
        () => loadConfig(),
        (e: unknown) => e instanceof Error && /REDIS_URL/.test(e.message),
        `ROLE=${role} must refuse an in-process queue`,
      );
    }
  });
});

describe("loadConfig storage selection", () => {
  test("an empty S3_ENDPOINT stores images on local disk", () => {
    const cfg = loadConfig();
    assert.equal(cfg.storage.kind, "local");
    assert.equal(cfg.storage.kind === "local" && cfg.storage.dir, "/data/artifacts");
    // The URL handed to clients is this process's own, because this
    // process is what serves /artifacts.
    assert.equal(cfg.storage.kind === "local" && cfg.storage.publicBaseUrl, cfg.publicBaseUrl);
  });

  test("ARTIFACT_DIR moves the directory", () => {
    process.env.ARTIFACT_DIR = "/mnt/images";
    const cfg = loadConfig();
    assert.equal(cfg.storage.kind === "local" && cfg.storage.dir, "/mnt/images");
  });

  test("an S3_ENDPOINT selects object storage and still requires bucket and public URL", () => {
    process.env.S3_ENDPOINT = "https://s3.example.invalid";
    assert.throws(() => loadConfig(), /S3_BUCKET/);
    process.env.S3_BUCKET = "artifacts";
    assert.throws(() => loadConfig(), /S3_PUBLIC_BASE_URL/);
    process.env.S3_PUBLIC_BASE_URL = "https://cdn.example.invalid/artifacts/";
    const cfg = loadConfig();
    assert.equal(cfg.storage.kind, "s3");
    // Trailing slashes trimmed, or every artifact URL gets a double slash.
    assert.equal(
      cfg.storage.kind === "s3" && cfg.storage.s3.publicBaseUrl,
      "https://cdn.example.invalid/artifacts",
    );
  });

  test("the worker role refuses a directory only it can see", () => {
    process.env.ROLE = "worker";
    process.env.REDIS_URL = "redis://redis:6379";
    assert.throws(
      () => loadConfig(),
      (e: unknown) => e instanceof Error && /S3_ENDPOINT/.test(e.message),
    );
  });

  test("the mcp role is happy with local storage, since it is what serves it", () => {
    process.env.ROLE = "mcp";
    process.env.REDIS_URL = "redis://redis:6379";
    assert.equal(loadConfig().storage.kind, "local");
  });
});

describe("loadConfig defaults", () => {
  test("PUBLIC_BASE_URL follows PORT when it is not set", () => {
    process.env.PORT = "9090";
    const cfg = loadConfig();
    assert.equal(cfg.port, 9090);
    assert.equal(cfg.publicBaseUrl, "http://localhost:9090");
  });

  test("keeps the worker defaults that were measured in production", () => {
    const cfg = loadConfig();
    // One ChatGPT session drives one Codex process.
    assert.equal(cfg.worker.concurrency, 1);
    assert.equal(cfg.worker.jobTimeoutSeconds, 900);
    assert.equal(cfg.worker.generatedImageRetentionHours, 24);
    assert.equal(cfg.worker.workDir, "/work/jobs");
    assert.equal(cfg.worker.codexHome, "/home/codex/.codex");
    assert.equal(cfg.queue.limit, 64);
    assert.equal(cfg.mcp.rateLimit.createImagePerHour, 10);
    assert.equal(cfg.mcp.rateLimit.editImagePerHour, 20);
  });
});
