// Dựng chỉ dẫn cho Codex (spec §18).
//
// *** ĐIỂM QUAN TRỌNG NHẤT CỦA FILE NÀY ***
// Đầu vào MCP KHÔNG PHẢI là prompt gửi cho Codex. Worker mới là bên
// soạn chỉ dẫn; dữ liệu của người dùng chỉ được nhúng vào những ô đã
// định sẵn.
//
// Vì sao: Codex là một agent lập trình, không phải một hàm sinh ảnh.
// Chuyển thẳng chuỗi người dùng thành prompt là trao cho bên gọi khả
// năng sai khiến nó làm việc khác — đọc file, chạy lệnh, sửa mã nguồn.
// Khoá phạm vi lại là việc của worker. Spec §18 nói gọn: "Treat prompts
// as data."
//
// Đặc biệt: MỌI chỉ dẫn về hệ thống file đều do worker viết. Người dùng
// không bao giờ nêu được đường dẫn đầu ra.

import { createHash } from "node:crypto";
import type { ImageSpec } from "@tinyorbit/contracts";

/** Chỉ dẫn sinh ảnh mới. Trả về MỘT chuỗi, đi vào argv như một phần tử. */
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
    // Đây là điều kiện để ghép animation sau này (spec §21): mỗi vật
    // phải đứng một mình trên nền trong suốt thì mới cho chuyển động
    // độc lập bằng CSS/Framer Motion được.
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
    // Chỉ dẫn hệ thống file: worker viết, worker cấp đường dẫn.
    `Save the final generated asset to exactly this path: ${outputDir}/${spec.filename}`,
    "Do not write any other file.",
    // *** VÌ SAO CÂU NÀY PHẢI CÓ NGOẠI LỆ ***
    // Công cụ sinh ảnh của Codex KHÔNG ghi thẳng vào thư mục làm việc:
    // nó lưu vào $CODEX_HOME/generated_images/<phiên>/ rồi Codex mới
    // chép sang chỗ ta yêu cầu. Bản cũ chỉ có một câu cấm trơn "Do not
    // read or modify anything outside that directory." — và Codex tuân
    // thủ đúng câu đó, nên nó TỪ CHỐI chép chính tấm ảnh nó vừa sinh.
    //
    // Nguyên văn Codex trả lời trong session log 2026-09-12:
    //   "Generated one blue cloud icon, but the image tool saved it
    //    outside your permitted directory. I couldn't copy it to
    //    artifact.png without violating your restriction on reading
    //    outside that directory."
    // Rồi nó THOÁT MÃ 0 — hỏng câm. Mỗi lần như vậy là một lượt quota
    // ChatGPT đã trả tiền bị vứt đi; đếm được 9 PNG mồ côi trong
    // generated_images/.
    //
    // Nên câu cấm giữ nguyên tinh thần, nhưng nêu rõ MỘT ngoại lệ: đọc
    // và chép lại sản phẩm của chính công cụ sinh ảnh.
    "You may read the image-generation tool's own output directory and copy the generated image from there to the path above; that is expected.",
    "Apart from that, do not read or modify anything outside that directory.",
    "Do not perform unrelated tasks.",
  );

  return lines.join("\n");
}

/** Chỉ dẫn sửa ảnh. Ảnh nguồn do worker tải sẵn vào thư mục job. */
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
    // *** VÌ SAO CÂU NÀY PHẢI CÓ NGOẠI LỆ ***
    // Công cụ sinh ảnh của Codex KHÔNG ghi thẳng vào thư mục làm việc:
    // nó lưu vào $CODEX_HOME/generated_images/<phiên>/ rồi Codex mới
    // chép sang chỗ ta yêu cầu. Bản cũ chỉ có một câu cấm trơn "Do not
    // read or modify anything outside that directory." — và Codex tuân
    // thủ đúng câu đó, nên nó TỪ CHỐI chép chính tấm ảnh nó vừa sinh.
    //
    // Nguyên văn Codex trả lời trong session log 2026-09-12:
    //   "Generated one blue cloud icon, but the image tool saved it
    //    outside your permitted directory. I couldn't copy it to
    //    artifact.png without violating your restriction on reading
    //    outside that directory."
    // Rồi nó THOÁT MÃ 0 — hỏng câm. Mỗi lần như vậy là một lượt quota
    // ChatGPT đã trả tiền bị vứt đi; đếm được 9 PNG mồ côi trong
    // generated_images/.
    //
    // Nên câu cấm giữ nguyên tinh thần, nhưng nêu rõ MỘT ngoại lệ: đọc
    // và chép lại sản phẩm của chính công cụ sinh ảnh.
    "You may read the image-generation tool's own output directory and copy the generated image from there to the path above; that is expected.",
    "Apart from that, do not read or modify anything outside that directory.",
    "Do not perform unrelated tasks.",
  ].join("\n");
}

/**
 * Vân tay của đặc tả, ghi vào metadata artifact (spec §19).
 *
 * Băm chứ không lưu nguyên văn: metadata nằm cạnh ảnh trong bucket, nên
 * đặc tả nguyên văn ở đó là rò rỉ nội dung công việc. Bản băm vẫn đủ để
 * đối chiếu "hai ảnh này sinh từ cùng một đặc tả".
 */
export function specHash(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}
