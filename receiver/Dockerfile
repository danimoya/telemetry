FROM node:18-alpine

WORKDIR /app

RUN mkdir -p /run/telemetry

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./

# Generate an in-memory salt on first boot if no persisted file exists.
# Operators should mount /run/telemetry from a tmpfs/volume and run the
# weekly salt-rotate cron from the host (see ../salt-rotate.cron).
EXPOSE 4080
CMD ["node", "server.js"]
