// Renders animate_image's output: the still, transformed frame by frame
// with sharp, encoded as an animated WebP plus a GIF fallback.
//
// No Codex here, so an animation spends no ChatGPT quota. The long side
// is capped at 512 px because file size and encode time grow with every
// frame: measured 2026-10-28 on 2 CPUs, 96 frames at 512 px take ~14 s,
// three quarters of it in the WebP encoder.

import sharp from "sharp";
import type { Sharp } from "sharp";
import { ANIMATION_FPS, ImagegenError } from "../contracts/index.ts";
import type { AnimationRequest } from "../contracts/index.ts";
import { canvasSize, frameCount, frameTransforms } from "./motion.ts";
import type { FrameTransform } from "./motion.ts";

export const MAX_ANIMATION_SIDE = 512;

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

export interface RenderedAnimation {
  webp: Buffer;
  gif: Buffer;
  width: number;
  height: number;
  frames: number;
  fps: number;
}

interface RawImage {
  data: Buffer;
  width: number;
  height: number;
}

export async function renderAnimation(
  source: Buffer,
  request: AnimationRequest,
): Promise<RenderedAnimation> {
  try {
    return await render(source, request);
  } catch (err) {
    // sharp's messages describe the image, never a credential, so they are
    // safe to hand back and far more useful than "check the logs".
    throw new ImagegenError(
      "IMAGE_GENERATION_FAILED",
      `Could not render the animation: ${(err as Error).message}`,
    );
  }
}

async function render(source: Buffer, request: AnimationRequest): Promise<RenderedAnimation> {
  const base = await toRaw(
    sharp(source)
      .ensureAlpha()
      .resize({
        width: MAX_ANIMATION_SIDE,
        height: MAX_ANIMATION_SIDE,
        fit: "inside",
        withoutEnlargement: true,
      }),
  );

  const frames = frameCount(request.durationMs);
  const transforms = frameTransforms(request.motion, request.intensity, frames);
  const canvas = canvasSize(base.width, base.height, transforms);
  const frameBytes = canvas.width * canvas.height * 4;

  // sharp encodes one tall strip as pages; filling it in place avoids
  // holding a second copy of every frame (~200 MB at 96 frames).
  const strip = Buffer.alloc(frameBytes * frames);
  await Promise.all(
    transforms.map(async (t, i) => {
      const frame = await renderFrame(base, t, canvas);
      frame.copy(strip, i * frameBytes);
    }),
  );

  const delay = new Array<number>(frames).fill(Math.round(1000 / ANIMATION_FPS));
  const pages = () =>
    sharp(strip, {
      raw: { width: canvas.width, height: canvas.height * frames, channels: 4, pageHeight: canvas.height },
    });
  const [webp, gif] = await Promise.all([
    pages().webp({ loop: 0, delay }).toBuffer(),
    pages().gif({ loop: 0, delay }).toBuffer(),
  ]);

  return { webp, gif, width: canvas.width, height: canvas.height, frames, fps: ANIMATION_FPS };
}

async function renderFrame(
  base: RawImage,
  t: FrameTransform,
  canvas: { width: number; height: number },
): Promise<Buffer> {
  let img = base;
  const w = Math.max(1, Math.round(base.width * t.scaleX));
  const h = Math.max(1, Math.round(base.height * t.scaleY));
  // Two passes, so the rotation always works on the already-scaled size.
  if (w !== base.width || h !== base.height) {
    img = await toRaw(sharp(img.data, { raw: rawOf(img) }).resize(w, h, { fit: "fill" }));
  }
  if (Math.abs(t.angleDeg % 360) > 1e-6) {
    img = await toRaw(sharp(img.data, { raw: rawOf(img) }).rotate(t.angleDeg, { background: TRANSPARENT }));
  }

  const left = Math.round(canvas.width / 2 + t.dx * base.height - img.width / 2);
  const top = Math.round(canvas.height / 2 + t.dy * base.height - img.height / 2);
  return sharp({
    create: { width: canvas.width, height: canvas.height, channels: 4, background: TRANSPARENT },
  })
    .composite([
      {
        input: img.data,
        raw: rawOf(img),
        left: clamp(left, 0, canvas.width - img.width),
        top: clamp(top, 0, canvas.height - img.height),
      },
    ])
    .raw()
    .toBuffer();
}

function rawOf(img: RawImage) {
  return { width: img.width, height: img.height, channels: 4 as const };
}

async function toRaw(pipeline: Sharp): Promise<RawImage> {
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
