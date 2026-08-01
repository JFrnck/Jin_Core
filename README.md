# Jin_Core

Orquestador NestJS de Jin: HITL, audit log, budget, security, memory, telegram, integraciones. Ver `../Jin_Docs/` para la documentación canónica (BLUEPRINT, AGENTS, WORKFLOW).

## Setup

```bash
nvm use                # Node 24 (.nvmrc)
pnpm install
cp .env.example .env   # ajusta DATABASE_URL
```

En desarrollo local necesitas un Postgres corriendo (`docker compose -f ../Jin_Infra/docker-compose.dev.yaml up`, o cualquier Postgres 16 accesible).

```bash
pnpm db:migrate        # aplica las migraciones de Drizzle
pnpm run start:dev      # hot reload
```

## Módulos implementados (Fase 2.2)

- `src/tools/registry.ts` — declaración estática del `hitlLevel` de cada tool (BLUEPRINT 9.3, ADR 0001). Único lugar donde se asigna un nivel; el LLM nunca lo decide en runtime.
- `src/hitl/` — clasificador HITL (`classifier.ts`), máquina de estados de `confirm`/`dual-confirm` (`dual-confirm.service.ts`, persistida en `pending_approvals`), y el barrido de timeouts (`timeout.service.ts`, BLUEPRINT 9.4).
- `src/audit/` — audit log inmutable con hash chain (`audit.service.ts`, `hash-chain.ts`) y su verificación diaria (`chain-verification.service.ts`). Ver ADR 0002 (`request_id` + `pending_approvals` separado del log insert-only).
- `src/db/` — schema de Drizzle + conexión (Postgres vía `pg`).
- `src/config/` — configuración validada con Zod (`@nestjs/config` + fail-fast al boot).

## Base de datos

```bash
pnpm db:generate        # genera una migración nueva a partir de src/db/schema.ts
pnpm db:migrate         # aplica migraciones pendientes
pnpm db:migrate:down    # revierte la última (usa el <tag>.down.sql hermano — drizzle-kit no genera rollbacks)
```

Cada migración generada necesita su `.down.sql` escrito a mano junto al `.sql` que genera drizzle-kit (AGENTS.md 1.2: toda migración con up y down).

## Tests

Tres niveles, AGENTS.md 6:

```bash
pnpm test              # unitarios — rápidos, sin Docker (src/**/*.spec.ts)
pnpm test:integration  # con Postgres real vía testcontainers (src/**/*.integration.spec.ts) — requiere Docker
pnpm test:e2e           # e2e del árbol completo de Nest (test/**/*.e2e-spec.ts)
pnpm test:cov           # cobertura de los unitarios
```

Los tests de integración levantan su propio contenedor Postgres (imagen pinneada, `postgres:16.14-alpine`) y aplican las migraciones reales antes de cada suite — no hay mocks de la base de datos (AGENTS.md 6.3).

## Contrato OpenAPI

```bash
pnpm generate:contract  # emite contracts/openapi.json — lo consumen Jin_Web/Jin_CLI
```
