# telemetry-heliosdb: HeliosDB-Nano from the official GitHub release (the Linux binary needs
# glibc >= 2.39, hence trixie), TLS with the X25519MLKEM768 hybrid post-quantum key exchange,
# SCRAM-SHA-256 auth, AES-256-GCM encryption at rest, HTTP/MCP listener off.
FROM debian:trixie-slim
ARG NANO_VERSION=4.41.0
ARG NANO_SHA256=b774b0a78984e0c07cc550c278dd8d107de1a11db37e79d3d79e9f9f081d2eb0
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl openssl \
    && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    [ "$(dpkg --print-architecture)" = amd64 ] || { echo "NANO_SHA256 is pinned for x86_64" >&2; exit 1; }; \
    cd /tmp; \
    T="heliosdb-nano-v${NANO_VERSION}-x86_64-unknown-linux-gnu.tar.gz"; \
    curl -fsSLO "https://github.com/HeliosDatabase/HeliosDB-Nano/releases/download/v${NANO_VERSION}/$T"; \
    echo "${NANO_SHA256}  $T" | sha256sum -c -; \
    tar xzf "$T" heliosdb-nano; \
    install -m 0755 heliosdb-nano /usr/local/bin/heliosdb-nano; rm -rf /tmp/*
ENV NANO_VERSION=${NANO_VERSION}
RUN useradd -r -u 999 -m -d /home/heliosdb heliosdb && mkdir -p /data /tls /tls-pub \
    && chown heliosdb:heliosdb /data /tls /tls-pub && chmod 0700 /tls
COPY entrypoint.sh /usr/local/bin/nano-entrypoint
RUN chmod 0755 /usr/local/bin/nano-entrypoint
VOLUME ["/data", "/tls", "/tls-pub"]
EXPOSE 5432
# Starts as root only to read the root-owned 0600 secret, then drops to uid 999.
ENTRYPOINT ["nano-entrypoint"]
