# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------------
# imagegen-mcp — the MCP endpoint
# ---------------------------------------------------------------------
# Build from the REPOSITORY ROOT. This is an npm workspace and the service
# imports @tinyorbit/* out of packages/, so those have to be in the build
# context:
#
#   docker build -f services/imagegen-mcp/Dockerfile -t imagegen-mcp:dev .
#
# This image has no Codex in it and never mounts the Codex volume. It parses
# MCP calls and puts jobs on a queue; it must not be able to reach the
# ChatGPT session at all.

# Optional mirror for the base image, e.g. a pull-through cache on your own
# network. Defaults to Docker Hub so a fresh clone builds anywhere:
#   docker build --build-arg BASE_REGISTRY=my-mirror.example.com/library ...
ARG BASE_REGISTRY=docker.io/library
FROM ${BASE_REGISTRY}/node:22-bookworm-slim AS build
WORKDIR /build

# Manifests first, so editing source does not invalidate the dependency
# layer.
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/contracts/package.json        packages/contracts/
COPY packages/job-queue/package.json        packages/job-queue/
COPY packages/artifact-storage/package.json packages/artifact-storage/
COPY services/imagegen-mcp/package.json     services/imagegen-mcp/
RUN --mount=type=cache,target=/root/.npm \
    if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY packages packages
COPY services/imagegen-mcp services/imagegen-mcp

# The shared packages must be built FIRST: the service resolves them through
# `main: ./dist/index.js`, so there is nothing to import until they exist.
RUN npx tsc -p packages/contracts/tsconfig.json \
 && npx tsc -p packages/job-queue/tsconfig.json \
 && npx tsc -p packages/artifact-storage/tsconfig.json \
 && npx tsc -p services/imagegen-mcp/tsconfig.json

RUN --mount=type=cache,target=/root/.npm npm prune --omit=dev


FROM ${BASE_REGISTRY}/node:22-bookworm-slim AS runtime
# ca-certificates: outbound HTTPS, including the OTLP exporter, fails with a
# confusing "unable to get local issuer certificate" without it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 10001 app && useradd --uid 10001 --gid 10001 --create-home app

WORKDIR /app
# node_modules carries the workspace symlinks @tinyorbit/* -> ../../packages/*,
# which is why packages/ is copied to the same relative place.
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/packages ./packages
COPY --from=build /build/services/imagegen-mcp/dist ./dist
COPY --from=build /build/services/imagegen-mcp/package.json ./package.json

USER 10001:10001
ENV NODE_ENV=production PORT=8080
EXPOSE 8080

# No OPENAI_API_KEY here, on purpose. This service never calls OpenAI.
CMD ["node", "dist/index.js"]
