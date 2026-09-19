# ---------------------------------------------------------------------------
# Web Automation Macro Platform
# Base image: official Playwright image -> ships Chromium + every system lib
# Chromium needs. A plain node:* image WILL fail at browser launch.
# ---------------------------------------------------------------------------
FROM mcr.microsoft.com/playwright:v1.47.2-jammy

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PORT=3000 \
    HOST=0.0.0.0

WORKDIR /app

# Install deps first (layer caching). Browsers are already in the base image.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

# Railway injects $PORT at runtime; the server binds 0.0.0.0:$PORT.
EXPOSE 3000

CMD ["node", "server/index.js"]
