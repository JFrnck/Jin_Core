import { z } from 'zod';

// Única fuente de verdad de qué variables de entorno existen y su forma
// (AGENTS.md 8.4). Nada más en el repo debe leer `process.env` directo.
export const EnvSchema = z.object({
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
});

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
