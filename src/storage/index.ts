// Barrel for the artifact stores, plus the one place that decides which of
// them a process gets.

export * from "./types.ts";
export * from "./s3.ts";
export * from "./local.ts";

import type { Config } from "../config.ts";
import type { ArtifactStore } from "./types.ts";
import { ArtifactStorage } from "./s3.ts";
import { LocalArtifactStore } from "./local.ts";

/**
 * Builds the store the config selected.
 *
 * The choice is made ONCE, in loadConfig(), by looking at whether
 * S3_ENDPOINT is set; this function only carries it out. Nothing
 * downstream ever re-derives it, so there is exactly one answer to "where
 * do artifacts go" per process.
 *
 * The import of Config is type-only on purpose: config.ts imports
 * StorageConfig from this package, and a value import either way round
 * would make that a real cycle at runtime.
 */
export function createArtifactStore(cfg: Config["storage"]): ArtifactStore {
  if (cfg.kind === "s3") return new ArtifactStorage(cfg.s3);
  return new LocalArtifactStore({ dir: cfg.dir, publicBaseUrl: cfg.publicBaseUrl });
}
