// codex-image-worker — tiêu thụ hàng đợi, chạy Codex, đẩy artifact.
//
// KHÔNG phơi MCP, KHÔNG có HTTPRoute. Cổng HTTP duy nhất chỉ phục vụ
// health probe và metrics, nghe trong cụm (spec §23).

import express from "express";
import { access, constants, mkdir } from "node:fs/promises";

import { log, setServiceName } from "@tinyorbit/contracts";
import { RedisJobQueue, RedisJobStore } from "@tinyorbit/job-queue";
import { ArtifactStorage } from "@tinyorbit/artifact-storage";

import { loadConfig } from "./config.ts";
import { Consumer } from "./consumer.ts";
import { isCodexAuthenticated, isCodexAvailable } from "./runner.ts";
import { metrics } from "./metrics.ts";
import { startTelemetry } from "./telemetry.ts";

setServiceName("codex-image-worker");
const config = loadConfig();
await startTelemetry("codex-image-worker", config.otlpEndpoint);

const store = new RedisJobStore({ url: config.redisUrl, queueLimit: config.queueLimit });
const queue = new RedisJobQueue({ url: config.redisUrl, queueLimit: config.queueLimit });
const storage = new ArtifactStorage(config.s3);

const consumer = new Consumer({
  store,
  queue,
  storage,
  config: {
    workDir: config.workDir,
    codexHome: config.codexHome,
    codexBinary: config.codexBinary,
    jobTimeoutSeconds: config.jobTimeoutSeconds,
    concurrency: config.concurrency,
    generatedImageRetentionHours: config.generatedImageRetentionHours,
  },
});

// Việc còn nằm trong danh sách `processing` lúc khởi động là tàn dư của
// lần chết trước: tiến trình Codex đã đi theo pod và không bao giờ chạy
// tiếp. Đánh dấu failed ngay, thay vì để job treo ở "running" khiến
// Claude poll vô hạn (spec §12).
const stale = await queue.reapStale();
for (const p of stale) {
  await store.markFailed(
    p.jobId,
    "IMAGE_GENERATION_FAILED",
    "Worker khởi động lại khi job đang chạy",
  );
}
if (stale.length > 0) {
  log.warn("đánh dấu thất bại cho job treo từ lần chạy trước", { count: stale.length });
}

const app = express();

// live: chỉ hỏi tiến trình còn chạy không. KHÔNG kiểm phụ thuộc ngoài —
// Redis chớp nháy không nên khiến kubelet giết worker đang sinh ảnh.
app.get("/health/live", (_req, res) => {
  res.json({ status: "ok" });
});

// ready: đủ điều kiện nhận việc chưa.
//
// CỐ Ý KHÔNG sinh ảnh thử — probe chạy vài chục giây một lần, mỗi lần
// sinh ảnh là một lần tốn quota ChatGPT thật.
app.get("/health/ready", async (_req, res) => {
  const checks: Record<string, boolean> = {
    work_dir_writable: false,
    codex_present: false,
    codex_authenticated: false,
    storage_reachable: false,
    redis: false,
  };

  try {
    await mkdir(config.workDir, { recursive: true });
    await access(config.workDir, constants.W_OK);
    checks.work_dir_writable = true;
  } catch {
    /* để false */
  }

  checks.codex_present = await isCodexAvailable(config.codexBinary);
  checks.codex_authenticated = await isCodexAuthenticated(config.codexHome);
  checks.storage_reachable = await storage.isReachable();
  try {
    await store.client.ping();
    checks.redis = true;
  } catch {
    /* để false */
  }

  const ready = Object.values(checks).every(Boolean);
  // Phiên ChatGPT hết hạn -> ready=false. Worker KHÔNG âm thầm chuyển
  // sang OPENAI_API_KEY (spec §31) — không có nhánh mã nào làm việc đó.
  res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not-ready", checks });
});

app.get("/metrics", (_req, res) => {
  res.type("text/plain; version=0.0.4").send(metrics.render());
});

const server = app.listen(config.port, () => {
  log.info("codex-image-worker đang nghe", {
    port: config.port,
    concurrency: config.concurrency,
  });
});

void consumer.run();

// Tắt êm: ngừng nhận việc mới, chờ việc đang chạy xong, rồi đóng kết nối.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    log.info("nhận tín hiệu dừng, chờ job đang chạy kết thúc", { signal: sig });
    consumer.stop();
    server.close(() => {
      void Promise.allSettled([store.close(), queue.close()]).then(() => process.exit(0));
    });
  });
}
