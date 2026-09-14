# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------------
# codex-image-worker — chạy Codex, sinh ảnh
# ---------------------------------------------------------------------
# Build TỪ GỐC REPO (monorepo npm workspaces):
#   docker build -f services/codex-image-worker/Dockerfile \
#     -t crhub.tinyorbit.vn/platform/codex-image-worker:0.2.0 .
#
# Image KHÔNG chứa credential nào. Phiên đăng nhập ChatGPT sống trên PVC
# codex-home, nạp tay một lần (docs/mcp/codex-authentication.md).

# *** VÌ SAO KÉO BASE QUA GƯƠNG NỘI BỘ ***
# `dockerhub-registry.tinyorbit.vn` là repo proxy Docker Hub của Nexus.
# Kéo base qua đó thì layer của base NẰM SẴN phía server, nên lúc push
# image của mình registry bỏ qua chúng ("Layer already exists") và chỉ tải
# phần của ta.
#
# Khác với Artifact Keeper (phơi proxy theo TIỀN TỐ PATH, dạng
# crhub.tinyorbit.vn/dockerhub/...), Nexus phơi mỗi Docker repo như một
# registry RIÊNG trên connector riêng — nên đường dẫn là
# dockerhub-registry.tinyorbit.vn/library/... (đổi 2026-09-11).
#
# Quan trọng vì registry này 503 "request timed out" với blob lớn: ba
# layer nặng nhất (154MB, 102MB, 85MB) đều là của chính base image
# node:22-bookworm-slim, không phải mã của mình. Đẩy qua proxy là bỏ hẳn
# được chúng khỏi đường truyền. (Đo 2026-09-11.)
# Registry của ảnh nền. Mặc định Docker Hub để CI công khai (GitHub Actions)
# build được mà không phải đi qua hạ tầng nội bộ. Build trong mạng TinyOrbit thì
# truyền proxy Nexus vào cho nhanh và khỏi đụng rate limit của Docker Hub:
#   docker build --build-arg BASE_REGISTRY=dockerhub-registry.tinyorbit.vn/library ...
ARG BASE_REGISTRY=docker.io/library
FROM ${BASE_REGISTRY}/node:22-bookworm-slim AS build
WORKDIR /build

COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/contracts/package.json          packages/contracts/
COPY packages/job-queue/package.json          packages/job-queue/
COPY packages/artifact-storage/package.json   packages/artifact-storage/
COPY services/codex-image-worker/package.json services/codex-image-worker/
RUN --mount=type=cache,target=/root/.npm \
    if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY packages packages
COPY services/codex-image-worker services/codex-image-worker

RUN npx tsc -p packages/contracts/tsconfig.json \
 && npx tsc -p packages/job-queue/tsconfig.json \
 && npx tsc -p packages/artifact-storage/tsconfig.json \
 && npx tsc -p services/codex-image-worker/tsconfig.json

RUN --mount=type=cache,target=/root/.npm npm prune --omit=dev

