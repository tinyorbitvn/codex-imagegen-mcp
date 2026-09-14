# TinyOrbit MCP — nền tảng sinh ảnh

Workspace npm chứa hai service chạy sau cổng MCP của TinyOrbit:

| Thư mục | Là gì |
|---|---|
| `services/imagegen-mcp/` | backend MCP, nhận lệnh từ client (Claude Design…) và xếp việc vào hàng đợi |
| `services/codex-image-worker/` | worker chạy Codex để sinh ảnh, đọc việc từ hàng đợi |
| `packages/contracts/` | hợp đồng dùng chung giữa hai service + style profile |
| `packages/job-queue/` | trừu tượng hàng đợi (Redis và bản in-memory để test) |
| `packages/artifact-storage/` | trừu tượng object storage (S3) |

Hai service khai `@tinyorbit/*` ở version `*`, tức lấy thẳng từ `packages/`. Vì vậy
**mọi lệnh build đều chạy từ gốc workspace này**, không phải trong thư mục service:
Dockerfile `COPY` cả `packages/`.

Tách khỏi repo GitOps `dc-fpt-argocd-platform` ngày 2026-09-14; chart và runbook triển khai
vẫn nằm bên đó (`custom-applications/tinyorbit-mcp/`, `docs/mcp/`).

## Phát triển

```bash
npm ci
npm run typecheck        # cả hai service
npm test                 # workspace nào có test thì chạy
```

## Ảnh container

Phát hành bằng GitHub Actions: đẩy tag `v*` là `.github/workflows/publish.yml` build và đẩy
**cả hai** ảnh lên GitHub Packages, dùng chung số phiên bản của tag.

```bash
git tag v0.3.0 && git push origin v0.3.0
# -> ghcr.io/tinyorbitvn/imagegen-mcp:0.3.0        (+ :latest)
# -> ghcr.io/tinyorbitvn/codex-image-worker:0.3.0  (+ :latest)
```

Package công khai nên kéo về không cần đăng nhập:

```bash
docker pull ghcr.io/tinyorbitvn/imagegen-mcp:latest
```

Build tại chỗ (context là gốc workspace):

```bash
docker build -f services/imagegen-mcp/Dockerfile -t imagegen-mcp:dev .
```

Trong mạng TinyOrbit thì trỏ ảnh nền qua proxy Nexus cho nhanh và tránh rate limit Docker Hub:

```bash
docker build --build-arg BASE_REGISTRY=dockerhub-registry.tinyorbit.vn/library \
  -f services/imagegen-mcp/Dockerfile -t imagegen-mcp:dev .
```
