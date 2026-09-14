// Nghiệp vụ của imagegen-mcp.
//
// *** GẦN NHƯ KHÔNG TRẠNG THÁI (spec §10) ***
// Service này KHÔNG chạy Codex, KHÔNG giữ credential ChatGPT, KHÔNG giữ
// job trong bộ nhớ. Nó chỉ: kiểm đầu vào, chuẩn hoá đặc tả ảnh, ghi bản
// ghi job, đẩy việc vào hàng đợi, rồi đọc trạng thái ra.
//
// Nhờ vậy nó chạy được nhiều replica và restart thoải mái — mọi trạng
// thái thật nằm ở Redis.

import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import {
  DEFAULT_CANVAS,
  ImagegenError,
  MIME_BY_FORMAT,
  jobToResult,
  resolveStyle,
  sanitizeFreeText,
  sanitizeIdentifier,
} from "@tinyorbit/contracts";
import type {
  AspectRatio,
  ImageSpec,
  JobRecord,
  OutputFormat,
} from "@tinyorbit/contracts";
import type { JobQueue, JobStore } from "@tinyorbit/job-queue";

export interface ServiceConfig {
  rateLimit: {
    createImagePerHour: number;
    editImagePerHour: number;
  };
}

export interface ServiceDeps {
  store: JobStore;
  queue: JobQueue;
  config: ServiceConfig;
}

export interface JobHandle {
  job_id: string;
  status: "queued";
}

/**
 * `job_id` dạng img_<uuid không gạch>.
 *
 * Phần ngẫu nhiên đủ rộng để không đoán được job của người khác —
 * get_image_job chỉ kiểm job_id nên đoán được là đọc được.
 */
function newJobId(): string {
  return `img_${randomUUID().replace(/-/g, "")}`;
}

/** Vân tay đặc tả, ghi vào metadata artifact (spec §19). */
function specHash(spec: ImageSpec, extra = ""): string {
  return createHash("sha256").update(JSON.stringify(spec) + extra, "utf8").digest("hex");
}

/**
 * Nhịp hỏi lại Redis khi đang chờ job.
 *
 * 3 giây: đủ dày để client thấy tiến độ "sống", đủ thưa để 1 job 140 giây
 * chỉ tốn ~47 lần đọc Redis. Cũng là nhịp phát notifications/progress, nên
 * stream không bao giờ idle — quan trọng vì Cilium đặt
 * http-stream-idle-timeout=300s (đo 2026-09-12).
 */
const WAIT_POLL_MS = 3_000;

export class ImagegenService {
  #store: JobStore;
  #queue: JobQueue;
  #cfg: ServiceConfig;

  constructor(deps: ServiceDeps) {
    this.#store = deps.store;
    this.#queue = deps.queue;
    this.#cfg = deps.config;
  }

  // ---------------------------------------------------------------
  // create_image
  // ---------------------------------------------------------------
  async createImage(raw: Record<string, unknown>, principal: string): Promise<JobHandle> {
    await this.#checkRate(principal, this.#cfg.rateLimit.createImagePerHour, 3_600_000);

    const projectId = sanitizeIdentifier(raw.project_id, "project");
    const assetId = sanitizeIdentifier(raw.asset_id, "asset_id");
    const description = sanitizeFreeText(raw.description, "description");

    const styleIn = (raw.style ?? {}) as Record<string, unknown>;
    const extraStyle =
      styleIn.prompt !== undefined
        ? sanitizeFreeText(styleIn.prompt, "style.prompt")
        : undefined;

    let style: { prompt: string; reference: string | null };
    try {
      style = resolveStyle(styleIn.reference as string | undefined, extraStyle);
    } catch (e) {
      // Style profile không tồn tại là lỗi NGƯỜI GỌI sửa được — nói rõ
      // tên nào hợp lệ thay vì để nó thành "generation failed" mơ hồ.
      throw new ImagegenError("UNKNOWN_STYLE_PROFILE", (e as Error).message);
    }

    const canvasIn = (raw.canvas ?? {}) as Record<string, unknown>;
    const aspectRatio = ((canvasIn.aspect_ratio as AspectRatio) ?? "1:1") as AspectRatio;
    const defaults = DEFAULT_CANVAS[aspectRatio] ?? DEFAULT_CANVAS["1:1"];

    const outputFormat = ((raw.output_format as OutputFormat) ?? "png") as OutputFormat;
    if (!(outputFormat in MIME_BY_FORMAT)) {
      throw new ImagegenError("UNSUPPORTED_FORMAT", "output_format chỉ nhận png hoặc webp");
    }

    const compIn = (raw.composition ?? {}) as Record<string, unknown>;

    const spec: ImageSpec = {
      projectId,
      assetId,
      description,
      stylePrompt: style.prompt,
      styleReference: style.reference,
      aspectRatio,
      width: (canvasIn.width as number | undefined) ?? defaults.width,
      height: (canvasIn.height as number | undefined) ?? defaults.height,
      // Mặc định TRUE: artifact web hầu như luôn phải ghép lên nền khác,
      // và nền trong suốt sai thành đục thì phải sinh lại từ đầu.
      transparentBackground: (raw.transparent_background as boolean | undefined) ?? true,
      outputFormat,
      isolatedObject: (compIn.isolated_object as boolean | undefined) ?? true,
      safePaddingPercent: (compIn.safe_padding_percent as number | undefined) ?? 12,
      // Tên file do WORKER quyết, không bao giờ lấy từ người dùng.
      filename: `artifact.${outputFormat}`,
    };

    const version = (await this.#store.highestAllocatedVersion(projectId, assetId)) + 1;
    const jobId = newJobId();

    await this.#store.create(this.#newRecord(jobId, spec, version, null, principal));
    await this.#queue.enqueue({
      jobId,
      kind: "create",
      spec,
      version,
      parentVersion: null,
      sourceKey: null,
      instructions: null,
    });

