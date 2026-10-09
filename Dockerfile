# syntax=docker/dockerfile:1
FROM node:22-bookworm AS client
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
COPY cmd/server/restaurant*.go /app/cmd/server/
RUN npm test && npm run build

FROM golang:1.26.4-bookworm AS server
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ENV CGO_ENABLED=0
RUN go test ./... && go build -buildvcs=false -trimpath -o /wacalls ./cmd/server

FROM debian:bookworm-slim AS runtime
ARG VERSION=0.4.0
LABEL org.opencontainers.image.title="Onlinu restaurant and ChatGPT ordering" \
      org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.licenses="AGPL-3.0"
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 astracalls \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin astracalls \
    && mkdir -p /data/recordings && chown -R 10001:10001 /data
COPY --from=server /wacalls /usr/local/bin/wacalls
COPY --from=client /app/client/dist /app/client/dist
COPY data/saudi-geography/ /app/data/saudi-geography/
COPY LICENSE LICENSE.WaCalls /usr/share/doc/astracalls/
WORKDIR /app
# Preserve existing volume location for restaurant image compatibility.
ENV WACALLS_MEDIA_DIR=/data/recordings
USER 10001:10001
EXPOSE 8080/tcp
HEALTHCHECK --interval=15s --timeout=5s --start-period=75s --retries=3 \
    CMD curl --fail --silent --max-time 3 http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["wacalls"]
CMD ["-addr", ":8080", "-static", "/app/client/dist"]
