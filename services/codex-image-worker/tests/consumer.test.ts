// Test tích hợp của consumer: Codex GIẢ + object storage GIẢ.
//
// Codex giả ghi ra đúng file mà chỉ dẫn yêu cầu, nên test đi qua cả
// đường thật (thư mục job riêng, upload, metadata, dọn dẹp) mà không cần
// tài khoản ChatGPT và không tốn quota.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readdir, readFile, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { join } from "node:path";

import type { ImageSpec, JobPayload, JobRecord } from "@tinyorbit/contracts";
import { InMemoryJobQueue, InMemoryJobStore } from "@tinyorbit/job-queue";
import type { ArtifactStorage } from "@tinyorbit/artifact-storage";

import { Consumer, pruneGeneratedImages } from "../src/consumer.ts";
import type { CodexRunner } from "../src/consumer.ts";

let workRoot: string;
before(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "codex-worker-test-"));
});
after(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

function spec(over: Partial<ImageSpec> = {}): ImageSpec {
  return {
    projectId: "tinyorbit-cloud",
    assetId: "homepage-hero-vps",
    description: "máy chủ VPS",
    stylePrompt: "claymorphism",
    styleReference: "tinyorbit-cloud-v1",
    aspectRatio: "1:1",
    width: 1536,
    height: 1536,
    transparentBackground: true,
    outputFormat: "png",
    isolatedObject: true,
    safePaddingPercent: 12,
    filename: "artifact.png",
    ...over,
  };
}

function record(jobId: string, s: ImageSpec, version = 1): JobRecord {
  return {
    jobId, status: "queued", projectId: s.projectId, assetId: s.assetId,
    version, parentVersion: null, principal: "claude-design",
    createdAt: new Date().toISOString(), startedAt: null, completedAt: null,
    artifact: null, errorCode: null, errorMessage: null, traceId: null,
  };
}

class FakeStorage {
  objects = new Map<string, Buffer>();
  metadata = new Map<string, unknown>();
  failUploads = false;

  async uploadArtifact(localPath: string, key: string, _mime: string) {
    if (this.failUploads) {
      const { ImagegenError } = await import("@tinyorbit/contracts");
      throw new ImagegenError("STORAGE_UPLOAD_FAILED", "Không đẩy được artifact");
    }
    let body: Buffer;
    try {
      body = await readFile(localPath);
    } catch {
      const { ImagegenError } = await import("@tinyorbit/contracts");
      throw new ImagegenError(
        "IMAGE_GENERATION_FAILED",
        "Codex chạy xong nhưng không tạo ra file ảnh",
      );
    }
    this.objects.set(key, body);
    return { key, url: `https://s3.example/${key}`, bytes: body.byteLength, durationMs: 1 };
  }
  async uploadMetadata(key: string, meta: unknown) {
    this.metadata.set(key, meta);
  }
  async download(key: string) {
    const b = this.objects.get(key);
    if (!b) throw new Error("không có");
    return b;
  }
  async isReachable() {
    return true;
  }
  publicUrl(key: string) {
    return `https://s3.example/${key}`;
  }
  async signedUrl(key: string) {
    return this.publicUrl(key);
  }
}

/** Codex giả thành công: ghi ra đúng file mà chỉ dẫn yêu cầu. */
const codexOk: CodexRunner = async (opts) => {
  const m = /Save the (?:final generated asset|edited artifact) to exactly this path: (.+)$/m.exec(
    opts.prompt,
  );
  assert.ok(m, "chỉ dẫn phải nêu đường dẫn đầu ra");
  await writeFile(m![1]!.trim(), Buffer.from("PNGFAKE"));
  return { exitCode: 0, durationMs: 5, stderrTail: "" };
};

function codexFailing(stderr: string): CodexRunner {
  return async () => ({ exitCode: 1, durationMs: 5, stderrTail: stderr });
}

function build(runner: CodexRunner, storage = new FakeStorage()) {
  const store = new InMemoryJobStore();
  const queue = new InMemoryJobQueue();
  const consumer = new Consumer({
    store,
    queue,
    storage: storage as unknown as ArtifactStorage,
    config: {
      workDir: join(workRoot, "jobs"),
      codexHome: join(workRoot, "codex"),
      codexBinary: "codex",
      jobTimeoutSeconds: 30,
      concurrency: 1,
    },
    runner,
  });
  return { consumer, store, queue, storage };
}

/** Chạy consumer đủ lâu để xử lý xong job rồi dừng. */
async function runOnce(c: Consumer, store: InMemoryJobStore, jobId: string): Promise<string> {
  void c.run();
  const deadline = Date.now() + 5000;
  for (;;) {
    const s = (await store.get(jobId))?.status;
    if (s && s !== "queued" && s !== "running") {
      c.stop();
      await new Promise((r) => setTimeout(r, 60));
      return s;
    }
    if (Date.now() > deadline) {
      c.stop();
      throw new Error(`job không kết thúc, đang ${s}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

function payload(jobId: string, s: ImageSpec): JobPayload {
  return { jobId, kind: "create", spec: s, version: 1, parentVersion: null, sourceKey: null, instructions: null };
}

describe("consumer — đường thành công", () => {
  test("artifact nằm đúng khoá S3 theo spec §19", async () => {
    const { consumer, store, queue, storage } = build(codexOk);
    const s = spec();
    await store.create(record("img_1", s));
    await queue.enqueue(payload("img_1", s));

    assert.equal(await runOnce(consumer, store, "img_1"), "completed");
    assert.ok(
      storage.objects.has("projects/tinyorbit-cloud/homepage-hero-vps/v1/artifact.png"),
    );
    assert.ok(
      storage.metadata.has("projects/tinyorbit-cloud/homepage-hero-vps/v1/metadata.json"),
    );

    const job = await store.get("img_1");
    assert.equal(job!.artifact!.transparent, true);
    assert.equal(job!.artifact!.width, 1536);
  });

  test("metadata ghi style_reference nhưng KHÔNG ghi đặc tả nguyên văn", async () => {
    const { consumer, store, queue, storage } = build(codexOk);
    const s = spec({ description: "bí mật thương mại không được lộ" });
    await store.create(record("img_2", s));
    await queue.enqueue(payload("img_2", s));
    await runOnce(consumer, store, "img_2");

    const meta = JSON.stringify([...storage.metadata.values()]);
    assert.doesNotMatch(meta, /bí mật thương mại/);
    assert.match(meta, /"spec_hash":\s*"[0-9a-f]{64}"/);
    assert.match(meta, /"style_reference":\s*"tinyorbit-cloud-v1"/);
    assert.match(meta, /"generator":\s*"codex-chatgpt-image"/);
  });

  test("dọn sạch thư mục job sau khi xong", async () => {
    const { consumer, store, queue } = build(codexOk);
    const s = spec();
    await store.create(record("img_3", s));
    await queue.enqueue(payload("img_3", s));
    await runOnce(consumer, store, "img_3");

    const left = await readdir(join(workRoot, "jobs")).catch(() => []);
    assert.ok(!left.includes("img_3"), "thư mục job phải bị xoá");
  });
});

describe("consumer — Codex thất bại", () => {
  test("phiên hết hạn -> CODEX_NOT_AUTHENTICATED, KHÔNG rò stderr ra ngoài", async () => {
    const { consumer, store, queue } = build(
      codexFailing("Error: not logged in; see /home/codex/.codex/auth.json"),
    );
    const s = spec();
    await store.create(record("img_4", s));
    await queue.enqueue(payload("img_4", s));

    assert.equal(await runOnce(consumer, store, "img_4"), "failed");
    const job = await store.get("img_4");
    assert.equal(job!.errorCode, "CODEX_NOT_AUTHENTICATED");
    // stderr chứa đường dẫn file token — không được đi ra ngoài (spec §22).
    assert.doesNotMatch(JSON.stringify(job), /auth\.json/);
  });

  test("tài khoản không có khả năng sinh ảnh -> lỗi KHẢ NĂNG tường minh", async () => {
    // Spec §31: phải báo lỗi khả năng rõ ràng, và nói thẳng là không có
    // đường vòng qua API key.
    const { consumer, store, queue } = build(
      codexFailing("image generation is not available on your plan"),
    );
    const s = spec();
    await store.create(record("img_5", s));
    await queue.enqueue(payload("img_5", s));

    assert.equal(await runOnce(consumer, store, "img_5"), "failed");
    const job = await store.get("img_5");
    assert.equal(job!.errorCode, "IMAGE_CAPABILITY_UNAVAILABLE");
    assert.match(job!.errorMessage!, /KHÔNG tự chuyển sang OpenAI API key/);
  });

  test("Codex báo thành công nhưng không tạo file -> vẫn failed", async () => {
    const noFile: CodexRunner = async () => ({ exitCode: 0, durationMs: 5, stderrTail: "" });
    const { consumer, store, queue } = build(noFile);
    const s = spec();
    await store.create(record("img_6", s));
    await queue.enqueue(payload("img_6", s));
    assert.equal(await runOnce(consumer, store, "img_6"), "failed");
  });
});

describe("consumer — upload thất bại", () => {
  test("job thành failed với STORAGE_UPLOAD_FAILED", async () => {
    const storage = new FakeStorage();
    storage.failUploads = true;
    const { consumer, store, queue } = build(codexOk, storage);
    const s = spec();
    await store.create(record("img_7", s));
    await queue.enqueue(payload("img_7", s));

    assert.equal(await runOnce(consumer, store, "img_7"), "failed");
    assert.equal((await store.get("img_7"))!.errorCode, "STORAGE_UPLOAD_FAILED");
  });
});

describe("consumer — huỷ job", () => {
  test("job bị huỷ khi còn trong hàng đợi thì KHÔNG chạy Codex", async () => {
    // Quan trọng: mỗi lần chạy Codex là quota thật. Huỷ trước khi chạy
    // phải thật sự tiết kiệm được lượt đó.
    let codexCalls = 0;
    const counting: CodexRunner = async (opts) => {
      codexCalls += 1;
      return codexOk(opts);
    };
    const { consumer, store, queue } = build(counting);
    const s = spec();
    await store.create(record("img_8", s));
    await queue.enqueue(payload("img_8", s));
    await queue.requestCancel("img_8");

    assert.equal(await runOnce(consumer, store, "img_8"), "cancelled");
    assert.equal(codexCalls, 0, "Codex không được chạy cho job đã huỷ");
  });
});

describe("consumer — cứu ảnh Codex sinh ra nhưng đặt sai chỗ", () => {
  // Codex sinh ảnh vào $CODEX_HOME/generated_images/<phiên>/ rồi mới
  // chuyển sang chỗ ta yêu cầu. Bước tự kiểm sau đó gọi `python`, mà
  // image không có python, nên nó bỏ dở việc chuyển file NHƯNG VẪN
  // THOÁT 0. Đo trong pod thật 2026-09-12: 9 PNG mồ côi, dấu thời gian
  // khớp đúng các job hỏng. Mỗi tấm là một lượt quota ChatGPT đã trả.

  /** Codex giả "đãng trí": sinh ảnh vào kho riêng, quên chuyển đi. */
  function codexQuenChuyen(body: string): CodexRunner {
    return async (opts) => {
      const dir = join(opts.codexHome, "generated_images", "phien-abc");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "img-001.png"), Buffer.from(body));
      return { exitCode: 0, durationMs: 5, stderrTail: "" };
    };
  }

  test("lấy ảnh trong generated_images thay vì vứt một lượt quota", async () => {
    const { consumer, store, queue, storage } = build(codexQuenChuyen("ANH-CUU-DUOC"));
    const s = spec();
    await store.create(record("img_salvage_1", s));
    await queue.enqueue(payload("img_salvage_1", s));

    assert.equal(await runOnce(consumer, store, "img_salvage_1"), "completed");
    const key = [...storage.objects.keys()].find((k) => k.endsWith("artifact.png"));
    assert.ok(key, "phải có artifact được đẩy lên");
    assert.equal(storage.objects.get(key!)!.toString(), "ANH-CUU-DUOC");
  });

  test("KHÔNG lấy ảnh cũ hơn lúc job bắt đầu — giao nhầm còn tệ hơn báo hỏng", async () => {
    const { consumer, store, queue } = build(async () => ({
      exitCode: 0,
      durationMs: 5,
      stderrTail: "",
    }));
    // Ảnh của một job TRƯỚC, nằm sẵn trong kho từ một giờ trước.
    const dir = join(workRoot, "codex", "generated_images", "phien-cu");
    await mkdir(dir, { recursive: true });
    const cu = join(dir, "img-cu.png");
    await writeFile(cu, Buffer.from("ANH-CUA-JOB-TRUOC"));
    const motGioTruoc = new Date(Date.now() - 3_600_000);
    await utimes(cu, motGioTruoc, motGioTruoc);

    const s = spec();
    await store.create(record("img_salvage_2", s));
    await queue.enqueue(payload("img_salvage_2", s));

    assert.equal(await runOnce(consumer, store, "img_salvage_2"), "failed");
    assert.equal((await store.get("img_salvage_2"))!.errorCode, "IMAGE_GENERATION_FAILED");
  });

  test("không có kho generated_images thì báo hỏng gọn, không nổ lỗi khác", async () => {
    const rieng = await mkdtemp(join(tmpdir(), "codex-worker-trong-"));
    try {
      const store = new InMemoryJobStore();
      const queue = new InMemoryJobQueue();
      const storage = new FakeStorage();
      const consumer = new Consumer({
        store,
        queue,
        storage: storage as unknown as ArtifactStorage,
        config: {
          workDir: join(rieng, "jobs"),
          codexHome: join(rieng, "codex-trong"),
          codexBinary: "codex",
          jobTimeoutSeconds: 30,
          concurrency: 1,
        },
        runner: async () => ({ exitCode: 0, durationMs: 5, stderrTail: "" }),
      });
      const s = spec();
      await store.create(record("img_salvage_3", s));
      await queue.enqueue(payload("img_salvage_3", s));

      assert.equal(await runOnce(consumer, store, "img_salvage_3"), "failed");
      assert.equal((await store.get("img_salvage_3"))!.errorCode, "IMAGE_GENERATION_FAILED");
    } finally {
      await rm(rieng, { recursive: true, force: true });
    }
  });
});

describe("consumer — metadata phải ĐO ảnh, không chép lại yêu cầu", () => {
  // Đo trên job thật 2026-09-12: xin 1536x1536, Codex trả 1254x1254,
  // mà metadata vẫn khai 1536x1536 vì code ghi thẳng `spec.width`.
  // Claude đọc metadata đó rồi dựng bố cục sai mà không ai biết.

  /** PNG hợp lệ tối thiểu, kích thước và colorType tuỳ chọn. */
  function pngThat(w: number, h: number, colorType: number): Buffer {
    const kenh = colorType === 6 ? 4 : 3;
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = colorType;
    const idat = deflateSync(Buffer.alloc(h * (1 + w * kenh)));
    const chunk = (t: string, d: Buffer) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(d.length, 0);
      return Buffer.concat([len, Buffer.from(t, "latin1"), d, Buffer.alloc(4)]);
    };
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", idat),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  }

  function codexTraVe(buf: Buffer): CodexRunner {
    return async (opts) => {
      const m = /Save the (?:final generated asset|edited artifact) to exactly this path: (.+)$/m.exec(
        opts.prompt,
      );
      await writeFile(m![1]!.trim(), buf);
      return { exitCode: 0, durationMs: 5, stderrTail: "" };
    };
  }

  test("khai kích thước THẬT của ảnh chứ không phải kích thước đã xin", async () => {
    const { consumer, store, queue, storage } = build(codexTraVe(pngThat(1254, 1254, 6)));
    const s = spec({ width: 1536, height: 1536 });
    await store.create(record("img_meta_1", s));
    await queue.enqueue(payload("img_meta_1", s));

    assert.equal(await runOnce(consumer, store, "img_meta_1"), "completed");
    const art = (await store.get("img_meta_1"))!.artifact!;
    assert.equal(art.width, 1254, "phải là số đo từ file");
    assert.equal(art.height, 1254);

    const meta = [...storage.metadata.values()][0] as Record<string, unknown>;
    assert.equal(meta.width, 1254, "metadata.json cũng phải theo file");
    assert.equal(meta.height, 1254);
  });

  test("ảnh không có kênh alpha thì transparent=false, dù đã xin nền trong suốt", async () => {
    // Xin một đằng nhận một nẻo là chuyện có thật; metadata phải nói
    // đúng thứ nằm trong file, nếu không Claude sẽ ghép ảnh có nền đặc
    // lên bố cục tưởng là trong suốt.
    const { consumer, store, queue } = build(codexTraVe(pngThat(64, 64, 2)));
    const s = spec({ transparentBackground: true });
    await store.create(record("img_meta_2", s));
    await queue.enqueue(payload("img_meta_2", s));

    assert.equal(await runOnce(consumer, store, "img_meta_2"), "completed");
    assert.equal((await store.get("img_meta_2"))!.artifact!.transparent, false);
  });

  test("không đọc được header thì lùi về đặc tả, KHÔNG làm hỏng job", async () => {
    const { consumer, store, queue } = build(codexTraVe(Buffer.from("khong phai anh")));
    const s = spec({ width: 1536, height: 1536 });
    await store.create(record("img_meta_3", s));
    await queue.enqueue(payload("img_meta_3", s));

    assert.equal(await runOnce(consumer, store, "img_meta_3"), "completed");
    const art = (await store.get("img_meta_3"))!.artifact!;
    assert.deepEqual([art.width, art.height], [1536, 1536]);
  });
});

describe("pruneGeneratedImages — không để kho ảnh của Codex phình vô hạn", () => {
  // Codex để lại một bản ảnh SAU MỌI job, kể cả job thành công. Đo
  // 2026-09-12: 9 file / 5.9MB sau một buổi thử, ~0.7MB mỗi lượt.

  async function dungKho(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), "codexhome-"));
    await mkdir(join(home, "generated_images", "phien-cu"), { recursive: true });
    await mkdir(join(home, "generated_images", "phien-moi"), { recursive: true });
    const cu = join(home, "generated_images", "phien-cu", "cu.png");
    const moi = join(home, "generated_images", "phien-moi", "moi.png");
    await writeFile(cu, Buffer.from("CU"));
    await writeFile(moi, Buffer.from("MOI"));
    const batNgay = new Date(Date.now() - 48 * 3_600_000);
    await utimes(cu, batNgay, batNgay);
    return home;
  }

  test("xoá ảnh quá hạn và bỏ luôn thư mục phiên đã rỗng", async () => {
    const home = await dungKho();
    try {
      const n = await pruneGeneratedImages(home, 24 * 3_600_000);
      assert.equal(n, 1);
      const conLai = await readdir(join(home, "generated_images"));
      assert.deepEqual(conLai, ["phien-moi"], "thư mục rỗng phải bị dọn theo");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("KHÔNG đụng vào ảnh còn trong hạn — salvage vẫn cần đọc chúng", async () => {
    const home = await dungKho();
    try {
      const n = await pruneGeneratedImages(home, 72 * 3_600_000);
      assert.equal(n, 0);
      assert.equal((await readdir(join(home, "generated_images"))).length, 2);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("maxAge = 0 nghĩa là TẮT hẳn, không xoá gì", async () => {
    const home = await dungKho();
    try {
      assert.equal(await pruneGeneratedImages(home, 0), 0);
      assert.equal((await readdir(join(home, "generated_images"))).length, 2);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("kho không tồn tại thì trả 0, không ném lỗi", async () => {
    assert.equal(await pruneGeneratedImages(join(tmpdir(), "khong-co-that-xyz"), 1000), 0);
  });
});
