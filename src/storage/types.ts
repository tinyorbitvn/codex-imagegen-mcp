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
}
