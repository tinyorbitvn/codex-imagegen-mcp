// Builds the instructions handed to Codex.
//
// *** THE MOST IMPORTANT POINT IN THIS FILE ***
// The MCP input is NOT the prompt sent to Codex. The worker is the party
// that writes the instructions; user data is only ever embedded into
// slots that are already predefined.
//
// Why: Codex is a coding agent, not an image-generation function. Passing
// the user's string straight through as the prompt would hand the caller
// the ability to make it do something else entirely — read files, run
// commands, modify source code. Locking down the scope is the worker's
// job: treat prompts as data, never as instructions.
//
// In particular: EVERY instruction about the filesystem is written by the
// worker. The user can never specify the output path.

import { createHash } from "node:crypto";
import type { ImageSpec } from "@tinyorbit/contracts";

/** Instructions for generating a new image. Returns ONE string, passed into argv as a single element. */
export function buildCreatePrompt(spec: ImageSpec, outputDir: string): string {
  const lines: string[] = [
    "Generate exactly one image artifact according to this specification.",
    "",
    "Use the built-in image-generation capability.",
    "",
    "Asset ID:",
    spec.assetId,
    "",
    "Purpose:",
    "Website design artifact.",
    "",
    "Description:",
    spec.description,
  ];

  if (spec.stylePrompt) {
    lines.push("", "Style:", spec.stylePrompt);
  }

  lines.push(
    "",
    "Canvas:",
    `${spec.width} x ${spec.height}`,
    "Aspect ratio:",
    spec.aspectRatio,
    "",
    "Requirements:",
  );

  if (spec.transparentBackground) {
    lines.push("- transparent background (alpha channel), no ground shadow");
  } else {
    lines.push("- opaque background");
  }
  if (spec.isolatedObject) {
    // This is a precondition for compositing animation later: each object
    // must stand alone on a transparent background for it to be animated
    // independently with CSS/Framer Motion.
    lines.push(
      "- isolated object: render ONLY the requested subject",
      "- no neighboring objects, no background scene, no props",
    );
  }
  lines.push(
    "- subject completely inside canvas",
    `- keep at least ${spec.safePaddingPercent}% safe padding on every side`,
    "- no text unless explicitly requested",
    "",
    // Filesystem instruction: written by the worker, path supplied by the worker.
    `Save the final generated asset to exactly this path: ${outputDir}/${spec.filename}`,
    "Do not write any other file.",
    // *** WHY THIS SENTENCE NEEDS AN EXCEPTION ***
    // Codex's image-generation tool does NOT write directly into the
    // working directory: it saves into $CODEX_HOME/generated_images/<session>/
    // and only then does Codex copy it to the path we requested. The old
    // version had only a bare prohibition, "Do not read or modify
    // anything outside that directory." — and Codex obeyed it to the
    // letter, so it REFUSED to copy the very image it had just generated.
    //
    // Codex's verbatim reply from the session log on 2026-09-12:
    //   "Generated one blue cloud icon, but the image tool saved it
    //    outside your permitted directory. I couldn't copy it to
    //    artifact.png without violating your restriction on reading
    //    outside that directory."
    // Then it EXITED CODE 0 — a silent failure. Every time this happens,
    // one already-paid-for unit of ChatGPT quota gets thrown away; we
    // counted 9 orphaned PNGs in generated_images/.
    //
    // So the prohibition keeps its original intent, but now spells out
    // ONE exception: reading and copying back the image-generation tool's
    // own output.
    "You may read the image-generation tool's own output directory and copy the generated image from there to the path above; that is expected.",
    "Apart from that, do not read or modify anything outside that directory.",
    "Do not perform unrelated tasks.",
  );

  return lines.join("\n");
}

/** Instructions for editing an image. The source image was already downloaded by the worker into the job directory. */
export function buildEditPrompt(
  spec: ImageSpec,
  instructions: string,
  sourceFilename: string,
  outputDir: string,
): string {
  return [
    "Edit an existing image artifact using the built-in image-generation capability.",
    "",
    `Source image file: ${outputDir}/${sourceFilename}`,
    "",
    "Asset ID:",
    spec.assetId,
    "",
    "Edit instructions:",
    instructions,
    "",
    "Requirements:",
    "- apply only the requested change",
    "- preserve the original canvas dimensions",
    "- keep the subject completely inside the canvas",
    ...(spec.transparentBackground
      ? ["- keep the background fully transparent (alpha channel), no ground shadow"]
      : []),
    "",
    `Save the edited artifact to exactly this path: ${outputDir}/${spec.filename}`,
    "Do not overwrite the source image.",
    "Do not write any other file.",
    // *** WHY THIS SENTENCE NEEDS AN EXCEPTION ***
    // Codex's image-generation tool does NOT write directly into the
    // working directory: it saves into $CODEX_HOME/generated_images/<session>/
    // and only then does Codex copy it to the path we requested. The old
    // version had only a bare prohibition, "Do not read or modify
    // anything outside that directory." — and Codex obeyed it to the
    // letter, so it REFUSED to copy the very image it had just generated.
    //
    // Codex's verbatim reply from the session log on 2026-09-12:
    //   "Generated one blue cloud icon, but the image tool saved it
    //    outside your permitted directory. I couldn't copy it to
    //    artifact.png without violating your restriction on reading
    //    outside that directory."
    // Then it EXITED CODE 0 — a silent failure. Every time this happens,
    // one already-paid-for unit of ChatGPT quota gets thrown away; we
    // counted 9 orphaned PNGs in generated_images/.
    //
    // So the prohibition keeps its original intent, but now spells out
    // ONE exception: reading and copying back the image-generation tool's
    // own output.
    "You may read the image-generation tool's own output directory and copy the generated image from there to the path above; that is expected.",
    "Apart from that, do not read or modify anything outside that directory.",
    "Do not perform unrelated tasks.",
  ].join("\n");
}

/**
 * Fingerprint of the spec, written into the artifact's metadata.
 *
 * Hashed rather than stored verbatim: the metadata sits right next to the
 * image in the bucket, so the raw spec there would leak the content of
 * the work. The hash is still enough to confirm "these two images came
 * from the same spec".
 */
export function specHash(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}
