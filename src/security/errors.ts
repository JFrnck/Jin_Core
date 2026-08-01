import { JinError } from '../common/errors/jin-error';

/**
 * `sessionNonce` no matchea el formato esperado (16 caracteres hex,
 * AGENTS.md 5.1). Fail-safe: si el nonce está malformado, envolver el
 * contenido igual produciría un tag que el system prompt del agente no
 * reconocería como confiable — mejor fallar ruidosamente ahora que dejar
 * pasar un tag roto que ni el propio sistema puede verificar después.
 */
export class InvalidSessionNonceError extends JinError {
  constructor(sessionNonce: string) {
    super(
      `sessionNonce inválido: "${sessionNonce}". Se espera un hexadecimal de 16 caracteres generado por generateSessionNonce().`,
      { code: 'SECURITY_INVALID_SESSION_NONCE', httpStatus: 400 },
    );
  }
}
