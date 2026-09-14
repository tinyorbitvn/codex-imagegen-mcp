// Serves the images the local artifact store wrote, on the same port as
// /mcp.
//
// *** WHY THE PROCESS SERVES ITS OWN IMAGES ***
// With no object storage configured, LocalArtifactStore hands clients
// `${PUBLIC_BASE_URL}/artifacts/<key>` URLs. Something has to answer those
// or every generated image is a dead link, and the whole point of the
// single-process mode is that there is nothing else running to answer
// them. Mounted only when the store is local: with S3 configured, the
// bucket serves its own objects and this route would be a second, weaker
// way in.

import express from "express";
import type { Request, Response } from "express";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { log } from "./contracts/index.ts";

/**
 * Content type by extension.
 *
 * Deliberately a short allowlist rather than a mime database: this
 * directory only ever holds what the worker uploads, which is one image
 * plus metadata.json. Anything else is something unexpected and gets
 * application/octet-stream, so a browser downloads it instead of running
 * it.
 */
const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".json": "application/json",
};

export function mountArtifacts(app: express.Express, dir: string): void {
  const root = resolve(dir);

  app.get("/artifacts/*", async (req: Request, res: Response) => {
    // The key is everything after /artifacts/, slashes included:
    // projects/<project>/<asset>/v<n>/artifact.png. Express has already
    // percent-decoded it, so %2e%2e is a ".." by the time we see it and
    // the resolve() check below is what catches it.
    const key = req.params[0] ?? "";

    // 404, never 403 and never the resolved path: a traversal attempt gets
    // the same answer as a typo, so probing cannot map the filesystem, and
    // the reply carries nothing the caller did not already send.
    const notFound = () => {
      if (!res.headersSent) res.status(404).json({ error: "artifact not found" });
    };

    const full = resolve(root, key);
    if (key === "" || (full !== root && !full.startsWith(root + sep))) {
      log.warn("rejected an artifact path that escapes the artifact directory");
      notFound();
      return;
    }

    let size: number;
    try {
      const st = await stat(full);
      if (!st.isFile()) {
        notFound();
        return;
      }
      size = st.size;
    } catch {
      notFound();
      return;
    }

    res.type(CONTENT_TYPES[extname(full).toLowerCase()] ?? "application/octet-stream");
    res.setHeader("Content-Length", String(size));

    // Streamed, not read into memory: an image is around 1MB today, but
    // nothing enforces that and buffering every request would tie the
    // process's memory to how many people are looking at images.
    const stream = createReadStream(full);
    stream.on("error", () => {
      // The file vanished between stat() and open(). Headers are usually
      // already out by then, so there is nothing to say but hang up.
      notFound();
      res.destroy();
    });
    stream.pipe(res);
  });
}
