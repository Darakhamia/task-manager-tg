FROM node:20-slim AS builder

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Production image ─────────────────────────────────────────────────────────
FROM node:20-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "dist/index.js"]
