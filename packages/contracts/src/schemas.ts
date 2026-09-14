// Hợp đồng MCP tool (spec §11).
//
// *** HƯỚNG ARTIFACT, KHÔNG PHẢI generate_image(prompt) ***
// Mỗi yêu cầu gắn với một artifact có danh tính (`project_id` +
// `asset_id`) chứ không phải một lời nhắc trôi nổi. Nhờ vậy mới có
// phiên bản, mới sửa lại được, và Claude mới tham chiếu lại được cùng
// một vật thể ở lượt sau.
//
// Dùng zod vì MCP SDK nhận zod shape và tự sinh JSON Schema cho
// tools/list — một nguồn sự thật, không viết schema hai lần rồi lệch.

import { z } from "zod";

export const ASPECT_RATIOS = ["1:1", "3:2", "2:3", "16:9", "9:16"] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

export const OUTPUT_FORMATS = ["png", "webp"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/**
 * Kích thước mặc định theo tỉ lệ.
 *
 * Bám quanh cạnh dài 1536 — kích thước mà mô hình ảnh của OpenAI sinh
 * gọn nhất. Đặt số lẻ lung tung thì ảnh bị scale lại và mất nét.
 */
export const DEFAULT_CANVAS: Record<AspectRatio, { width: number; height: number }> = {
  "1:1": { width: 1536, height: 1536 },
  "3:2": { width: 1536, height: 1024 },
  "2:3": { width: 1024, height: 1536 },
  "16:9": { width: 1536, height: 864 },
  "9:16": { width: 864, height: 1536 },
};

// Trần kích thước: chặn một yêu cầu 20000x20000 làm Codex chạy vô tận
// rồi đụng timeout, tốn quota mà không ra gì.
const dimension = z.number().int().min(256).max(4096);

export const createImageSchema = {
  project_id: z
    .string()
    .describe('Mã dự án, ví dụ "tinyorbit-cloud". Chỉ a-z, 0-9, "-", "_".'),
  asset_id: z
    .string()
    .describe('Mã artifact trong dự án, ví dụ "homepage-hero-vps".'),
  description: z.string().describe("Mô tả vật thể cần vẽ."),
  style: z
    .object({
      reference: z
        .string()
        .optional()
        .describe(
          'Tên style profile dùng lại, ví dụ "tinyorbit-cloud-v1". ' +
            "Ưu tiên dùng cái này thay vì chép cả đoạn mô tả phong cách " +
            "vào mỗi lần gọi — style profile là nguồn sự thật của bộ nhận diện.",
        ),
      prompt: z
        .string()
        .optional()
        .describe("Chỉ dẫn phong cách thêm, ghép SAU style profile."),
    })
    .optional(),
  canvas: z
    .object({
      aspect_ratio: z.enum(ASPECT_RATIOS).optional(),
      width: dimension.optional(),
      height: dimension.optional(),
    })
    .optional(),
  transparent_background: z
    .boolean()
    .optional()
    .describe(
      "true thì nền trong suốt (kênh alpha). Mặc định true vì artifact " +
        "web hầu như luôn cần ghép lên nền khác.",
    ),
  output_format: z.enum(OUTPUT_FORMATS).optional(),
  composition: z
    .object({
      isolated_object: z
        .boolean()
        .optional()
        .describe(
          "true thì CHỈ vẽ đúng một vật, không có vật nào khác trong khung. " +
            "Bắt buộc bật khi định cho các vật chuyển động độc lập trên web " +
            "— mỗi vật phải là một artifact riêng, xem mô tả của tool.",
        ),
      safe_padding_percent: z.number().int().min(0).max(40).optional(),
    })
    .optional(),
  wait: z
    .boolean()
    .optional()
    .describe(
      "Mặc định true: CHỜ tới khi ảnh xong rồi mới trả về, và báo tiến độ " +
        "dọc đường qua notifications/progress. Đặt false để trả job_id ngay " +
        "rồi tự hỏi get_image_job — chỉ nên dùng khi muốn chạy nhiều job song song.",
    ),
  timeout_seconds: z
    .number()
    .int()
    .min(10)
    .max(600)
    .optional()
    .describe(
      "Chỉ có tác dụng khi wait=true. Chờ tối đa bao lâu, mặc định 300. " +
        "Hết giờ KHÔNG phải lỗi và KHÔNG huỷ job: trả trạng thái hiện tại " +
        "kèm timed_out=true, gọi get_image_job(job_id) để theo tiếp.",
    ),
};

export const getImageJobSchema = {
  job_id: z.string().describe("job_id do create_image hoặc edit_image trả về."),
};

export const editImageSchema = {
  project_id: z.string(),
  asset_id: z.string(),
  source_version: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Phiên bản nguồn. Bỏ trống = phiên bản mới nhất."),
  instructions: z.string().describe("Thay đổi cần áp dụng."),
  transparent_background: z.boolean().optional(),
  wait: z
    .boolean()
    .optional()
    .describe(
      "Mặc định true: CHỜ tới khi ảnh xong rồi mới trả về, và báo tiến độ " +
        "dọc đường qua notifications/progress. Đặt false để trả job_id ngay " +
        "rồi tự hỏi get_image_job — chỉ nên dùng khi muốn chạy nhiều job song song.",
    ),
  timeout_seconds: z
    .number()
    .int()
    .min(10)
    .max(600)
    .optional()
    .describe(
      "Chỉ có tác dụng khi wait=true. Chờ tối đa bao lâu, mặc định 300. " +
        "Hết giờ KHÔNG phải lỗi và KHÔNG huỷ job: trả trạng thái hiện tại " +
        "kèm timed_out=true, gọi get_image_job(job_id) để theo tiếp.",
    ),
};

export const getArtifactSchema = {
  project_id: z.string(),
  asset_id: z.string(),
  version: z.number().int().min(1).optional().describe("Bỏ trống = bản mới nhất."),
};

export const cancelImageJobSchema = {
  job_id: z.string(),
};

/** Tên 5 tool mà Claude Design được thấy (spec §9, §30). */
export const PUBLIC_TOOLS = [
  "create_image",
  "edit_image",
  "get_image_job",
  "get_artifact",
  "cancel_image_job",
] as const;
export type PublicTool = (typeof PUBLIC_TOOLS)[number];
