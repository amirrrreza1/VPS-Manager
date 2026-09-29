# syntax=docker/dockerfile:1

# VPS Manager - self-hosted control panel
#
# Multi-stage so the runtime image carries no build toolchain and no npm cache.
# node:sqlite is built into Node 22+, which is why there are no native modules.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app

# git and docker-cli are REQUIRED at runtime:
#   - git drives the deploy pipeline (fetch / reset)
#   - docker-cli provides the `docker compose` plugin the pipeline calls
# The app itself never runs as root; it reaches docker through sudo (see
# deploy/vps-manager.sudoers).
RUN apk add --no-cache \
      git \
      docker-cli \
      docker-cli-compose \
      tini \
      ca-certificates \
 && addgroup -g 1001 -S vpm \
 && adduser  -u 1001 -S vpm -G vpm

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    VPM_ROOTS=/opt \
    VPM_DATA_DIR=/data

COPY --from=deps  --chown=vpm:vpm /app/node_modules ./node_modules
COPY --from=builder --chown=vpm:vpm /app/.next ./.next
COPY --from=builder --chown=vpm:vpm /app/package.json ./package.json
COPY --from=builder --chown=vpm:vpm /app/public ./public

# The app needs to READ and WRITE files under /opt, and to READ its own state.
# Bind-mount /opt and /data from the host so the container is not the source of
# truth for your projects.
RUN mkdir -p /data && chown vpm:vpm /data
VOLUME ["/data"]

USER vpm
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/login > /dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["npm", "run", "start"]
