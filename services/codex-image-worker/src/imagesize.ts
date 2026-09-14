// Đọc kích thước THẬT của ảnh từ header.
//
// *** VÌ SAO CẦN FILE NÀY ***
// Trước đây consumer ghi `width: spec.width` — tức chép lại YÊU CẦU chứ
// không đo sản phẩm. Đo trên job thật 2026-09-12: xin 1536x1536, ảnh
// Codex trả về là 1254x1254, mà metadata vẫn khai 1536x1536. Claude đọc
// metadata đó sẽ tin nhầm và bố cục sai.
//
// Chỉ đọc HEADER, không giải mã ảnh: rẻ, không phụ thuộc thư viện ngoài,
// và đủ để lấy kích thước cho cả hai định dạng ta hỗ trợ (png, webp).

import { open } from "node:fs/promises";

export interface ImageInfo {
  width: number;
  height: number;
  /**
   * File CÓ kênh alpha hay không.
   *
   * Lưu ý ranh giới: đây là "có kênh alpha", KHÔNG phải "có pixel trong
   * suốt". Muốn khẳng định vế sau thì phải giải nén toàn bộ ảnh rồi quét
   * từng pixel — đắt hơn nhiều mà giá trị thêm không đáng. Ảnh không có
   * kênh alpha thì chắc chắn KHÔNG trong suốt, nên cờ này đủ để bắt đúng
   * trường hợp hỏng: xin nền trong suốt mà nhận về ảnh đặc.
   */
  hasAlpha: boolean;
}

/** 32 bit big-endian. */
function be32(b: Buffer, off: number): number {
  return b.readUInt32BE(off);
}

function readPng(b: Buffer): ImageInfo | null {
  // 8 byte chữ ký, rồi chunk ĐẦU TIÊN bắt buộc là IHDR (chuẩn PNG §11.2.2):
  //   [8..11] độ dài, [12..15] "IHDR", [16..19] rộng, [20..23] cao,
  //   [24] độ sâu bit, [25] color type.
  if (b.length < 26) return null;
  if (b.toString("latin1", 12, 16) !== "IHDR") return null;
  const colorType = b[25]!;
  // color type 4 = xám + alpha, 6 = RGB + alpha. 3 là bảng màu — có thể
  // trong suốt qua chunk tRNS, nên phải dò thêm.
  let hasAlpha = colorType === 4 || colorType === 6;
  if (!hasAlpha && colorType === 3) hasAlpha = hasTrns(b);
  return { width: be32(b, 16), height: be32(b, 20), hasAlpha };
}

/** Dò chunk tRNS (bảng màu có ô trong suốt). Đi theo chuỗi chunk, không quét mù. */
function hasTrns(b: Buffer): boolean {
  let off = 8;
  while (off + 8 <= b.length) {
    const len = be32(b, off);
    const type = b.toString("latin1", off + 4, off + 8);
    if (type === "tRNS") return true;
    if (type === "IDAT" || type === "IEND") return false; // tRNS phải đứng trước IDAT
    off += 12 + len; // 4 độ dài + 4 kiểu + dữ liệu + 4 CRC
    if (len < 0 || off <= 0) return false; // độ dài rác -> dừng, đừng lặp vô tận
  }
  return false;
}

function readWebp(b: Buffer): ImageInfo | null {
  // RIFF container: [0..3]="RIFF", [8..11]="WEBP", [12..15] fourcc của
  // chunk đầu. Ba biến thể, mỗi biến thể một cách khai kích thước.
  if (b.length < 30) return null;
  const fourcc = b.toString("latin1", 12, 16);

  if (fourcc === "VP8X") {
    // Chunk mở rộng: [20] cờ, [24..26] rộng-1, [27..29] cao-1 (24 bit LE).
    const flags = b[20]!;
    return {
      width: b.readUIntLE(24, 3) + 1,
      height: b.readUIntLE(27, 3) + 1,
      hasAlpha: (flags & 0x10) !== 0, // bit ALPHA
    };
  }

  if (fourcc === "VP8L") {
    // Lossless: [20]=0x2f, rồi 32 bit LE chứa (rộng-1) 14 bit, (cao-1)
    // 14 bit, 1 bit alpha, 3 bit version.
    if (b[20] !== 0x2f) return null;
    const bits = b.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
      hasAlpha: ((bits >> 28) & 1) === 1,
    };
  }

  if (fourcc === "VP8 ") {
    // Lossy: khung key bắt đầu ở [23..25] = 9d 01 2a, rồi rộng/cao 16 bit
    // LE (14 bit thấp là kích thước, 2 bit cao là tỉ lệ thu phóng).
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return {
      width: b.readUInt16LE(26) & 0x3fff,
      height: b.readUInt16LE(28) & 0x3fff,
      hasAlpha: false, // VP8 trần không có alpha (phải bọc trong VP8X)
    };
  }

  return null;
}

/** Nhận diện theo NỘI DUNG, không theo đuôi file. */
export function parseImageHeader(b: Buffer): ImageInfo | null {
  if (b.length >= 8 && b.toString("latin1", 0, 8) === "\x89PNG\r\n\x1a\n") return readPng(b);
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
    return readWebp(b);
  }
  return null;
}

/**
 * Đọc kích thước ảnh từ đĩa. Trả null nếu không nhận dạng được — người
 * gọi tự quyết định lùi về đâu, hàm này KHÔNG đoán bừa.
 */
export async function readImageInfo(path: string): Promise<ImageInfo | null> {
  // 64KB đầu là thừa đủ: PNG khai kích thước ở byte 16, WebP ở byte 24;
  // phần dư chỉ để dò chunk tRNS của ảnh bảng màu.
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(65536);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return parseImageHeader(buf.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}
