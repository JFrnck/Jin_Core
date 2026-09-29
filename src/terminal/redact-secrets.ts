/**
 * Vista previa segura de una línea de terminal para el audit (ADR 0017).
 *
 * El audit guarda los primeros 120 caracteres de cada comando. El token de
 * suscripción de Claude Code (`claude setup-token` → `sk-ant-oat01-…`) NO debería
 * pasar por la terminal (se guarda por el explorador de archivos), pero si el
 * owner lo pega igual —`export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-…`, o lo escribe
 * como respuesta a un prompt— jamás debe quedar en una fila del audit.
 *
 * Se redacta ANTES de cortar a 120 caracteres: un token que atraviese el corte
 * quedaría a medias, pero legible.
 */
const ANTHROPIC_TOKEN = /sk-ant-[A-Za-z0-9_-]+/g;
const SECRET_ASSIGNMENT =
  /\b(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN)(\s*=\s*)(?:"[^"]*"?|'[^']*'?|\S+)/g;

export function redactSecrets(text: string): string {
  return text
    .replace(SECRET_ASSIGNMENT, '$1$2[omitido]')
    .replace(ANTHROPIC_TOKEN, 'sk-ant-[omitido]');
}

/** Espacios normalizados, secretos redactados y cortado a `length`: lo único que va al `planSummary` del audit. */
export function auditPreview(text: string, length: number): string {
  return redactSecrets(text).replace(/\s+/g, ' ').trim().slice(0, length);
}
