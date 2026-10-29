// Checks and cleans an image a client uploaded, before anything relies on it.
//
// The MCP role inspects at submit time so a bad file fails the tool call,
// not a Codex run that already spent quota. The worker normalises right
// before use: client photos carry EXIF rotation and metadata that Codex
// should neither misread nor see.

import sharp from "sharp";
import type { Metadata } from "sharp";
import {
  ImagegenError,
  MAX_INLINE_UPLOAD_BYTES,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_SIDE,
  MIN_UPLOAD_SIDE,
} from "./contracts/index.ts";

export type UploadFormat = "png" | "jpeg" | "webp";

export interface UploadInfo {
  format: UploadFormat;
  /** As displayed, after EXIF orientation. */
  width: number;
  height: number;
  hasAlpha: boolean;
  bytes: number;
}

// SVG is readable by sharp but refused: rasterising client-supplied SVG
// lets the client steer librsvg, and no tool needs vector input.
const FORMATS: readonly string[] = ["png", "jpeg", "webp"];
const MB = 1024 * 1024;
const DATA_URI = /^data:[^,]*;base64,/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function refuse(reason: string): never {
  throw new ImagegenError("UNSUPPORTED_FORMAT", `The uploaded file ${reason}`);
}

export async function inspectUpload(buf: Buffer): Promise<UploadInfo> {
  if (buf.byteLength === 0) refuse("is empty.");
  if (buf.byteLength > MAX_UPLOAD_BYTES) {
    refuse(`is ${(buf.byteLength / MB).toFixed(1)} MB; the limit is ${MAX_UPLOAD_BYTES / MB} MB.`);
  }

  const m: Metadata = await sharp(buf)
    .metadata()
    .catch(() => refuse("is not an image that can be read."));
  if (!m.format || !FORMATS.includes(m.format)) {
    refuse(`is ${m.format ?? "an unknown format"}; send PNG, JPEG or WebP.`);
  }
  if ((m.pages ?? 1) > 1) refuse("is animated; send a still image.");

  // Orientations 5-8 swap the axes: a phone photo stored landscape is shown portrait.
  const swapped = (m.orientation ?? 1) >= 5;
  const width = (swapped ? m.height : m.width) ?? 0;
  const height = (swapped ? m.width : m.height) ?? 0;
  if (Math.max(width, height) > MAX_UPLOAD_SIDE) {
    refuse(`is ${width}x${height}; the limit is ${MAX_UPLOAD_SIDE} px on either side.`);
  }
  if (Math.min(width, height) < MIN_UPLOAD_SIDE) {
    refuse(`is ${width}x${height}; it must be at least ${MIN_UPLOAD_SIDE} px on each side.`);
  }

  return {
    format: m.format as UploadFormat,
    width,
    height,
    hasAlpha: m.hasAlpha ?? false,
    bytes: buf.byteLength,
  };
}

/** Upright, metadata-free bytes in the format the job works in. */
export async function normaliseUpload(buf: Buffer, format: "png" | "webp"): Promise<Buffer> {
  // Inspected again here, not trusted from submit time: a POST target stays
  // writable for 15 minutes, so the bytes can change before the worker reads them.
  await inspectUpload(buf);
  // rotate() with no angle applies the EXIF orientation; sharp drops
  // metadata on output unless asked to keep it.
  return sharp(buf, { limitInputPixels: MAX_UPLOAD_SIDE * MAX_UPLOAD_SIDE })
    .rotate()
    .toFormat(format)
    .toBuffer();
}

export function decodeInlineUpload(data: string): Buffer {
  const raw = data.trim().replace(DATA_URI, "").replace(/\s+/g, "");
  if (!BASE64.test(raw)) refuse("is not valid base64.");
  const buf = Buffer.from(raw, "base64");
  if (buf.byteLength > MAX_INLINE_UPLOAD_BYTES) {
    refuse(
      `is ${Math.ceil(buf.byteLength / 1024)} KB inline; the inline limit is ` +
        `${MAX_INLINE_UPLOAD_BYTES / 1024} KB. Omit data_base64 to get a POST target for larger files.`,
    );
  }
  return buf;
}
