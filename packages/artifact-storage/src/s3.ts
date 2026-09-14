// Uploads artifacts to S3-compatible object storage.

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

/** Object storage config. This package declares its own so it doesn't depend on any service's Config. */
export interface StorageConfig {
  endpoint: string;
  bucket: string;
  region: string;
  /** MUST be true for self-hosted S3-compatible gateways with no wildcard DNS listener for their bucket subdomain. */
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
      // *** REQUIRED for self-hosted S3-compatible endpoints ***
      // Self-hosted gateways usually have no wildcard DNS listener for their
      // bucket subdomain, so virtual-hosted-style (https://<bucket>.s3.../key)
      // CANNOT resolve. Drop this flag and the failure shows up as
      // ENOTFOUND/timeout instead of an S3 error — very time-consuming to
      // trace back.
      forcePathStyle: cfg.forcePathStyle,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
    });
  }

  /** Checks whether storage is reachable — used for the readiness probe. */
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
        "Codex finished running but did not produce an image file at the requested path",
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
      // Swallow the original message: SDK errors often carry the full
      // endpoint and sometimes even the access key id in the signature part.
      throw new ImagegenError("STORAGE_UPLOAD_FAILED", "Failed to upload artifact to object storage");
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
      throw new ImagegenError("STORAGE_UPLOAD_FAILED", "Failed to upload metadata to object storage");
    }
  }

  /** Downloads an artifact into the job directory — used by edit_image. */
  async download(key: string): Promise<Buffer> {
    try {
      const r = await this.#client.send(
        new GetObjectCommand({ Bucket: this.#cfg.bucket, Key: key }),
      );
      const chunks: Buffer[] = [];
      for await (const c of r.Body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(c));
      return Buffer.concat(chunks);
    } catch {
      throw new ImagegenError("JOB_NOT_FOUND", "Failed to read source artifact from object storage");
    }
  }

  /**
   * Public URL returned to Claude.
   *
   * The bucket policy allows ANONYMOUS GetObject under the projects/* prefix,
   * so a bare URL is enough and it NEVER expires — important because Claude
   * may look at the image again in a later session.
   *
   * To switch to a signed URL, use signedUrl() below and tighten the bucket
   * policy; the trade-off is a dead link whenever the key rotates.
   */
  publicUrl(key: string): string {
    return `${this.#cfg.publicBaseUrl}/${key}`;
  }

  /** Signed URL, expiring according to S3_SIGNED_URL_TTL_SECONDS. */
  async signedUrl(key: string): Promise<string> {
    return getSignedUrl(
      this.#client,
      new GetObjectCommand({ Bucket: this.#cfg.bucket, Key: key }),
      { expiresIn: this.#cfg.signedUrlTtlSeconds },
    );
  }
}
