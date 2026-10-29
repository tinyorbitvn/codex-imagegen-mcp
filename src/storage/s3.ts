// Uploads artifacts to S3-compatible object storage.

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { readFile } from "node:fs/promises";
import { ImagegenError } from "../contracts/index.ts";
import type { ArtifactStore, PresignedUpload, UploadBucketSettings, UploadResult } from "./types.ts";

/**
 * ACL on every upload. An object belongs to whoever wrote it, so when the MCP
 * role writes uploads with a key of its own, the bucket owner (the worker)
 * gets 403 reading them without this grant (RGW, 2026-10-29).
 */
const OWNER_READS = "bucket-owner-full-control";

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

export class ArtifactStorage implements ArtifactStore {
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

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    try {
      await this.#client.send(
        new PutObjectCommand({
          Bucket: this.#cfg.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          ACL: OWNER_READS,
        }),
      );
    } catch {
      throw new ImagegenError("STORAGE_UPLOAD_FAILED", "Failed to store the upload in object storage");
    }
  }

  async headObject(key: string): Promise<{ bytes: number } | null> {
    try {
      const r = await this.#client.send(new HeadObjectCommand({ Bucket: this.#cfg.bucket, Key: key }));
      return { bytes: r.ContentLength ?? 0 };
    } catch (e) {
      if ((e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
      throw new ImagegenError("STORAGE_UPLOAD_FAILED", "Could not reach object storage to look up the upload");
    }
  }

  /**
   * The policy signature covers the bucket and the form fields, not the
   * host, so the in-cluster endpoint the client signs with can be swapped
   * for the public bucket URL the caller can actually reach. The acl field
   * is pinned in the policy, so a client cannot drop the owner's grant.
   */
  async presignUpload(
    key: string,
    contentType: string,
    maxBytes: number,
    ttlSeconds: number,
  ): Promise<PresignedUpload> {
    const { fields } = await createPresignedPost(this.#client, {
      Bucket: this.#cfg.bucket,
      Key: key,
      Conditions: [
        ["content-length-range", 1, maxBytes],
        ["eq", "$Content-Type", contentType],
        ["eq", "$acl", OWNER_READS],
      ],
      Fields: { "Content-Type": contentType, acl: OWNER_READS },
      Expires: ttlSeconds,
    });
    return { url: this.#cfg.publicBaseUrl, fields };
  }

  /**
   * Replaces the bucket's CORS and lifecycle with exactly these rules: the
   * bucket belongs to this service. GET stays open to every origin because
   * artifacts are already public; POST is governed by the signed policy.
   * Each is attempted even if the other fails (a store without per-bucket
   * CORS must still expire uploads), but never at the same time: RGW refused
   * one of two concurrent bucket-config writes with ConcurrentModification.
   */
  async configureUploads(settings: UploadBucketSettings): Promise<void> {
    const steps: Array<[string, () => Promise<unknown>]> = [
      [
        "CORS",
        () =>
          this.#client.send(
            new PutBucketCorsCommand({
              Bucket: this.#cfg.bucket,
              CORSConfiguration: {
                CORSRules: [
                  { AllowedMethods: ["POST"], AllowedOrigins: settings.corsOrigins, AllowedHeaders: ["*"], MaxAgeSeconds: 3000 },
                  { AllowedMethods: ["GET", "HEAD"], AllowedOrigins: ["*"], AllowedHeaders: ["*"], MaxAgeSeconds: 3000 },
                ],
              },
            }),
          ),
      ],
      [
        "lifecycle",
        () =>
          this.#client.send(
            new PutBucketLifecycleConfigurationCommand({
              Bucket: this.#cfg.bucket,
              LifecycleConfiguration: {
                Rules: [
                  {
                    ID: "expire-uploads",
                    Status: "Enabled",
                    Filter: { Prefix: "uploads/" },
                    Expiration: { Days: settings.retentionDays },
                  },
                ],
              },
            }),
          ),
      ],
    ];
    const failed: string[] = [];
    for (const [name, step] of steps) {
      try {
        await step();
      } catch (e) {
        failed.push(`${name} (${(e as Error).name})`);
      }
    }
    if (failed.length > 0) throw new Error(`the bucket refused ${failed.join(" and ")}`);
  }
}
