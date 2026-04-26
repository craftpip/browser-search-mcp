FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    CHROME_PATH=/usr/bin/chromium \
    CHROME_USER_DATA_DIR=/data/chrome \
    CHROME_PROFILE_DIR=Default

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    xvfb \
    fluxbox \
    x11vnc \
    novnc \
    python3-websockify \
    ca-certificates \
    fonts-dejavu \
    fonts-liberation \
    fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY docker/entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh && mkdir -p /data/chrome

EXPOSE 5900 7900 3000

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "src/mcp-server.js"]
