import { z } from 'zod';

// Única fuente de verdad de qué variables de entorno existen y su forma
// (AGENTS.md 8.4). Nada más en el repo debe leer `process.env` directo.
//
// El objeto va separado del `.refine()` de abajo porque zod no deja hacer
// `.pick()` sobre un schema con refinements, y `MigrationEnvSchema` necesita
// justamente eso. Al estar en la misma variable, importar este módulo
// lanzaba — y como lo importa `validateEnv`, Core moría en el arranque.
const EnvObjectSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL es requerida (postgres://user:pass@host:port/db)'),
  // src/model-provider: requeridas, no opcionales (AGENTS.md 8.4
  // fail-fast) — todo modelo pasa por el ModelProvider (MODEL_ROUTING.md
  // §6.1), y este necesita ambas API keys para poder hacer failover
  // cross-vendor en cualquier profile.
  ANTHROPIC_API_KEY: z
    .string()
    .min(1, 'ANTHROPIC_API_KEY es requerida (API key de Anthropic)'),
  GEMINI_API_KEY: z
    .string()
    .min(1, 'GEMINI_API_KEY es requerida (API key de Google GenAI)'),
  // src/integrations/canvas: requeridas, no opcionales (AGENTS.md 8.4 fail-fast)
  CANVAS_BASE_URL: z
    .string()
    .url(
      'CANVAS_BASE_URL debe ser una URL válida (ej: https://canvas.instructure.com)',
    ),
  CANVAS_API_TOKEN: z
    .string()
    .min(1, 'CANVAS_API_TOKEN es requerida (Personal Access Token de Canvas)'),
  // src/telegram: requeridas, no opcionales (AGENTS.md 8.4 fail-fast)
  TELEGRAM_BOT_TOKEN: z
    .string()
    .min(1, 'TELEGRAM_BOT_TOKEN es requerida (Bot token de Telegram)'),
  TELEGRAM_OWNER_CHAT_ID: z.coerce
    .number()
    .int('TELEGRAM_OWNER_CHAT_ID debe ser un número entero'),
  TELEGRAM_WEBHOOK_URL: z.string().url().optional(),
  TELEGRAM_WEBHOOK_SECRET: z
    .string()
    .min(
      1,
      'TELEGRAM_WEBHOOK_SECRET es requerida (Secret token para el webhook)',
    ),
  // Puente Claude Code ↔ owner (ADR 0012). OPCIONALES a propósito: si faltan,
  // el puente queda apagado y el resto de Jin arranca igual. Hacerlas
  // requeridas dejaría el pod en CrashLoopBackOff por una función nueva que
  // ni siquiera es parte del núcleo — exactamente lo que pasó con
  // INFISICAL_SITE_URL en el primer despliegue real.
  TELEGRAM_RELAY_BOT_TOKEN: z.string().min(1).optional(),
  RELAY_TOKEN: z
    .string()
    .min(32, 'RELAY_TOKEN debe tener al menos 32 caracteres')
    .optional(),
  // src/integrations/google: requeridas, no opcionales (AGENTS.md 8.4 fail-fast)
  GOOGLE_CLIENT_ID: z
    .string()
    .min(1, 'GOOGLE_CLIENT_ID es requerida (Client ID de Google OAuth)'),
  GOOGLE_CLIENT_SECRET: z
    .string()
    .min(
      1,
      'GOOGLE_CLIENT_SECRET es requerida (Client Secret de Google OAuth)',
    ),
  GOOGLE_REDIRECT_URI: z
    .string()
    .url('GOOGLE_REDIRECT_URI debe ser una URL válida')
    .default('http://localhost:3000/google/oauth/callback'),
  GOOGLE_REFRESH_TOKEN: z
    .string()
    .min(
      1,
      'GOOGLE_REFRESH_TOKEN es requerida (Refresh Token de Google OAuth)',
    ),
  // src/memory: requerida, no opcional (AGENTS.md 8.4 fail-fast) —
  // única API de embeddings del repo (BLUEPRINT 3.3.1/6.4).
  OPENAI_API_KEY: z
    .string()
    .min(1, 'OPENAI_API_KEY es requerida (API key de OpenAI, para embeddings)'),
  // Ruta operacional con valor sensato por defecto (no un secreto),
  // mismo criterio que GOOGLE_REDIRECT_URI: en Kubernetes se sobreescribe
  // apuntando al PersistentVolume real cuando se despliegue jin-core.
  MEMORY_DB_PATH: z.string().min(1).default('./data/memory.db'),
  // src/executor-client: requerida, no opcional (AGENTS.md 8.4
  // fail-fast) — Fase 5.2, BLUEPRINT 4. URL interna del Executor (Service
  // de Kubernetes), no un secreto, pero sin default sensato: apunta a un
  // host distinto en cada entorno.
  EXECUTOR_BASE_URL: z
    .string()
    .url(
      'EXECUTOR_BASE_URL debe ser una URL válida (ej: http://jin-executor:3000)',
    ),
  // src/auth: requeridas, no opcionales (AGENTS.md 8.4 fail-fast) —
  // Fase 6.1, frontera de seguridad de la API expuesta a internet.
  OWNER_PASSWORD_HASH: z
    .string()
    .min(
      1,
      'OWNER_PASSWORD_HASH es requerida (hash Argon2id, generar con pnpm run hash-password)',
    ),
  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET debe tener al menos 32 caracteres'),
  // src/rate-limit: requerida, no opcional (AGENTS.md 8.4 fail-fast) —
  // Fase 6.1, misma instancia de Redis ya desplegada en Jin_Infra.
  REDIS_URL: z
    .string()
    .min(1, 'REDIS_URL es requerida (ej: redis://jin-redis:6379)'),
  // src/config/secrets-loader.ts (Fase 8.1, BLUEPRINT §11): ninguna de
  // estas 4 es un secreto — son la configuración de a qué proyecto/
  // environment de Infisical conectarse. `INFISICAL_CLIENT_ID`/
  // `INFISICAL_CLIENT_SECRET` (las credenciales de la identidad de
  // máquina) NO entran a este schema a propósito: `loadSecrets()` los
  // lee de `process.env` directo, antes de que Nest exista, porque son
  // el único secreto que sigue viviendo fuera de Infisical (problema de
  // bootstrap). Default `false`: en desarrollo local con `.env`, el
  // camino de siempre sigue intacto.
  INFISICAL_ENABLED: z.enum(['true', 'false']).default('false'),
  INFISICAL_SITE_URL: z
    .string()
    .url()
    .default('http://infisical.jin.svc.cluster.local:8080'),
  INFISICAL_PROJECT_ID: z.string().optional(),
  INFISICAL_ENVIRONMENT: z.string().min(1).default('prod'),
});

