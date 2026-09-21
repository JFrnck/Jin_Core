import { InfisicalSDK } from '@infisical/sdk';

// Único punto donde los secretos reales entran a `process.env`, y corre
// ANTES de que `NestFactory.create()` instancie `ConfigModule` (ver
// `main.ts`) — `validateEnv()` (env.schema.ts) ve estos valores ya
// inyectados sin saber ni importarle de dónde vinieron. No se toca el
// schema: si Infisical no responde o falta una clave, esto lanza y el
// proceso muere antes de que Nest arranque nada (mismo fail-fast que
// BLUEPRINT/AGENTS.md 8.4 ya exige).
//
// `INFISICAL_CLIENT_ID`/`INFISICAL_CLIENT_SECRET` (credenciales de la
// identidad de máquina de Universal Auth) son el único secreto que sigue
// viviendo fuera de Infisical — problema de bootstrap inevitable, mismo
// motivo por el que `postgres-credentials` es un Secret de K8s sembrado
// antes de que Infisical exista (ver Jin_Infra 02-seed-secrets.sh).
const REQUIRED_SECRET_KEYS = [
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'OPENAI_API_KEY',
  'CANVAS_BASE_URL',
  'CANVAS_API_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_OWNER_CHAT_ID',
  'TELEGRAM_WEBHOOK_SECRET',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REFRESH_TOKEN',
  'OWNER_PASSWORD_HASH',
  'JWT_SECRET',
] as const;

/**
 * Claves que se cargan SI Infisical las tiene, sin fallar cuando no están.
 * El puente Claude↔owner (ADR 0012) es una función opcional: no puede impedir
 * que Jin arranque. `env.schema.ts` valida aparte que vayan las dos juntas.
 */
const OPTIONAL_SECRET_KEYS = [
  'TELEGRAM_RELAY_BOT_TOKEN',
  'RELAY_TOKEN',
] as const;

function requireVar(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) {
    throw new Error(
      `Infisical: falta la variable de configuración ${key} (requerida cuando INFISICAL_ENABLED=true)`,
    );
  }
  return value;
}

/**
 * Carga los secretos reales de Jin_Core desde Infisical y los vuelca a
 * `process.env`. No-op si `INFISICAL_ENABLED` no es `'true'` — el camino
 * de desarrollo local con `.env` queda intacto.
 */
export async function loadSecrets(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (env.INFISICAL_ENABLED !== 'true') return;

  const clientId = requireVar(env, 'INFISICAL_CLIENT_ID');
  const clientSecret = requireVar(env, 'INFISICAL_CLIENT_SECRET');
  const projectId = requireVar(env, 'INFISICAL_PROJECT_ID');
  const environment = env.INFISICAL_ENVIRONMENT ?? 'prod';

  // REQUERIDA, sin fallback: si no está, el SDK apunta por defecto a
  // `app.infisical.com` — la nube de un TERCERO — y le manda estas
  // credenciales. Pasó en el primer despliegue real (2026-09-21): el
  // Deployment no la definía, el default de Zod no aplica acá (esto corre
  // antes de que Nest exista) y ambos servicios mandaron su clientId/secret
  // a Infisical Cloud, que respondió 401. Jin es self-hosted (BLUEPRINT §11):
  // una configuración incompleta tiene que fallar ruidosamente, nunca
  // filtrar credenciales a un servicio externo por omisión.
  const siteUrl = requireVar(env, 'INFISICAL_SITE_URL');

  const client = new InfisicalSDK({ siteUrl });
  await client.auth().universalAuth.login({ clientId, clientSecret });
  const { secrets } = await client
    .secrets()
    .listSecrets({ projectId, environment });

  const byKey = new Map(secrets.map((s) => [s.secretKey, s.secretValue]));
  const missing = REQUIRED_SECRET_KEYS.filter((key) => !byKey.has(key));
  if (missing.length > 0) {
    throw new Error(
      `Infisical: faltan secretos requeridos en el proyecto/environment configurado: ${missing.join(', ')}`,
    );
  }

  for (const key of REQUIRED_SECRET_KEYS) {
    env[key] = byKey.get(key);
  }

  for (const key of OPTIONAL_SECRET_KEYS) {
    const value = byKey.get(key);
    if (value !== undefined) env[key] = value;
  }
}
