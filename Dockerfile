# syntax=docker/dockerfile:1
# Debian trixie (glibc 2.41), no Alpine (musl) ni bookworm: los binarios
# precompilados de sqlite-vec son glibc-only y los de better-sqlite3 13 exigen
# GLIBC_2.38 (bookworm trae 2.36). En Alpine, `loadExtension` falla con "Error loading shared
# library ...vec0.so.so: No such file or directory" (falta el loader glibc) y
# jin-core muere al instanciar MemoryStore -- verificado corriendo la imagen.
FROM node:24.11.0-trixie-slim AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends dumb-init \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable pnpm
WORKDIR /app

# builder: toolchain de compilación para los módulos nativos (argon2,
# better-sqlite3/sqlite-vec) + build de TypeScript. Se descarta entero
# después de `pnpm prune` — nunca llega a runtime.
FROM base AS builder
# `nest build` (tsc sobre ~130 archivos + specs) revienta el heap por defecto
# de Node (~2GB en un contenedor de 4GB) -- "JavaScript heap out of memory".
# Solo afecta a este stage; runtime no compila nada.
ENV NODE_OPTIONS=--max-old-space-size=4096
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build
RUN pnpm prune --prod

# runtime: sin toolchain de compilación, usuario no-root, dumb-init como
# PID 1 (Nest deja child processes huérfanos sin él).
FROM node:24.11.0-trixie-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends dumb-init \
 && rm -rf /var/lib/apt/lists/*
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
# Migraciones: `node dist/src/db/migrate.js` (Job de Jin_Infra) lee ./drizzle
# relativo al cwd. El migrador compilado ya estaba en dist/; faltaban los .sql.
COPY --from=builder --chown=node:node /app/drizzle ./drizzle
USER node
EXPOSE 3000
ENTRYPOINT ["dumb-init", "--"]
# `nest build` emite dist/src/main.js, no dist/main.js: tsconfig.json no fija
# rootDir y hay .ts en la raíz (drizzle.config.ts, vitest.config.ts, scripts/),
# así que el root común es ./ y la salida queda un nivel más abajo. Verificado
# sobre la imagen publicada del 2026-08-06 (STATUS_DEPLOY.md, Jin_Docs).
CMD ["node", "dist/src/main"]