// Media configuración es peor que ninguna: con bot pero sin token de API,
// el puente escucha y nadie puede hablarle; con token pero sin bot, el CLI
// acepta mensajes que no llegan a ningún lado. Fail-fast al arrancar.
export const EnvSchema = EnvObjectSchema.refine(
  (env) =>
    (env.TELEGRAM_RELAY_BOT_TOKEN === undefined) ===
    (env.RELAY_TOKEN === undefined),
  {
    message:
      'El puente Claude↔owner necesita TELEGRAM_RELAY_BOT_TOKEN y RELAY_TOKEN juntas, o ninguna de las dos.',
    path: ['RELAY_TOKEN'],
  },
);

export type Env = z.infer<typeof EnvSchema>;

/**
 * Usado como `validate` de `ConfigModule.forRoot` — Nest lo llama al
 * arrancar con `process.env` crudo. Si falla, lanza y el proceso muere en
 * el startup con un mensaje claro (AGENTS.md 8.4), antes de que cualquier
 * módulo llegue a usar una variable ausente o mal formada.
 */
export function validateEnv(config: Record<string, unknown>): Env {
  const result = EnvSchema.safeParse(config);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Configuración de entorno inválida:\n${issues}`);
  }
  return result.data;
}

/**
 * Entorno mínimo del migrador (`src/db/migrate.ts`, `migrate-down.ts`):
 * solo `DATABASE_URL`. Desde la Fase 8.1 los secretos de API (Anthropic,
 * Google, JWT, ...) viven únicamente en Infisical y `loadSecrets()` los
 * inyecta en `main.ts` -- el Job de migración de Kubernetes no pasa por
 * ahí, así que exigirle `EnvSchema` completo lo haría fallar siempre.
 * Además el migrador nunca debe ser bloqueado (ni tener acceso) por
 * credenciales que no usa.
 */
export const MigrationEnvSchema = EnvObjectSchema.pick({ DATABASE_URL: true });

export type MigrationEnv = z.infer<typeof MigrationEnvSchema>;

export function validateMigrationEnv(
  config: Record<string, unknown>,
): MigrationEnv {
  const result = MigrationEnvSchema.safeParse(config);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Configuración de entorno inválida:\n${issues}`);
  }
  return result.data;
}
