// The contract every artifact store satisfies.
//
// *** WHY THIS INTERFACE EXISTS ***
// There are two stores: S3-compatible object storage (s3.ts) and a plain
// directory on disk (local.ts). The directory one is what makes a
// single-process deployment work with nothing else running: no bucket, no
// gateway, no credentials. Everything that consumes a store is typed
// against this interface so neither implementation can be reached for by
// name, and so a caller cannot start depending on an S3-only detail.

export interface UploadResult {
  key: string;
  url: string;
  bytes: number;
  durationMs: number;
}

/** A browser-style POST target: send `fields` first, then the file. */
export interface PresignedUpload {
  url: string;
  fields: Record<string, string>;
}

export interface UploadBucketSettings {
  corsOrigins: string[];
  retentionDays: number;
}

export interface ArtifactStore {
  /** Whether the store can be written to right now — used for the readiness probe. */
  isReachable(): Promise<boolean>;
  uploadArtifact(localPath: string, key: string, mimeType: string): Promise<UploadResult>;
  uploadMetadata(key: string, metadata: unknown): Promise<void>;
  /** Reads an artifact back — used by edit_image to fetch the source image. */
  download(key: string): Promise<Buffer>;
  /** The URL handed to the MCP client. */
  publicUrl(key: string): string;
  signedUrl(key: string): Promise<string>;
  /** Stores bytes already in memory: inline uploads. */
  putObject(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Size of an object, or null when there is none. */
  headObject(key: string): Promise<{ bytes: number } | null>;
  /** A POST target for exactly one key, capped at maxBytes. S3 only. */
  presignUpload(key: string, contentType: string, maxBytes: number, ttlSeconds: number): Promise<PresignedUpload>;
  /** CORS for the POST target and expiry of uploads/. A no-op where neither applies. */
  configureUploads(settings: UploadBucketSettings): Promise<void>;
}
