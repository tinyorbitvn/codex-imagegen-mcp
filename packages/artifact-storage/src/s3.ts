// Đẩy artifact lên object storage tương thích S3 (ở cụm này là Ceph RGW).

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { readFile } from "node:fs/promises";
import { ImagegenError } from "@tinyorbit/contracts";

export interface UploadResult {
  key: string;
  url: string;
  bytes: number;
  durationMs: number;
}

/** Cấu hình object storage. Gói tự khai để không phụ thuộc Config của service nào. */
export interface StorageConfig {
  endpoint: string;
  bucket: string;
  region: string;
  /** BẮT BUỘC true với Ceph RGW sau Gateway không có listener wildcard. */
  forcePathStyle: boolean;
  publicBaseUrl: string;
  signedUrlTtlSeconds: number;
  accessKeyId: string;
  secretAccessKey: string;
}

export class ArtifactStorage {
  #client: S3Client;
  #cfg: StorageConfig;

  constructor(cfg: StorageConfig) {
    this.#cfg = cfg;
    this.#client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      // *** BẮT BUỘC ở cụm này ***
      // s3.tinyorbit.vn không có listener wildcard *.s3.tinyorbit.vn nên
      // virtual-hosted-style (https://<bucket>.s3.../key) KHÔNG phân
      // giải được. Bỏ cờ này thì lỗi hiện ra dưới dạng ENOTFOUND/timeout
      // chứ không phải lỗi S3, rất mất thời gian lần.
      forcePathStyle: cfg.forcePathStyle,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
    });
  }

  /** Kiểm với tới được storage chưa — dùng cho readiness probe. */
  async isReachable(): Promise<boolean> {
    try {
      await this.#client.send(new HeadBucketCommand({ Bucket: this.#cfg.bucket }));
      return true;
    } catch {
      return false;
    }
  }

  async uploadArtifact(
    localPath: string,
    key: string,
    mimeType: string,
  ): Promise<UploadResult> {
    const started = Date.now();
    let body: Buffer;
    try {
      body = await readFile(localPath);
    } catch {
      throw new ImagegenError(
        "IMAGE_GENERATION_FAILED",
        "Codex chạy xong nhưng không tạo ra file ảnh ở đường dẫn đã yêu cầu",
      );
    }

    try {
      await this.#client.send(
        new PutObjectCommand({
          Bucket: this.#cfg.bucket,
          Key: key,
          Body: body,
          ContentType: mimeType,
        }),
      );
    } catch {
      // Nuốt thông điệp gốc: lỗi SDK hay kèm endpoint đầy đủ và đôi khi
      // cả access key id trong phần ký.
      throw new ImagegenError("STORAGE_UPLOAD_FAILED", "Không đẩy được artifact lên object storage");
    }

    return {
      key,
      url: this.publicUrl(key),
      bytes: body.byteLength,
      durationMs: Date.now() - started,
    };
  }

  async uploadMetadata(key: string, metadata: unknown): Promise<void> {
    try {
      await this.#client.send(
        new PutObjectCommand({
          Bucket: this.#cfg.bucket,
          Key: key,
          Body: JSON.stringify(metadata, null, 2),
          ContentType: "application/json",
        }),
      );
    } catch {
      throw new ImagegenError("STORAGE_UPLOAD_FAILED", "Không đẩy được metadata lên object storage");
    }
  }

  /** Tải artifact về thư mục job — dùng cho edit_image. */
  async download(key: string): Promise<Buffer> {
    try {
      const r = await this.#client.send(
        new GetObjectCommand({ Bucket: this.#cfg.bucket, Key: key }),
      );
      const chunks: Buffer[] = [];
      for await (const c of r.Body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(c));
      return Buffer.concat(chunks);
    } catch {
      throw new ImagegenError("JOB_NOT_FOUND", "Không đọc được artifact nguồn từ object storage");
    }
  }

  /**
   * URL công khai trả cho Claude.
   *
   * Bucket policy cho phép GetObject ẨN DANH dưới prefix projects/* (xem
   * templates/objectbucketclaim.yaml), nên URL trần là đủ và KHÔNG hết
   * hạn — quan trọng vì Claude có thể xem lại ảnh ở phiên sau.
   *
   * Muốn đổi sang URL ký sẵn thì dùng signedUrl() bên dưới và siết bucket
   * policy lại; đánh đổi là link chết khi xoay key.
   */
  publicUrl(key: string): string {
    return `${this.#cfg.publicBaseUrl}/${key}`;
  }

  /** URL ký sẵn, hạn theo S3_SIGNED_URL_TTL_SECONDS. */
  async signedUrl(key: string): Promise<string> {
    return getSignedUrl(
      this.#client,
      new GetObjectCommand({ Bucket: this.#cfg.bucket, Key: key }),
      { expiresIn: this.#cfg.signedUrlTtlSeconds },
    );
  }
}