# *** CHIA NHỎ node_modules THÀNH NHIỀU LAYER ***
# Registry Artifact Keeper trả 503 "request timed out" với blob lớn: layer
# node_modules gộp (~104MB) KHÔNG BAO GIỜ đẩy lên được, dù thử docker song
# song, manifest phẳng, lẫn crane tuần tự có retry (đo 2026-09-11).
#
# Cắt thành NUM_CHUNKS phần, mỗi phần một COPY nên thành một layer riêng,
# mỗi blob đủ nhỏ để chui lọt. Chia theo thuật toán LPT (xếp gói lớn
# trước vào bucket đang nhẹ nhất) để các phần đều nhau, thay vì round-robin
# dễ lệch khi một gói nặng gấp bội phần còn lại.
ARG NUM_CHUNKS=8
RUN node -e "\
const fs=require('fs'),path=require('path'),cp=require('child_process');\
const N=Number(process.env.NUM_CHUNKS||8);\
const root='node_modules';\
const units=[];\
for(const e of fs.readdirSync(root)){\
  const p=path.join(root,e);\
  if(e.startsWith('@')&&fs.statSync(p).isDirectory()){\
    for(const s of fs.readdirSync(p)) units.push(path.join(p,s));\
  } else units.push(p);\
}\
const size=f=>Number(cp.execSync('du -sk '+JSON.stringify(f)).toString().split('\\t')[0]);\
const sized=units.map(u=>({u,s:size(u)})).sort((a,b)=>b.s-a.s);\
const buckets=Array.from({length:N},()=>({tot:0,items:[]}));\
for(const it of sized){buckets.sort((a,b)=>a.tot-b.tot);buckets[0].items.push(it.u);buckets[0].tot+=it.s;}\
buckets.forEach((b,i)=>{\
  for(const u of b.items){\
    const dst=path.join('/chunks',String(i),path.dirname(u.slice(root.length+1)));\
    fs.mkdirSync(dst,{recursive:true});\
    cp.execSync('cp -a '+JSON.stringify(u)+' '+JSON.stringify(dst)+'/');\
  }\
});\
for(let i=0;i<N;i++) fs.mkdirSync(path.join('/chunks',String(i)),{recursive:true});\
console.log('chunk sizes KB:',buckets.map(b=>b.tot).join(' '));"
# --- Stage cài Codex CLI rồi cắt nhỏ ------------------------------------
# Bản cài global của Codex nặng ~252MB, nhưng PHẦN LỚN là binary cho nền
# tảng ta không bao giờ chạy: Windows x64+arm64 (~79MB), macOS x64+arm64
# (~65MB), Linux arm64 (~37MB). Pod chạy linux/amd64 nên chỉ giữ
# vendor/x86_64-unknown-linux-musl (~44MB) và xoá phần còn lại.
#
# LỊCH SỬ: hồi Artifact Keeper, registry trả 503 "request timed out" với
# blob lớn nên nguyên khối 252MB KHÔNG BAO GIỜ đẩy lên được, phải lọc bớt
# rồi cắt layer. Hoá ra 503 đó KHÔNG phải lỗi registry mà là định tuyến
# bất đối xứng qua pfSense (docs/gateway-vip-gioi-han-upload.md, sửa
# 2026-09-11). Nay đẩy 724MB hết 9 giây. Việc cắt layer vẫn giữ vì nó
# giúp cache tốt, không còn vì bị ép.
#
# Từ 0.154.0 KHÔNG còn thư mục `vendor/`: binary nền tảng nằm ở
# optionalDependencies nên npm chỉ cài đúng một cái. Không còn gì để lọc,
# và image tụt 724MB -> 261MB. Nâng version thì kiểm lại `codex --version`
# cùng các cờ mà buildCodexArgv dùng (`exec`, `--skip-git-repo-check`) —
# đổi cờ là chỗ này hỏng ngay lúc chạy job đầu tiên.
FROM ${BASE_REGISTRY}/node:22-bookworm-slim AS codex
# *** 0.48.0 KHÔNG DÙNG ĐƯỢC VỚI TÀI KHOẢN ChatGPT NỮA ***
# Đo 2026-09-11, backend trả cho MỌI model (kể cả tên bịa đặt):
#   400 {"detail":"The '<model>' model is not supported when using Codex
#   with a ChatGPT account."}
# Thử gpt-5-codex, gpt-5, gpt-5.1, gpt-5.1-codex, codex-mini-latest,
# o4-mini và một chuỗi vô nghĩa — tất cả CÙNG một câu lỗi, nên đây không
# phải chuyện chọn sai tên model: backend đã ngừng phục vụ client cũ này
# cho luồng xác thực bằng phiên ChatGPT. Tài khoản vẫn Plus, subscription
# còn hạn, auth.json có OPENAI_API_KEY=null (đúng spec).
#
# *** CẤU TRÚC GÓI ĐÃ ĐỔI TỪ 0.48 -> 0.154 ***
# Bản cũ nhét mọi binary nền tảng vào `vendor/<target>`; bản mới đưa
# chúng ra `optionalDependencies` (@openai/codex-linux-x64, -darwin-arm64,
# ...) nên npm CHỈ cài đúng nền tảng đang chạy. Vòng lặp xoá `vendor/`
# ngày trước vì thế thành vô tác dụng — và nó có `if [ -d ... ]` nên sẽ
# im lặng không làm gì, đúng kiểu hỏng mà chú thích cũ đã cảnh báo. Bỏ
# hẳn, không cần thay bằng gì: npm đã không kéo binary thừa nữa.
# Lưu ý: gói nền tảng là `linux-x64` (glibc), khớp base bookworm-slim.
ARG CODEX_VERSION=0.154.0
RUN npm install -g "@openai/codex@${CODEX_VERSION}" && npm cache clean --force \
 && node -e "\
const fs=require('fs'),path=require('path'),cp=require('child_process');\
const N=6, root='/usr/local/lib/node_modules';\
const units=[];\
for(const e of fs.readdirSync(root)){const p=path.join(root,e);\
  if(e.startsWith('@')&&fs.statSync(p).isDirectory()){for(const s of fs.readdirSync(p))units.push(path.join(p,s));}\
  else units.push(p);}\
const size=f=>Number(cp.execSync('du -sk '+JSON.stringify(f)).toString().split('\\t')[0]);\
const sized=units.map(u=>({u,s:size(u)})).sort((a,b)=>b.s-a.s);\
const b=Array.from({length:N},()=>({tot:0,items:[]}));\
for(const it of sized){b.sort((x,y)=>x.tot-y.tot);b[0].items.push(it.u);b[0].tot+=it.s;}\
b.forEach((bk,i)=>{for(const u of bk.items){\
  const dst=path.join('/codexchunks',String(i),path.dirname(u.slice(root.length+1)));\
  fs.mkdirSync(dst,{recursive:true});cp.execSync('cp -a '+JSON.stringify(u)+' '+JSON.stringify(dst)+'/');}});\
for(let i=0;i<N;i++)fs.mkdirSync(path.join('/codexchunks',String(i)),{recursive:true});\
console.log('codex chunks KB:',b.map(x=>x.tot).join(' '));"




