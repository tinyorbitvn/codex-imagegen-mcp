// Reads the REAL dimensions of an image from its header.
//
// *** WHY THIS FILE EXISTS ***
// The consumer used to write `width: spec.width` — i.e. it echoed back
// the REQUEST instead of measuring the actual output. Measured on a real
// job 2026-09-12: we asked for 1536x1536, Codex returned 1254x1254, yet
// the metadata still claimed 1536x1536. Claude reads that metadata and
// builds a layout on the wrong assumption.
//
// Only reads the HEADER, doesn't decode the image: cheap, no external
// library dependency, and enough to get dimensions for both formats we
// support (png, webp).

import { open } from "node:fs/promises";

export interface ImageInfo {
  width: number;
  height: number;
  /**
   * Whether the file HAS an alpha channel.
   *
   * Mind the boundary: this means "has an alpha channel", NOT "has
   * transparent pixels". Confirming the latter would require decoding
   * the whole image and scanning every pixel — much more expensive for
   * little added value. An image with no alpha channel is guaranteed
   * NOT transparent, so this flag is enough to catch the case that
   * actually matters: asking for a transparent background and getting an
   * opaque image back.
   */
  hasAlpha: boolean;
}

/** 32-bit big-endian. */
function be32(b: Buffer, off: number): number {
  return b.readUInt32BE(off);
}

function readPng(b: Buffer): ImageInfo | null {
  // 8-byte signature, then the FIRST chunk must be IHDR (PNG spec §11.2.2):
  //   [8..11] length, [12..15] "IHDR", [16..19] width, [20..23] height,
  //   [24] bit depth, [25] color type.
  if (b.length < 26) return null;
  if (b.toString("latin1", 12, 16) !== "IHDR") return null;
  const colorType = b[25]!;
  // color type 4 = grayscale + alpha, 6 = RGB + alpha. 3 is palette —
  // it can still be transparent via a tRNS chunk, so probe further.
  let hasAlpha = colorType === 4 || colorType === 6;
  if (!hasAlpha && colorType === 3) hasAlpha = hasTrns(b);
  return { width: be32(b, 16), height: be32(b, 20), hasAlpha };
}

/** Look for a tRNS chunk (palette with a transparent entry). Walk the chunk chain, don't scan blindly. */
function hasTrns(b: Buffer): boolean {
  let off = 8;
  while (off + 8 <= b.length) {
    const len = be32(b, off);
    const type = b.toString("latin1", off + 4, off + 8);
    if (type === "tRNS") return true;
    if (type === "IDAT" || type === "IEND") return false; // tRNS must come before IDAT
    off += 12 + len; // 4 length + 4 type + data + 4 CRC
    if (len < 0 || off <= 0) return false; // garbage length -> bail, don't loop forever
  }
  return false;
}

function readWebp(b: Buffer): ImageInfo | null {
  // RIFF container: [0..3]="RIFF", [8..11]="WEBP", [12..15] the fourcc of
  // the first chunk. Three variants, each with its own way of encoding
  // dimensions.
  if (b.length < 30) return null;
  const fourcc = b.toString("latin1", 12, 16);

  if (fourcc === "VP8X") {
    // Extended chunk: [20] flags, [24..26] width-1, [27..29] height-1 (24-bit LE).
    const flags = b[20]!;
    return {
      width: b.readUIntLE(24, 3) + 1,
      height: b.readUIntLE(27, 3) + 1,
      hasAlpha: (flags & 0x10) !== 0, // ALPHA bit
    };
  }

  if (fourcc === "VP8L") {
    // Lossless: [20]=0x2f, then a 32-bit LE value packing (width-1) 14
    // bits, (height-1) 14 bits, 1 alpha bit, 3 version bits.
    if (b[20] !== 0x2f) return null;
    const bits = b.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
      hasAlpha: ((bits >> 28) & 1) === 1,
    };
  }

  if (fourcc === "VP8 ") {
    // Lossy: the key frame starts at [23..25] = 9d 01 2a, then
    // width/height as 16-bit LE (low 14 bits are the size, top 2 bits are
    // the scaling factor).
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return {
      width: b.readUInt16LE(26) & 0x3fff,
      height: b.readUInt16LE(28) & 0x3fff,
      hasAlpha: false, // bare VP8 has no alpha (must be wrapped in VP8X)
    };
  }

  return null;
}

/** Identify by CONTENT, not by file extension. */
export function parseImageHeader(b: Buffer): ImageInfo | null {
  if (b.length >= 8 && b.toString("latin1", 0, 8) === "\x89PNG\r\n\x1a\n") return readPng(b);
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
    return readWebp(b);
  }
  return null;
}

/**
 * Reads image dimensions from disk. Returns null when unrecognized —
 * the caller decides what to fall back to, this function does NOT guess.
 */
export async function readImageInfo(path: string): Promise<ImageInfo | null> {
  // The first 64KB is more than enough: PNG declares its size at byte 16,
  // WebP at byte 24; the rest is only there to find the tRNS chunk of a
  // palette image.
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(65536);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return parseImageHeader(buf.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}
