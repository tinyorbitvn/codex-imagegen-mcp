// Per-frame geometry for animate_image's motion presets.
//
// Pure math with no images, so the shape of every motion is tested on
// its own and the renderer only has to apply what it is given. Every
// curve is closed over t in [0, 1]: t = 1 lands exactly on t = 0, which
// is what makes the loop seamless.

import { ANIMATION_FPS } from "../contracts/index.ts";
import type { AnimationIntensity, AnimationMotion } from "../contracts/index.ts";

/** One frame. dx/dy are fractions of the source height; negative dy is up. */
export interface FrameTransform {
  angleDeg: number;
  scaleX: number;
  scaleY: number;
  dx: number;
  dy: number;
}

const AMPLITUDE: Record<Exclude<AnimationMotion, "spin">, Record<AnimationIntensity, number>> = {
  pulse: { low: 0.08, medium: 0.14, high: 0.2 },
  shake: { low: 6, medium: 10, high: 15 },
  bounce: { low: 0.08, medium: 0.14, high: 0.2 },
  float: { low: 0.03, medium: 0.05, high: 0.08 },
};

/** Fraction of the hop height below which the object squashes; full squash at the ground. */
const SQUASH_ZONE = 0.15;
const SQUASH_Y = 0.08;
const STRETCH_X = 0.06;

const MIN_FRAMES = 8;
const MAX_FRAMES = 96;
/** sharp rounds rotated sizes up, so the canvas keeps a few spare pixels. */
const CANVAS_MARGIN = 4;

const REST: FrameTransform = { angleDeg: 0, scaleX: 1, scaleY: 1, dx: 0, dy: 0 };

export function transformAt(
  motion: AnimationMotion,
  intensity: AnimationIntensity,
  t: number,
): FrameTransform {
  switch (motion) {
    case "spin":
      return { ...REST, angleDeg: 360 * t };
    case "pulse": {
      const s = 1 + (AMPLITUDE.pulse[intensity] * (1 - Math.cos(2 * Math.PI * t))) / 2;
      return { ...REST, scaleX: s, scaleY: s };
    }
    case "shake":
      // Three swings that die out, so the bell rests at 0° before it rings again.
      return {
        ...REST,
        angleDeg: AMPLITUDE.shake[intensity] * Math.sin(6 * Math.PI * t) * Math.exp(-3 * t),
      };
    case "bounce": {
      const h = Math.abs(Math.sin(Math.PI * t));
      const q = h < SQUASH_ZONE ? 1 - h / SQUASH_ZONE : 0;
      const scaleY = 1 - SQUASH_Y * q;
      return {
        angleDeg: 0,
        scaleX: 1 + STRETCH_X * q,
        scaleY,
        dx: 0,
        // Down by half the lost height keeps the base on the ground while squashed.
        dy: -AMPLITUDE.bounce[intensity] * h + (1 - scaleY) / 2,
      };
    }
    case "float":
      return { ...REST, dy: -AMPLITUDE.float[intensity] * Math.sin(2 * Math.PI * t) };
    default:
      throw new Error(`unknown motion: ${String(motion)}`);
  }
}

export function frameCount(durationMs: number): number {
  return Math.min(MAX_FRAMES, Math.max(MIN_FRAMES, Math.round((durationMs / 1000) * ANIMATION_FPS)));
}

export function frameTransforms(
  motion: AnimationMotion,
  intensity: AnimationIntensity,
  frames: number,
): FrameTransform[] {
  return Array.from({ length: frames }, (_, i) => transformAt(motion, intensity, i / frames));
}

/**
 * The smallest canvas that holds every frame drawn about its centre.
 * Derived from the transforms rather than per motion, so a spin gets its
 * diagonal and a float its travel without either being special-cased.
 */
export function canvasSize(
  width: number,
  height: number,
  frames: readonly FrameTransform[],
): { width: number; height: number } {
  let w = 0;
  let h = 0;
  for (const f of frames) {
    const sw = width * f.scaleX;
    const sh = height * f.scaleY;
    const a = (f.angleDeg * Math.PI) / 180;
    const cos = Math.abs(Math.cos(a));
    const sin = Math.abs(Math.sin(a));
    w = Math.max(w, sw * cos + sh * sin + 2 * Math.abs(f.dx * height));
    h = Math.max(h, sw * sin + sh * cos + 2 * Math.abs(f.dy * height));
  }
  return { width: Math.ceil(w) + CANVAS_MARGIN, height: Math.ceil(h) + CANVAS_MARGIN };
}
