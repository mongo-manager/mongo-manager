# syntax=docker/dockerfile:1
# Mongo Manager: non-root, read-only-friendly image (spec §3.5, S17, S19).

FROM node:26-alpine@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80 AS build
WORKDIR /src
RUN npm install --global pnpm@12.6.0
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:26-alpine@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80
# The runtime needs node only: package managers are attack surface (and scanner findings).
RUN apk add --no-cache tini mongodb-tools \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
      /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && addgroup -g 10001 mm \
 && adduser -D -H -u 10001 -G mm -s /sbin/nologin mm \
 && mkdir -p /data \
 && chown 10001:10001 /data \
 && chmod 700 /data
COPY --from=build /src/packages/cli/dist/cli.cjs /app/dist/cli.cjs
COPY --from=build /src/packages/cli/dist/shell-worker.cjs /app/dist/shell-worker.cjs
COPY --from=build /src/packages/cli/dist/THIRD-PARTY-NOTICES.txt /app/dist/THIRD-PARTY-NOTICES.txt
COPY --from=build /src/packages/cli/public /app/public
COPY --from=build /src/packages/cli/plugins /app/plugins
# The license and its additional terms (NOTICE, section 7) go with every copy.
COPY --from=build /src/LICENSE /src/NOTICE /app/
# W8: the image keeps no native module; MM_DISTRIBUTION says so, and the app shows that Kerberos and
# client-side encryption need the npm package instead.
ENV NODE_ENV=production MM_AUTH=1 MM_HOST=0.0.0.0 MM_DATA_DIR=/data MM_OPEN=0 MM_DISTRIBUTION=docker
USER 10001:10001
VOLUME /data
EXPOSE 4321
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${MM_WEB_PORT:-4321}${MM_BASE_PATH:-/}healthz" || exit 1
# The release build passes its version and commit; a local build says dev. Declared last, so a new
# version reuses every layer above.
ARG VERSION=dev
ARG REVISION=unknown
ARG CREATED=unknown
LABEL org.opencontainers.image.title="Mongo Manager" \
      org.opencontainers.image.description="Mongo Manager: a secure, offline-capable MongoDB manager in your browser." \
      org.opencontainers.image.source="https://github.com/mongo-manager/mongo-manager" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.version="$VERSION" \
      org.opencontainers.image.revision="$REVISION" \
      org.opencontainers.image.created="$CREATED"
# The updater (2026-11-03): the app knows its image, to say when a pull is needed or the image is old.
ENV MM_IMAGE_VERSION=$VERSION MM_IMAGE_CREATED=$CREATED
ENTRYPOINT ["/sbin/tini", "--", "node", "/app/dist/cli.cjs"]
CMD ["start"]
