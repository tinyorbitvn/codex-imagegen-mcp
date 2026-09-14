# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------------
# codex-image-worker — runs the Codex CLI and produces the images
# ---------------------------------------------------------------------
# Build from the REPOSITORY ROOT. This is an npm workspace and the service
# imports @tinyorbit/* out of packages/, so those have to be in the build
# context:
#
#   docker build -f services/codex-image-worker/Dockerfile -t codex-image-worker:dev .
#
# The image contains NO credentials. The ChatGPT session lives on a volume
# mounted at CODEX_HOME and is created by signing in once, by hand.
# See docs/codex-authentication.md.

# Optional mirror for the base image, e.g. a pull-through cache on your own
# network. Defaults to Docker Hub so a fresh clone builds anywhere:
#   docker build --build-arg BASE_REGISTRY=my-mirror.example.com/library ...
ARG BASE_REGISTRY=docker.io/library
FROM ${BASE_REGISTRY}/node:22-bookworm-slim AS build
WORKDIR /build

# Manifests first, so editing source does not invalidate the dependency
# layer.
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/contracts/package.json          packages/contracts/
COPY packages/job-queue/package.json          packages/job-queue/
COPY packages/artifact-storage/package.json   packages/artifact-storage/
COPY services/codex-image-worker/package.json services/codex-image-worker/
RUN --mount=type=cache,target=/root/.npm \
    if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY packages packages
COPY services/codex-image-worker services/codex-image-worker

# The shared packages must be built FIRST: the service resolves them through
# `main: ./dist/index.js`, so there is nothing to import until they exist.
RUN npx tsc -p packages/contracts/tsconfig.json \
 && npx tsc -p packages/job-queue/tsconfig.json \
 && npx tsc -p packages/artifact-storage/tsconfig.json \
 && npx tsc -p services/codex-image-worker/tsconfig.json

RUN --mount=type=cache,target=/root/.npm npm prune --omit=dev


# --- Codex CLI --------------------------------------------------------
# PIN AN EXACT VERSION. The worker builds a fixed command line
# (`exec --skip-git-repo-check`), and Codex renames flags often enough that
# following `latest` would one day break every job at once. When bumping,
# re-check `codex --version` and those flags first.
#
# Do not go backwards either: measured 2026-09-11, Codex 0.48.0 was refused
# by the backend for EVERY model, including invented names, with
#   400 {"detail":"The '<model>' model is not supported when using Codex
#   with a ChatGPT account."}
# on an active Plus account. Old clients stop being served for the ChatGPT
# session auth flow.
#
# Since 0.154.0 the platform binaries live in optionalDependencies instead
# of a bundled `vendor/` directory, so npm installs exactly one of them and
# there is nothing to prune.
FROM ${BASE_REGISTRY}/node:22-bookworm-slim AS codex
ARG CODEX_VERSION=0.154.0
RUN npm install -g "@openai/codex@${CODEX_VERSION}" && npm cache clean --force


FROM ${BASE_REGISTRY}/node:22-bookworm-slim AS runtime

# ca-certificates: Codex calls OpenAI over HTTPS. Without these the
#   handshake fails with the unhelpful "unable to get local issuer
#   certificate".
# git: some Codex code paths assume it exists. We pass --skip-git-repo-check
#   so it is not strictly required, but having it avoids an error branch.
#
# Do NOT add Python here. Tried on 2026-09-12, on the theory that a bug
# where the image was generated but never landed in the expected place came
# from Codex self-checking with `python -c "from PIL import Image ..."`
# against an image that genuinely has no Python. Installed python3,
# python3-pil and python-is-python3, rebuilt, reran a real job: broke in
# exactly the same way. The cause was in the prompt the worker builds, not
# in this image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

COPY --from=codex /usr/local/lib/node_modules /usr/local/lib/node_modules
# `npm install -g` puts a symlink in /usr/local/bin that the COPY above does
# not bring along, so `codex` would not be on PATH without this.
RUN ln -sf /usr/local/lib/node_modules/@openai/codex/bin/codex.js /usr/local/bin/codex \
 && chmod +x /usr/local/lib/node_modules/@openai/codex/bin/codex.js 2>/dev/null || true

# UID 10001 matches the chart's securityContext (runAsUser/fsGroup), so
# files written to the Codex volume keep the right owner across restarts.
RUN groupadd --gid 10001 codex \
 && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/codex codex

WORKDIR /app
# node_modules carries the workspace symlinks @tinyorbit/* -> ../../packages/*,
# which is why packages/ is copied to the same relative place.
COPY --from=build /build/node_modules ./node_modules
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

# No OPENAI_API_KEY here, on purpose. Even if the container is given one,
# runner.ts builds the Codex process's environment from an allowlist and
# never forwards it: the point is to spend the subscription, not the API.
CMD ["node", "dist/index.js"]
