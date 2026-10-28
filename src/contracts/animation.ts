// Motion presets for animate_image.
//
// Shared because the MCP role fills in defaults and clamps while the
// worker renders: both have to agree on the names and the bounds, and a
// drift would show up as a broken job rather than a compile error.

export const ANIMATION_MOTIONS = ["spin", "pulse", "shake", "bounce", "float"] as const;
export type AnimationMotion = (typeof ANIMATION_MOTIONS)[number];

export const ANIMATION_INTENSITIES = ["low", "medium", "high"] as const;
export type AnimationIntensity = (typeof ANIMATION_INTENSITIES)[number];

/** One loop per motion, picked so each reads naturally without tuning. */
export const DEFAULT_ANIMATION_DURATION_MS: Record<AnimationMotion, number> = {
  spin: 1200,
  pulse: 1000,
  shake: 800,
  bounce: 900,
  float: 2400,
};

export const MIN_ANIMATION_DURATION_MS = 400;
export const MAX_ANIMATION_DURATION_MS = 4000;
export const ANIMATION_FPS = 24;

/**
 * Clamps rather than rejects: a loop a little outside the range is still
 * a clear request, and the upper bound is what keeps render time and file
 * size in check (96 frames at 4000 ms).
 */
export function clampAnimationDuration(ms: number): number {
  return Math.min(MAX_ANIMATION_DURATION_MS, Math.max(MIN_ANIMATION_DURATION_MS, Math.round(ms)));
}

/** What the caller asked for, after defaults and clamping. */
export interface AnimationRequest {
  motion: AnimationMotion;
  intensity: AnimationIntensity;
  durationMs: number;
}

/** What was actually rendered, stored on the artifact. */
export interface AnimationInfo extends AnimationRequest {
  frames: number;
  fps: number;
  /** The GIF fallback that sits next to the main animated WebP. */
  gif: { key: string; url: string };
}
