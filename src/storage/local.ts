// Stores artifacts in a plain directory and serves them over the same HTTP
// port the MCP endpoint uses.
//
// *** WHY THIS EXISTS ***
// Object storage is the right answer for a split deployment, but it is a
// lot to stand up for one machine: a bucket, an anonymous-read policy on
// the projects/* prefix, credentials, and a public base URL that resolves
// from outside. With an empty S3_ENDPOINT the process writes into
// ARTIFACT_DIR instead and hands out /artifacts/<key> URLs served by
// src/index.ts, so `docker compose up` needs nothing else running.
//
// It is NOT a drop-in for a split deployment: the directory is local to one
// process, so a worker in another pod cannot write into the directory the
// MCP process serves. loadConfig() refuses that combination outright.

import { copyFile, mkdir, readFile, writeFile, access, constants } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { ImagegenError } from "../contracts/index.ts";
import type { ArtifactStore, UploadResult } from "./types.ts";

export interface LocalStorageConfig {
  dir: string;
  publicBaseUrl: string;
}

export class LocalArtifactStore implements ArtifactStore {
  #dir: string;
  #publicBaseUrl: string;

  constructor(cfg: LocalStorageConfig) {
    // Resolved once, at construction: every safety check below compares
    // against this absolute path, and a relative #dir would make those
    // comparisons depend on the process's current working directory.
    this.#dir = resolve(cfg.dir);
    this.#publicBaseUrl = cfg.publicBaseUrl.replace(/\/+$/, "");
  }

  /**
   * Turns a key into an absolute path, refusing anything that could land
   * outside the artifact directory.
   *
   * Keys are built from job data (projects/<project>/<asset>/v<n>/<file>).
   * Those pieces go through sanitizeIdentifier() upstream, but this store
   * must not DEPEND on that: it is the last thing between a key and the
   * filesystem, and a key that escapes here means writing or reading
   * arbitrary files as the service user. Three separate ways in, so all
   * three are checked:
   *   - an absolute key ("/etc/passwd") ignores the base directory,
   *   - a ".." segment walks up out of it,
   *   - and after resolution anything that is not under #dir is refused
   *     regardless of how it got there.
   */
  #pathFor(key: string): string {
    const bad = (): never => {
      // Same code the S3 store uses when it cannot put an object: to a
      // caller this is "the store refused to store it", and the key
      // itself never goes into the message — it would echo caller input
      // straight back out.
      throw new ImagegenError("STORAGE_UPLOAD_FAILED", "Rejected an unsafe artifact key");
    };

    if (key === "" || isAbsolute(key)) bad();
    // Split on both separators: on Windows "a\\..\\b" is a traversal too,
    // and posix path.isAbsolute would not see "C:\\" either.
    const segments = key.split(/[\\/]+/);
    if (segments.some((s) => s === "..")) bad();

    const full = resolve(this.#dir, key);
    if (full !== this.#dir && !full.startsWith(this.#dir + sep)) bad();
    return full;
  }

  /**
   * Readiness: the directory exists and we can write into it.
   *
   * Creates it when missing rather than reporting not-ready, because the
   * common case is a fresh volume mounted empty on first boot.
   */
  async isReachable(): Promise<boolean> {
    try {
      await mkdir(this.#dir, { recursive: true });
      await access(this.#dir, constants.W_OK);
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
    // mimeType is not used: a file on disk carries no metadata, and the
    // content type is decided by the /artifacts route from the extension.
    void mimeType;
    const started = Date.now();
    const target = this.#pathFor(key);

    // Read rather than stat+copy: the byte count has to match what the S3
    // store reports (body.byteLength), and reading is also the only way to
    // fail EXACTLY like it does when Codex left no file behind.
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
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, body);
    } catch {
      throw new ImagegenError("STORAGE_UPLOAD_FAILED", "Failed to write artifact to the artifact directory");
    }

    return {
      key,
      url: this.publicUrl(key),
      bytes: body.byteLength,
      durationMs: Date.now() - started,
    };
  }

  async uploadMetadata(key: string, metadata: unknown): Promise<void> {
    const target = this.#pathFor(key);
    try {
      await mkdir(dirname(target), { recursive: true });
      // Pretty-printed like the S3 store writes it: metadata.json sits
      // next to the image and gets read by a human far more often than by
      // a program.
      await writeFile(target, JSON.stringify(metadata, null, 2));
    } catch {
      throw new ImagegenError("STORAGE_UPLOAD_FAILED", "Failed to write metadata to the artifact directory");
    }
  }

  async download(key: string): Promise<Buffer> {
    const target = this.#pathFor(key);
    try {
      return await readFile(target);
    } catch {
      // JOB_NOT_FOUND, exactly as the S3 store reports a missing object.
      // edit_image branches on the code, so the two stores have to fail
      // identically or an edit against a deleted artifact would look like
      // a different class of problem depending on where it was deployed.
      throw new ImagegenError("JOB_NOT_FOUND", "Failed to read source artifact from the artifact directory");
    }
  }

  /**
   * Public URL returned to Claude.
   *
   * Served by the /artifacts route in src/index.ts off the same port as
   * /mcp, so PUBLIC_BASE_URL is the only thing that has to resolve from
   * outside the container.
   */
  publicUrl(key: string): string {
    return `${this.#publicBaseUrl}/artifacts/${key}`;
  }

  /**
   * Identical to publicUrl().
   *
   * There is nothing to sign against a plain directory: the route serves
   * whatever is in ARTIFACT_DIR to whoever can reach the port, and a token
   * this process minted and verified itself would not change that. Callers
   * use signedUrl() as an ALTERNATIVE URL for the same object, not as a
   * security boundary, so returning the plain URL is honest and keeps them
   * working; throwing here would break edit_image for no gain. Put an
   * authenticating proxy in front of the port if the images need to be
   * private.
   */
  async signedUrl(key: string): Promise<string> {
    return this.publicUrl(key);
  }
}
