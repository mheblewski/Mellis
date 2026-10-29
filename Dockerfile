# Mellis API + worker image (one image, two entrypoints chosen in deploy/docker-compose.yml).
# Multi-arch (amd64 + arm64): released to GHCR by .github/workflows/release-image.yml. TypeScript compiles once on the
# build machine's own platform (its output runs anywhere); only the runtime stage installs per target platform.

FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY apps/api apps/api
COPY apps/worker apps/worker
COPY modules modules
COPY shared shared
COPY infra infra
COPY scripts scripts
RUN npm run build

# Operator tooling (tsx + scripts), used only through `docker compose run --rm tools ...`.
FROM build AS tools
ENV NODE_ENV=production
USER node

FROM node:24-bookworm-slim AS runtime
ARG MELLIS_VERSION=""
ARG MELLIS_REVISION=""
LABEL org.opencontainers.image.title="Mellis server" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.source="https://github.com/mheblewski/Mellis" \
      org.opencontainers.image.version="${MELLIS_VERSION}" \
      org.opencontainers.image.revision="${MELLIS_REVISION}"
WORKDIR /app
# Read by GET /v1/app-config (server.version / server.revision).
ENV NODE_ENV=production MELLIS_VERSION=${MELLIS_VERSION} MELLIS_REVISION=${MELLIS_REVISION}
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist dist
# infra/db/migrate.ts resolves migrations relative to the working directory.
COPY infra/db/migrations infra/db/migrations
# The shipped knowledge base (licence-checked, knowledge/README.md): `mellis-admin knowledge-build` indexes /app/knowledge
# on the user's server (infra/db/knowledge-build.ts).
COPY knowledge knowledge
# The server kit of this release: the installer and `mellis update` copy these to /opt/mellis (compose file, Caddy,
# the `mellis` command itself), so the files always match the image they run.
COPY deploy/docker-compose.yml deploy/Caddyfile server-kit/
COPY scripts/install-server.sh server-kit/mellis
USER node
CMD ["node", "dist/apps/api/src/main.js"]
