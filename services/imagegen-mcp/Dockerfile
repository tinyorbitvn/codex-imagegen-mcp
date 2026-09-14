# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------------
# imagegen-mcp — MCP backend NỘI BỘ
# ---------------------------------------------------------------------
# Build TỪ GỐC REPO (monorepo npm workspaces):
#   docker build -f services/imagegen-mcp/Dockerfile \
#     -t crhub.tinyorbit.vn/platform/imagegen-mcp:0.2.0 .
#
# Image này KHÔNG có Codex và KHÔNG mount PVC codex-home: nó không được
# phép chạm tới credential ChatGPT (spec §10, §16).

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

# Chép manifest trước để lớp cache npm không vỡ mỗi lần sửa mã nguồn.
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/contracts/package.json        packages/contracts/
COPY packages/job-queue/package.json        packages/job-queue/
COPY packages/artifact-storage/package.json packages/artifact-storage/
COPY services/imagegen-mcp/package.json     services/imagegen-mcp/
RUN --mount=type=cache,target=/root/.npm \
    if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY packages packages
COPY services/imagegen-mcp services/imagegen-mcp

# Gói dùng chung phải build TRƯỚC: service import @tinyorbit/* qua
# `main: ./dist/index.js`, chưa build thì không có gì để import.
RUN npx tsc -p packages/contracts/tsconfig.json \
 && npx tsc -p packages/job-queue/tsconfig.json \
 && npx tsc -p packages/artifact-storage/tsconfig.json \
 && npx tsc -p services/imagegen-mcp/tsconfig.json

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



FROM ${BASE_REGISTRY}/node:22-bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 10001 app && useradd --uid 10001 --gid 10001 --create-home app

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
COPY --from=build /build/services/imagegen-mcp/dist ./dist
COPY --from=build /build/services/imagegen-mcp/package.json ./package.json

USER 10001:10001
ENV NODE_ENV=production PORT=8080
EXPOSE 8080

# KHÔNG khai OPENAI_API_KEY ở bất kỳ đâu (spec §15/§31).
CMD ["node", "dist/index.js"]
