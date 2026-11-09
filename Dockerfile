# ==============================================================================
# ShareDrop (sharedrop.sarthakml.in) — Production Multi-stage Container
# ==============================================================================
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies if needed
RUN apk add --no-cache libc6-compat

# Install dependencies with frozen lockfile
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ==============================================================================
# Runner Stage
# ==============================================================================
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    PUBLIC_URL=https://sharedrop.sarthakml.in

# Create non-root system user and group for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 sharedrop

# Copy installed production node_modules from builder
COPY --from=builder --chown=sharedrop:nodejs /app/node_modules ./node_modules

# Copy app code
COPY --chown=sharedrop:nodejs package.json ./
COPY --chown=sharedrop:nodejs bin/ ./bin
COPY --chown=sharedrop:nodejs src/ ./src
COPY --chown=sharedrop:nodejs public/ ./public

# Ensure upload directory exists and is writable by non-root user
RUN mkdir -p /tmp/sharedrop-uploads && chown -R sharedrop:nodejs /tmp/sharedrop-uploads && \
    chmod +x bin/sharedrop.js

USER sharedrop

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "src/server/index.js"]
