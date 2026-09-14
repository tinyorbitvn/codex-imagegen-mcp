// Vòng lặp tiêu thụ hàng đợi và chạy Codex.
//
// Đây là thành phần DUY NHẤT chạm tới credential ChatGPT (spec §14,
// §16). agentgateway, imagegen-mcp và Redis đều không mount được PVC
// codex-home.

import { mkdir, writeFile, rm, access, readdir, stat, copyFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ImagegenError,
  MIME_BY_FORMAT,
  log,
  toImagegenError,
} from "@tinyorbit/contracts";
import type { ArtifactRef, JobPayload } from "@tinyorbit/contracts";
import type { JobQueue, JobStore } from "@tinyorbit/job-queue";
import type { ArtifactStorage } from "@tinyorbit/artifact-storage";

import { buildCreatePrompt, buildEditPrompt, specHash } from "./prompt.ts";
import { classifyCodexFailure, runCodex } from "./runner.ts";
import type { CodexResult } from "./runner.ts";
import { metrics } from "./metrics.ts";
import { readImageInfo } from "./imagesize.ts";

/** Cho phép test thay Codex thật bằng hàm giả. */
export type CodexRunner = (opts: {
  binary: string;
  codexHome: string;
  prompt: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}) => Promise<CodexResult>;

export interface ConsumerConfig {
  workDir: string;
  codexHome: string;
  codexBinary: string;
  jobTimeoutSeconds: number;
  concurrency: number;
  /** Mặc định 24 nếu không truyền. 0 = không bao giờ dọn. */
  generatedImageRetentionHours?: number;
}

export interface ConsumerDeps {
  store: JobStore;
  queue: JobQueue;
  storage: ArtifactStorage;
  config: ConsumerConfig;
  runner?: CodexRunner;
}

/** Khoá S3 của artifact (spec §19). Ghép từ mảnh đã làm sạch. */
export function artifactKey(
  projectId: string,
  assetId: string,
  version: number,
  filename: string,
): string {
  return `projects/${projectId}/${assetId}/v${version}/${filename}`;
}

/**
 * Cứu tấm ảnh Codex ĐÃ SINH nhưng không đặt đúng chỗ.
 *
 * Công cụ sinh ảnh của Codex lưu vào $CODEX_HOME/generated_images/<phiên>/
 * rồi Codex mới chép sang đường dẫn ta yêu cầu. Bước chép đó có thể
 * không xảy ra mà tiến trình VẪN THOÁT MÃ 0 — hỏng câm. Đo trong pod
 * thật 2026-09-12: 9 file PNG mồ côi (5.3M), dấu thời gian khớp đúng
 * các job "failed". Ảnh đã sinh xong và ĐÃ TIÊU một lượt quota ChatGPT;
 * vứt đi là vứt tiền thật.
 *
 * Nguyên nhân đã tìm ra và đã sửa ở prompt.ts (chính câu cấm đọc ngoài
 * thư mục của ta khiến Codex từ chối chép ảnh nó vừa sinh). Hàm này vẫn
 * giữ làm LƯỚI AN TOÀN: exit code của Codex không phản ánh được việc có
 * file hay không, nên chừng nào còn phụ thuộc vào việc nó tự chép file
 * thì còn cần chỗ đỡ. Log ở mức warn để thấy được tần suất — nếu về 0
 * lâu dài thì bản vá prompt đang làm đủ việc.
 *
 * CẢNH BÁO khi sửa: KHÔNG thử "chữa" bằng cách cài python vào image.
 * Đã thử 2026-09-12 (tưởng Codex trượt ở bước tự kiểm bằng PIL) —
 * dựng lại image có python3 + PIL, chạy job thật, HỎNG Y HỆT.
 *
 * Mốc `>= startedAtMs` là chốt chặn bắt buộc: ảnh của job trước không
 * được lọt vào, vì giao nhầm ảnh còn tệ hơn báo hỏng.
 */
export async function salvageGeneratedImage(
  codexHome: string,
  target: string,
  startedAtMs: number,
): Promise<string | null> {
  const root = join(codexHome, "generated_images");
  let sessions: string[];
  try {
    sessions = await readdir(root);
  } catch {
    return null;
  }

  let best: { path: string; mtimeMs: number } | null = null;
  for (const session of sessions) {
    let files: string[];
    try {
      files = await readdir(join(root, session));
    } catch {
      continue; // không phải thư mục, hoặc vừa bị dọn
    }
    for (const f of files) {
      if (!/\.(png|jpe?g|webp)$/i.test(f)) continue;
      const full = join(root, session, f);
      try {
        const st = await stat(full);
        if (st.mtimeMs >= startedAtMs && (!best || st.mtimeMs > best.mtimeMs)) {
          best = { path: full, mtimeMs: st.mtimeMs };
        }
      } catch {
        // file biến mất giữa chừng
      }
    }
  }

  if (!best) return null;
  await copyFile(best.path, target);
  return best.path;
}