    return { job_id: jobId, status: "queued" };
  }

  // ---------------------------------------------------------------
  // edit_image — KHÔNG BAO GIỜ ghi đè (spec §11)
  // ---------------------------------------------------------------
  async editImage(raw: Record<string, unknown>, principal: string): Promise<JobHandle> {
    await this.#checkRate(principal, this.#cfg.rateLimit.editImagePerHour, 3_600_000);

    const projectId = sanitizeIdentifier(raw.project_id, "project");
    const assetId = sanitizeIdentifier(raw.asset_id, "asset_id");
    const instructions = sanitizeFreeText(raw.instructions, "instructions");
    const sourceVersion = raw.source_version as number | undefined;

    const source = await this.#store.getArtifact(projectId, assetId, sourceVersion);
    if (!source?.artifact) {
      throw new ImagegenError(
        "JOB_NOT_FOUND",
        `Không có artifact ${projectId}/${assetId}` +
          (sourceVersion ? ` phiên bản ${sourceVersion}` : ""),
      );
    }

    const src = source.artifact;
    const outputFormat: OutputFormat = src.mimeType === "image/webp" ? "webp" : "png";

    const spec: ImageSpec = {
      projectId,
      assetId,
      description: instructions,
      stylePrompt: "",
      styleReference: null,
      aspectRatio: "1:1",
      width: src.width,
      height: src.height,
      transparentBackground:
        (raw.transparent_background as boolean | undefined) ?? src.transparent,
      outputFormat,
      isolatedObject: true,
      safePaddingPercent: 12,
      filename: `artifact.${outputFormat}`,
    };

    const version = (await this.#store.highestAllocatedVersion(projectId, assetId)) + 1;
    const jobId = newJobId();

    await this.#store.create(this.#newRecord(jobId, spec, version, src.version, principal));
    await this.#queue.enqueue({
      jobId,
      kind: "edit",
      spec,
      version,
      parentVersion: src.version,
      sourceKey: src.key,
      instructions,
    });

    return { job_id: jobId, status: "queued" };
  }

  // ---------------------------------------------------------------
  // Truy vấn
  // ---------------------------------------------------------------
  async getImageJob(jobId: string): Promise<Record<string, unknown>> {
    const job = await this.#store.get(jobId);
    if (!job) throw new ImagegenError("JOB_NOT_FOUND", `Không có job ${jobId}`);
    return jobToResult(job);
  }

  /**
   * Chờ job tới trạng thái cuối, BÁO TIẾN ĐỘ dọc đường.
   *
   * *** VÌ SAO CẦN TOOL NÀY THAY VÌ ĐỂ CLIENT TỰ HỎI LẠI ***
   * Sinh một ảnh mất 30-140 giây. Nếu client tự lặp get_image_job thì mỗi
   * vòng là một lời gọi tool, model phải tự quyết chờ bao lâu, và người
   * dùng nhìn màn hình không thấy gì đang xảy ra. Gom vào một lời gọi có
   * phát `notifications/progress` thì client hiển thị được tiến độ thật.
   *
   * KHÔNG giữ trạng thái trong tiến trình: vẫn đọc Redis mỗi vòng, nên
   * nhiều replica vẫn đúng. Cái duy nhất "dính" vào một pod là kết nối
   * HTTP đang mở của chính lời gọi này.
   *
   * Hết giờ KHÔNG phải lỗi: job vẫn chạy tiếp ở worker, chỉ là ta thôi
   * chờ. Trả timed_out=true để client biết mà gọi lại — huỷ job ở đây sẽ
   * phí một lượt quota ChatGPT đã tiêu.
   */
  async waitForImage(
    raw: Record<string, unknown>,
    opts: {
      signal?: AbortSignal;
      onProgress?: (info: { status: string; elapsedMs: number }) => void | Promise<void>;
      /**
       * Nhịp hỏi lại, chỉ để TEST tiêm vào. KHÔNG phơi ra schema của tool:
       * người gọi MCP không có lý do gì chỉnh nhịp đọc Redis của server.
       * Test cần nó vì với nhịp 3 giây thật, một chuyển trạng thái diễn ra
       * trong vài mili giây sẽ bị bỏ lỡ giữa hai lần lấy mẫu.
       */
      pollMs?: number;
    } = {},
  ): Promise<Record<string, unknown>> {
    const jobId = String(raw.job_id ?? "");
    const timeoutMs = Math.round(((raw.timeout_seconds as number | undefined) ?? 300) * 1000);

    const started = Date.now();
    let last: string | null = null;

    for (;;) {
      const job = await this.#store.get(jobId);
      if (!job) throw new ImagegenError("JOB_NOT_FOUND", `Không có job ${jobId}`);

      if (job.status !== last) {
        last = job.status;
        await opts.onProgress?.({ status: job.status, elapsedMs: Date.now() - started });
      }

      if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
        return { ...jobToResult(job), timed_out: false, waited_seconds: Math.round((Date.now() - started) / 1000) };
      }

      // Client bỏ cuộc (đóng kết nối/huỷ request): dừng chờ, KHÔNG huỷ job.
      if (opts.signal?.aborted) {
        return { ...jobToResult(job), timed_out: false, aborted: true, waited_seconds: Math.round((Date.now() - started) / 1000) };
      }

      if (Date.now() - started >= timeoutMs) {
        return { ...jobToResult(job), timed_out: true, waited_seconds: Math.round((Date.now() - started) / 1000) };
      }

      await new Promise((r) => setTimeout(r, opts.pollMs ?? WAIT_POLL_MS));
    }
  }

  async getArtifact(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const projectId = sanitizeIdentifier(raw.project_id, "project");
    const assetId = sanitizeIdentifier(raw.asset_id, "asset_id");
    const version = raw.version as number | undefined;

    const job = await this.#store.getArtifact(projectId, assetId, version);
    if (!job) {
      throw new ImagegenError(
        "JOB_NOT_FOUND",
        `Không có artifact ${projectId}/${assetId}` + (version ? ` v${version}` : ""),
      );
    }
    return jobToResult(job);
  }

  async cancelImageJob(jobId: string): Promise<Record<string, unknown>> {
    const job = await this.#store.get(jobId);
    if (!job) throw new ImagegenError("JOB_NOT_FOUND", `Không có job ${jobId}`);

    // Huỷ job đã xong KHÔNG được xoá artifact — phiên bản đã phát hành
    // là bất biến (spec §11).
    if (job.status === "completed") {
      throw new ImagegenError("JOB_CANCELLED", "Job đã hoàn tất, không huỷ được nữa.");
    }

    await this.#queue.requestCancel(jobId);
    const changed = await this.#store.markCancelled(jobId);
    return { job_id: jobId, status: changed ? "cancelled" : job.status };
  }

  // ---------------------------------------------------------------
  #newRecord(
    jobId: string,
    spec: ImageSpec,
    version: number,
    parentVersion: number | null,
    principal: string,
  ): JobRecord {
    void specHash;
    return {
      jobId,
      status: "queued",
      projectId: spec.projectId,
      assetId: spec.assetId,
      version,
      parentVersion,
      principal,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      artifact: null,
      errorCode: null,
      errorMessage: null,
      traceId: null,
    };
  }

  /**
   * Rate limit đếm trong Redis chứ không trong bộ nhớ tiến trình.
   *
   * Bắt buộc như vậy vì imagegen-mcp chạy NHIỀU replica: đếm cục bộ thì
   * hạn mức thực tế nhân lên theo số replica, tức là không còn là hạn mức.
   */
  async #checkRate(principal: string, limit: number, windowMs: number): Promise<void> {
    const used = await this.#store.countSince(principal, Date.now() - windowMs);
    if (used >= limit) {
      throw new ImagegenError(
        "RATE_LIMITED",
        `Vượt giới hạn ${limit} lần trong ${Math.round(windowMs / 60000)} phút.`,
      );
    }
  }
}
