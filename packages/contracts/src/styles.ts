// Style profile dùng lại (spec §20).
//
// *** VÌ SAO TÁCH KHỎI PROMPT ***
// Không tách thì mỗi lần gọi Claude phải chép lại nguyên đoạn mô tả
// phong cách. Hai hệ quả xấu: (1) chép sai một chữ là artifact lệch bộ
// nhận diện mà không ai nhận ra; (2) muốn đổi bảng màu thì phải sửa
// trong từng đoạn hội thoại đã có, tức là không đổi được.
//
// Có profile thì Claude chỉ gửi `style.reference: "tinyorbit-cloud-v1"`,
// còn nội dung phong cách là nguồn sự thật nằm ở đây, trong git.
//
// Thêm profile mới = thêm một mục vào STYLE_PROFILES. Sửa profile đang
// có sẽ ảnh hưởng tới MỌI artifact sinh ra SAU đó — artifact cũ giữ
// nguyên vì chúng bất biến, và metadata của chúng ghi lại tên profile
// đã dùng.

export interface StyleProfile {
  name: string;
  description: string;
  /** Đoạn văn nhúng vào prompt Codex. */
  prompt: string;
}

const TINYORBIT_CLOUD_V1: StyleProfile = {
  name: "tinyorbit-cloud-v1",
  description: "Bộ nhận diện 3D claymorphism của TinyOrbit Cloud",
  prompt: [
    "3D illustration",
    "claymorphism",
    "soft rounded edges",
    "matte clay / frosted-plastic surfaces",
    "no glossy metallic reflections",
    "",
    "palette:",
    "#000055",
    "#2E5BFF",
    "#CFE3FF",
    "#FFFFFF",
    "",
    "cyan accent:",
    "#46C3D8",
    "",
    "lighting:",
    "soft studio key from upper-left",
    "",
    "camera:",
    "front 3/4 view",
    "mild perspective",
    "",
    "web artifact:",
    "transparent background",
    "no ground shadow",
    "isolated subject",
    "12% minimum safe padding",
  ].join("\n"),
};

export const STYLE_PROFILES: Record<string, StyleProfile> = {
  [TINYORBIT_CLOUD_V1.name]: TINYORBIT_CLOUD_V1,
};

export function listStyleProfiles(): string[] {
  return Object.keys(STYLE_PROFILES);
}

/**
 * Ghép phần phong cách cuối cùng.
 *
 * Thứ tự CÓ Ý NGHĨA: profile trước, chỉ dẫn thêm của người gọi sau —
 * để một yêu cầu riêng lẻ tinh chỉnh được profile mà không phải bỏ hẳn
 * bộ nhận diện.
 *
 * Trả về chuỗi rỗng khi không có gì; bên gọi tự quyết bỏ qua mục này
 * trong prompt.
 */
export function resolveStyle(
  reference: string | undefined,
  extraPrompt: string | undefined,
): { prompt: string; reference: string | null } {
  const parts: string[] = [];
  let resolved: string | null = null;

  if (reference) {
    const profile = STYLE_PROFILES[reference];
    if (!profile) {
      throw new Error(
        `Không có style profile "${reference}". Hiện có: ${listStyleProfiles().join(", ")}`,
      );
    }
    parts.push(profile.prompt);
    resolved = profile.name;
  }

  if (extraPrompt) parts.push(extraPrompt);

  return { prompt: parts.join("\n\n"), reference: resolved };
}
