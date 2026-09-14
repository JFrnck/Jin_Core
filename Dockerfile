# syntax=docker/dockerfile:1
FROM node:24.11.0-alpine AS base
RUN apk add --no-cache dumb-init
RUN corepack enable pnpm
WORKDIR /app

# builder: toolchain de compilación para los módulos nativos (argon2,
# better-sqlite3/sqlite-vec) + build de TypeScript. Se descarta entero
# después de `pnpm prune` — nunca llega a runtime.
FROM base AS builder
RUN apk add --no-cache python3 make g++
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build
RUN pnpm prune --prod

# runtime: sin toolchain de compilación, usuario no-root, dumb-init como
# PID 1 (Nest deja child processes huérfanos sin él).
FROM node:24.11.0-alpine AS runtime
RUN apk add --no-cache dumb-init
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json ./package.json
# Hallazgo real (Fase 9.5): sin esto, models.yaml/agent.yaml/budget.yaml/
# feature-flags.yaml/mcp-servers.yaml -- todos leídos por
# readFileSync(join(process.cwd(), 'config', ...)) en runtime -- nunca
# existieron en la imagen. jin-core habría fallado con ENOENT al primer
# arranque en un clúster real; nunca se detectó porque el job "docker"
# del CI solo publica la imagen, no la corre.
COPY --from=builder --chown=node:node /app/config ./config
USER node
EXPOSE 3000
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main"]
