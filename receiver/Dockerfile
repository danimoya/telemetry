# Node 24 on trixie: OpenSSL 3.5, so the connection to telemetry-heliosdb negotiates the
# X25519MLKEM768 post-quantum hybrid key exchange (Node 18/alpine had OpenSSL 3.0: X25519 only).
FROM node:24-trixie-slim

WORKDIR /app

RUN mkdir -p /run/telemetry

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js persisted-salt.js ./
COPY entrypoint.sh /usr/local/bin/receiver-entrypoint
RUN chmod 0755 /usr/local/bin/receiver-entrypoint

EXPOSE 4080
# Starts as root only to read the root-owned 0600 compose secret, then drops to `node` (uid 1000).
ENTRYPOINT ["receiver-entrypoint"]
CMD ["node", "server.js"]