/**
 * Dọn ảnh cũ trong kho riêng của công cụ sinh ảnh.
 *
 * Codex để lại một bản trong $CODEX_HOME/generated_images/<phiên>/ SAU MỌI
 * job — kể cả job thành công, lúc ảnh đã nằm an toàn trên S3. Không dọn
 * thì PVC codex-home phình vô hạn: đo 2026-09-12 là 9 file / 5.9MB chỉ
 * sau một buổi thử, khoảng 0.7MB mỗi lượt.
 *
 * Dọn theo TUỔI chứ không theo job: hàm chạy sau khi job xong, mà
 * salvageGeneratedImage() lại cần đọc kho này lúc job đang chạy. Cắt theo
 * tuổi thì hai việc không bao giờ giẫm chân nhau, kể cả sau này nâng
 * concurrency lên >1.
 *
 * Mọi lỗi đều nuốt: đây là việc dọn nhà, không đáng làm hỏng một job đã
 * chạy xong.
 */
export async function pruneGeneratedImages(
  codexHome: string,
  maxAgeMs: number,
  now = Date.now(),
): Promise<number> {
  if (maxAgeMs <= 0) return 0;
  const root = join(codexHome, "generated_images");
  let sessions: string[];
  try {
    sessions = await readdir(root);
  } catch {
    return 0;
  }

  let removed = 0;
  for (const session of sessions) {
    const dir = join(root, session);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    let conLai = files.length;
    for (const f of files) {
      const full = join(dir, f);
      try {
        const st = await stat(full);
        if (now - st.mtimeMs <= maxAgeMs) continue;
        await rm(full, { force: true });
        removed += 1;
        conLai -= 1;
      } catch {
        /* bỏ qua */
      }
    }
    // Thư mục phiên rỗng thì bỏ luôn, đừng để lại hàng trăm thư mục rỗng.
    if (conLai === 0) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return removed;
}

export class Consumer {
  #store: JobStore;
  #queue: JobQueue;
  #storage: ArtifactStorage;
  #cfg: ConsumerConfig;
  #runCodex: CodexRunner;
  #stopping = false;
  #active = 0;

  constructor(deps: ConsumerDeps) {
    this.#store = deps.store;
    this.#queue = deps.queue;
    this.#storage = deps.storage;
    this.#cfg = deps.config;
    this.#runCodex = deps.runner ?? runCodex;
  }

  get active(): number {
    return this.#active;
  }

  stop(): void {
    this.#stopping = true;
  }

  /**
   * Vòng lặp chính. Chạy tới khi stop() được gọi.
   *
   * Concurrency mặc định 1 (spec §14): một phiên ChatGPT, một tiến trình
   * Codex. Cho phép cấu hình để nâng sau, nhưng KHÔNG nâng mặc định.
   */
  async run(): Promise<void> {
    log.info("consumer bắt đầu", {
      concurrency: this.#cfg.concurrency,
      work_dir: this.#cfg.workDir,
    });

    while (!this.#stopping) {
      if (this.#active >= this.#cfg.concurrency) {
        await sleep(100);
        continue;
      }

      let payload: JobPayload | null = null;
      try {
        // Chờ tối đa 5 giây rồi quay lại kiểm cờ dừng — nhờ vậy pod tắt
        // trong vài giây thay vì treo tới khi kubelet SIGKILL.
        payload = await this.#queue.dequeue(5000);
      } catch (err) {
        log.error("đọc hàng đợi thất bại", { err });
        await sleep(1000);
        continue;
      }
      if (!payload) continue;

      this.#active += 1;
      void this.#handle(payload).finally(() => {
        this.#active -= 1;
      });
    }

    // Chờ việc đang chạy kết thúc trước khi trả quyền cho caller.
    while (this.#active > 0) await sleep(100);
    log.info("consumer đã dừng");
  }

  async #handle(payload: JobPayload): Promise<void> {
    const started = Date.now();
    const { jobId, spec } = payload;
    const jobDir = join(this.#cfg.workDir, jobId);
    const controller = new AbortController();

    metrics.jobStarted();
    let codexExitCode = -1;
    let uploadMs = 0;
    let ok = false;

    try {
      // Job bị huỷ khi còn nằm trong hàng đợi thì đừng tốn một lượt
      // Codex — đó là quota thật.
      if (await this.#queue.isCancelled(jobId)) {
        await this.#store.markCancelled(jobId);
        return;
      }

      await this.#store.markRunning(jobId);

      // Thư mục RIÊNG cho mỗi job (spec §24). Tên chứa UUID và worker
      // không bao giờ ghép đường dẫn từ chuỗi người dùng, nên không job
      // nào đọc được thư mục của job khác.
      await mkdir(jobDir, { recursive: true, mode: 0o700 });

      let prompt: string;
      if (payload.kind === "edit") {
        const sourceFilename = `source.${spec.outputFormat}`;
        const buf = await this.#storage.download(payload.sourceKey!);
        await writeFile(join(jobDir, sourceFilename), buf, { mode: 0o600 });
        prompt = buildEditPrompt(spec, payload.instructions ?? "", sourceFilename, jobDir);
      } else {
        prompt = buildCreatePrompt(spec, jobDir);
      }

      // Theo dõi cờ huỷ trong lúc Codex chạy: không có vòng này thì
      // cancel_image_job chỉ đổi được trạng thái trên giấy còn tiến
      // trình Codex vẫn chạy tới hết và vẫn tốn quota.
      const watcher = setInterval(() => {
        void this.#queue.isCancelled(jobId).then((c) => {
          if (c) controller.abort();
        });
      }, 2000);

      let result: CodexResult;
      try {
        result = await this.#runCodex({
          binary: this.#cfg.codexBinary,
          codexHome: this.#cfg.codexHome,
          prompt,
          cwd: jobDir,
          timeoutMs: this.#cfg.jobTimeoutSeconds * 1000,
          signal: controller.signal,
        });
      } finally {
        clearInterval(watcher);
      }

      codexExitCode = result.exitCode;
      metrics.codexRan(result.durationMs / 1000);

      if (result.exitCode !== 0) {
        const code = classifyCodexFailure(result.stderrTail);
        // stderr CHỈ vào log phía server (đã lọc secret), KHÔNG ra MCP.
        log.warn("codex thoát với mã khác 0", {
          job_id: jobId,
          codex_exit_code: result.exitCode,
          classified: code,
          stderr_tail: result.stderrTail,
        });
        throw new ImagegenError(code, messageFor(code));
      }

      // Codex thoát 0 KHÔNG bảo đảm file đã nằm đúng chỗ — xem
      // salvageGeneratedImage. Kiểm rồi cứu trước khi kết luận hỏng.
      const outPath = join(jobDir, spec.filename);
      try {
        await access(outPath);
      } catch {
        const saved = await salvageGeneratedImage(this.#cfg.codexHome, outPath, started);
        if (!saved) {
          log.warn("codex thoát 0 nhưng không có ảnh, cũng không cứu được", {
            job_id: jobId,
          });
          throw new ImagegenError(
            "IMAGE_GENERATION_FAILED",
            messageFor("IMAGE_GENERATION_FAILED"),
          );
        }
        // Mức warn chứ không im lặng: đây là bản vá cho hành vi thất
        // thường của Codex, phải thấy được tần suất mới biết lúc nào
        // upstream sửa xong thì gỡ.
        log.warn("codex không đặt ảnh đúng chỗ — đã cứu từ generated_images", {
          job_id: jobId,
        });
      }

      // *** ĐO ẢNH THẬT, ĐỪNG CHÉP LẠI YÊU CẦU ***
      // Bản cũ ghi `width: spec.width` — tức khai lại con số ta ĐÃ XIN,
      // không phải con số ta NHẬN ĐƯỢC. Đo trên job thật 2026-09-12:
      // xin 1536x1536, Codex trả 1254x1254, metadata vẫn khai 1536x1536.
      // Claude đọc metadata đó rồi dựng bố cục sai mà không ai biết.
      //
      // Không đọc được header thì LÙI về đặc tả và ghi log, chứ không
      // làm hỏng cả job: ảnh vẫn dùng được, chỉ là số đo kém tin cậy.
      const info = await readImageInfo(outPath);
      if (!info) {
        log.warn("không đọc được kích thước ảnh, dùng tạm số trong đặc tả", {
          job_id: jobId,
          output_format: spec.outputFormat,
        });
      } else if (info.width !== spec.width || info.height !== spec.height) {
        // Không phải lỗi: mô hình sinh ảnh có tỉ lệ riêng của nó. Ghi log
        // để thấy được độ lệch thường gặp là bao nhiêu.
        log.info("kích thước ảnh khác đặc tả", {
          job_id: jobId,
          xin: `${spec.width}x${spec.height}`,
          nhan: `${info.width}x${info.height}`,
        });
      }
      if (info && spec.transparentBackground && !info.hasAlpha) {
        // Đây MỚI là lỗi đáng kêu: xin nền trong suốt mà ảnh không có
        // kênh alpha thì chắc chắn không trong suốt được.
        log.warn("xin nền trong suốt nhưng ảnh không có kênh alpha", {
          job_id: jobId,
        });
      }

      const mimeType = MIME_BY_FORMAT[spec.outputFormat];
      const key = artifactKey(spec.projectId, spec.assetId, payload.version, spec.filename);
      const upload = await this.#storage.uploadArtifact(outPath, key, mimeType);
      uploadMs = upload.durationMs;
      metrics.uploaded(uploadMs / 1000);

      const artifact: ArtifactRef = {
        projectId: spec.projectId,
        assetId: spec.assetId,
        version: payload.version,
        parentVersion: payload.parentVersion,
        key,
        url: upload.url,
        mimeType,
        width: info?.width ?? spec.width,
        height: info?.height ?? spec.height,
        // `transparent` mô tả FILE, nên lấy theo file. Ranh giới của cờ
        // này ghi ở ImageInfo.hasAlpha: "có kênh alpha", không phải "có
        // pixel trong suốt".
        transparent: info?.hasAlpha ?? spec.transparentBackground,
        specHash: specHash(prompt),
        createdAt: new Date().toISOString(),
      };

      // metadata.json nằm cạnh ảnh (spec §19). KHÔNG chứa credential,
      // KHÔNG chứa đặc tả nguyên văn — chỉ bản băm.
      await this.#storage.uploadMetadata(
        artifactKey(spec.projectId, spec.assetId, payload.version, "metadata.json"),
        {
          project_id: artifact.projectId,
          asset_id: artifact.assetId,
          version: artifact.version,
          parent_version: artifact.parentVersion,
          job_id: jobId,
          content_type: artifact.mimeType,
          width: artifact.width,
          height: artifact.height,
          transparent: artifact.transparent,
          style_reference: spec.styleReference,
          spec_hash: artifact.specHash,
          generator: "codex-chatgpt-image",
          created_at: artifact.createdAt,
        },
      );

      await this.#store.markCompleted(jobId, artifact);
      ok = true;
    } catch (err) {
      if (controller.signal.aborted || (err as Error).message === "CANCELLED") {
        await this.#store.markCancelled(jobId);
      } else {
        const e = toImagegenError(err, "IMAGE_GENERATION_FAILED");
        await this.#store.markFailed(jobId, e.code, e.message);
      }
    } finally {
      // Dọn thư mục job dù thành công hay thất bại: ảnh đã lên object
      // storage, giữ lại chỉ làm đầy emptyDir cho tới khi node hết đĩa.
      await rm(jobDir, { recursive: true, force: true }).catch(() => {});

      // Dọn kho ảnh của Codex (xem pruneGeneratedImages). Không để hỏng
      // đường kết thúc job: hàm đã tự nuốt lỗi, ở đây bắt thêm một lớp.
      try {
        const gio = this.#cfg.generatedImageRetentionHours ?? 24;
        const n = await pruneGeneratedImages(this.#cfg.codexHome, gio * 3_600_000);
        if (n > 0) log.info("đã dọn ảnh cũ trong kho của Codex", { so_file: n });
      } catch {
        /* dọn nhà hỏng thì thôi */
      }
      await this.#queue.ack(jobId);

      const durationMs = Date.now() - started;
      metrics.jobFinished(durationMs / 1000, ok);
      const final = await this.#store.get(jobId).catch(() => null);
      log.info("job kết thúc", {
        job_id: jobId,
        project_id: spec.projectId,
        asset_id: spec.assetId,
        version: payload.version,
        status: final?.status ?? "unknown",
        duration_ms: durationMs,
        codex_exit_code: codexExitCode,
        artifact_upload_duration_ms: uploadMs,
      });
    }
  }
}

function messageFor(code: string): string {
  switch (code) {
    case "CODEX_NOT_AUTHENTICATED":
      return (
        "Phiên đăng nhập ChatGPT của worker đã hết hạn. " +
        "Người vận hành cần chạy lại `codex login --device-auth` trong pod."
      );
    case "IMAGE_CAPABILITY_UNAVAILABLE":
      // Spec §31: nói thẳng là thiếu khả năng, và nói rõ KHÔNG có đường
      // vòng qua API key — để không ai đi "sửa" bằng cách đó.
      return (
        "Tài khoản ChatGPT đang đăng nhập không dùng được khả năng sinh ảnh " +
        "của Codex. Nền tảng KHÔNG tự chuyển sang OpenAI API key; cần một " +
        "tài khoản/gói có hỗ trợ sinh ảnh."
      );
    default:
      return "Codex không sinh được ảnh. Xem log của codex-image-worker theo job_id.";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