FROM ${BASE_REGISTRY}/node:22-bookworm-slim AS runtime

# ca-certificates: Codex gọi HTTPS ra OpenAI; thiếu là bắt tay TLS hỏng
#   với lỗi rất khó đoán ("unable to get local issuer certificate").
# git: một số đường xử lý nội bộ của Codex giả định có git. Ta đã truyền
#   --skip-git-repo-check nên không bắt buộc, nhưng có thì đỡ rẽ nhánh lỗi.
#
# KHÔNG thêm python ở đây. Đã thử 2026-09-12 vì tưởng lỗi "ảnh sinh xong
# mà không tới đúng chỗ" là do Codex tự kiểm bằng
# `python -c "from PIL import Image ..."` rồi trượt (image quả thật không
# có python). Cài python3 + python3-pil + python-is-python3, dựng lại
# image, chạy lại job thật: VẪN HỎNG Y HỆT. Nguyên nhân thật nằm ở
# prompt.ts, không ở image — xem chú thích tại buildCreatePrompt.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

# Codex CLI chính chủ của OpenAI (spec §17: dùng client chính thức,
# KHÔNG gọi thẳng endpoint riêng của chatgpt.com).
#
# GHIM ĐÚNG PHIÊN BẢN: worker dựng argv cố định
# (`exec --skip-git-repo-check`), mà Codex đổi cờ dòng lệnh khá thường
# xuyên. Thả trôi theo `latest` là một ngày đẹp trời mọi job fail vì cờ
# bị đổi tên.
#
# SỐ THẬT NẰM Ở STAGE `codex` PHÍA TRÊN (CODEX_VERSION=0.154.0) — đó mới
# là chỗ `npm install` đọc. ARG ở stage này từng ghi 0.48.0 và không ai
# đọc, nhưng 0.48.0 lại đúng là bản backend ĐÃ TỪ CHỐI, nên để lại là mời
# người sau sửa nhầm chỗ. Bỏ hẳn. Nâng phiên bản thì sửa ARG ở stage
# `codex` rồi chạy lại bộ test.
COPY --from=codex /codexchunks/0/ /usr/local/lib/node_modules/
COPY --from=codex /codexchunks/1/ /usr/local/lib/node_modules/
COPY --from=codex /codexchunks/2/ /usr/local/lib/node_modules/
COPY --from=codex /codexchunks/3/ /usr/local/lib/node_modules/
COPY --from=codex /codexchunks/4/ /usr/local/lib/node_modules/
COPY --from=codex /codexchunks/5/ /usr/local/lib/node_modules/
# npm cài global tạo symlink trong /usr/local/bin; COPY ở trên chỉ mang
# thư viện nên phải dựng lại link cho `codex` nằm trong PATH.
RUN ln -sf /usr/local/lib/node_modules/@openai/codex/bin/codex.js /usr/local/bin/codex \
 && chmod +x /usr/local/lib/node_modules/@openai/codex/bin/codex.js 2>/dev/null || true

# UID khớp securityContext trong Deployment (runAsUser/fsGroup 10001) để
# file trên PVC codex-home thuộc đúng chủ qua mọi lần restart.
RUN groupadd --gid 10001 codex \
 && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/codex codex

WORKDIR /app
COPY --from=build /chunks/0/ ./node_modules/
COPY --from=build /chunks/1/ ./node_modules/
COPY --from=build /chunks/2/ ./node_modules/
COPY --from=build /chunks/3/ ./node_modules/
COPY --from=build /chunks/4/ ./node_modules/
COPY --from=build /chunks/5/ ./node_modules/
COPY --from=build /chunks/6/ ./node_modules/
COPY --from=build /chunks/7/ ./node_modules/
COPY --from=build /build/packages ./packages
COPY --from=build /build/services/codex-image-worker/dist ./dist
COPY --from=build /build/services/codex-image-worker/package.json ./package.json

RUN mkdir -p /work/jobs /home/codex/.codex \
 && chown -R codex:codex /work /home/codex /app

USER 10001:10001
ENV NODE_ENV=production \
    CODEX_HOME=/home/codex/.codex \
    WORK_DIR=/work/jobs \
    PORT=8080
EXPOSE 8080

# KHÔNG khai OPENAI_API_KEY. Kể cả pod có biến đó, runner.ts cũng không
# chuyển xuống tiến trình Codex (danh sách cho phép).
CMD ["node", "dist/index.js"]
