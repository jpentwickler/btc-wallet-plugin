FROM node:22-slim AS builder

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist/
COPY skill/ ./skill/

ENV NODE_ENV=production

# MCP HTTP transport on port 8080 (Railway assigns PORT)
EXPOSE 8080
CMD ["node", "dist/server.js"]
