# syntax=docker/dockerfile:1

# ---------- Stage 1: build do client React ----------
FROM node:22-bookworm AS client
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
# Locale tests verify server error keys as well as interface strings.
COPY cmd/server/restaurant*.go /app/cmd/server/
RUN npm test && npm run build

# ---------- Stage 2: compila o codec MLow (libopus_mlow.so) ----------
FROM debian:bookworm AS opus
# TARGETARCH é injetado automaticamente pelo buildx (amd64 | arm64). Num `docker
# build` comum (sem buildx) ele vem vazio -> usamos `uname -m` como fallback.
ARG TARGETARCH
ARG OPUS_MLOW_REF=93e91a74c0a2af610d8313a85e2c811081a73f93
RUN apt-get update && apt-get install -y --no-install-recommends \
        git cmake ninja-build gcc g++ patchelf ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN git init opus_mlow \
    && cd opus_mlow \
    && git remote add origin https://github.com/edgardmessias/opus_mlow.git \
    && git fetch --depth 1 origin "$OPUS_MLOW_REF" \
    && git checkout --detach FETCH_HEAD
WORKDIR /build/opus_mlow
# PORTABILIDADE DO SIMD: o fork força "-mavx" nos fontes do MLow (smpl_*), sem
# detecção de CPU em runtime. Os smpl_*.c são C puro (zero intrínsecos), então
# ajustamos o flag por arquitetura:
#  - x86-64: baixamos p/ baseline SSE2. Sem isso a lib sai com AVX embutido e
#            QUEBRA (SIGILL/SIGSEGV) em CPUs/VPS sem AVX. Roda em qualquer x86-64.
#  - arm64 : "-mavx"/"-msse2" nem existem no gcc ARM; trocamos por "-O2" (NEON é
#            baseline no ARMv8, não precisa de flag) -> compila e roda nativo.
RUN if [ "$TARGETARCH" = "arm64" ] || [ "$(uname -m)" = "aarch64" ]; then \
        sed -i 's/COMPILE_FLAGS -mavx/COMPILE_FLAGS -O2/' CMakeLists.txt; \
    else \
        sed -i 's/COMPILE_FLAGS -mavx/COMPILE_FLAGS -msse2/' CMakeLists.txt; \
    fi
# As opções OPUS_X86_PRESUME_* só existem no ramo x86 do cmake do opus; em arm64
# são inofensivas (variáveis não usadas), então mantê-las não quebra o build.
RUN cmake -B build -G Ninja -DBUILD_SHARED_LIBS=ON -DCMAKE_BUILD_TYPE=Release \
        -DOPUS_BUILD_PROGRAMS=OFF -DOPUS_BUILD_TESTING=OFF \
        -DOPUS_X86_PRESUME_AVX=OFF -DOPUS_X86_PRESUME_AVX2=OFF \
    && cmake --build build \
    && cp "$(readlink -f build/libopus.so)" /opt/libopus_mlow.so \
    && patchelf --set-soname libopus_mlow.so /opt/libopus_mlow.so

# ---------- Stage 3: build do servidor Go (cgo + tag mlow) ----------
FROM golang:1.26.4-bookworm AS server
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev zip \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# empacota a extensão de passkey p/ download pelo painel (ver /astracalls-passkey.zip)
RUN cd /src && zip -r -q /astracalls-passkey.zip passkey-extension -x '*.DS_Store'
COPY --from=opus /opt/libopus_mlow.so /src/native/libopus_mlow.so
ENV CGO_ENABLED=1 \
    CC=gcc \
    CGO_LDFLAGS="-L/src/native -Wl,-rpath,/usr/local/lib"
RUN LD_LIBRARY_PATH=/src/native go test -tags mlow ./... \
    && go build -buildvcs=false -trimpath -tags mlow -o /wacalls ./cmd/server

# ---------- Stage 4: runtime enxuto ----------
FROM debian:bookworm-slim AS runtime
ARG VERSION=0.3.0
LABEL org.opencontainers.image.title="AstraCalls restaurant and WhatsApp calls" \
      org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.licenses="AGPL-3.0" \
      org.opencontainers.image.description="Restaurant ordering, table QR menus and WhatsApp calling with two-way voice translation"
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates ffmpeg curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 astracalls \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin astracalls \
    && mkdir -p /data/recordings \
    && chown -R 10001:10001 /data
COPY --from=opus /opt/libopus_mlow.so /usr/local/lib/libopus_mlow.so
RUN ldconfig
COPY --from=server /wacalls /usr/local/bin/wacalls
COPY --from=client /app/client/dist /app/client/dist
COPY --from=server /astracalls-passkey.zip /app/client/dist/astracalls-passkey.zip
COPY LICENSE LICENSE.WaCalls /usr/share/doc/astracalls/
WORKDIR /app
ENV WACALLS_RECORDING_DIR=/data/recordings
USER 10001:10001
EXPOSE 8080/tcp 50000/tcp 50000/udp
HEALTHCHECK --interval=15s --timeout=5s --start-period=75s --retries=3 \
    CMD curl --fail --silent --max-time 3 http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["wacalls"]
CMD ["-addr", ":8080", "-static", "/app/client/dist"]
