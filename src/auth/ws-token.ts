import type { Socket } from 'socket.io';
import { SESSION_COOKIE_NAME } from './jwt-auth.guard';

function parseCookies(
  cookieHeader: string | undefined,
): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;

  for (const pair of cookieHeader.split(';')) {
    const separatorIndex = pair.indexOf('=');
    if (separatorIndex === -1) continue;
    const key = pair.slice(0, separatorIndex).trim();
    const value = pair.slice(separatorIndex + 1).trim();
    cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

/**
 * El handshake de un WebSocket no pasa por el pipeline HTTP normal de
 * Nest (sin `cookie-parser`, sin `JwtAuthGuard`) — mismo criterio de
 * validación que la Fase 6.1 usa para HTTP (cookie `__Host-jin_session`
 * o `Authorization: Bearer`), leído a mano del handshake real de
 * Socket.IO. `auth.token` también se acepta — forma estándar de Socket.IO
 * para mandar un JWT desde un cliente sin cookies (la CLI).
 */
export function extractWsToken(client: Socket): string | undefined {
  const authToken = client.handshake.auth?.['token'] as string | undefined;
  if (authToken) return authToken;

  const cookies = parseCookies(client.handshake.headers.cookie);
  const cookieToken = cookies[SESSION_COOKIE_NAME];
  if (cookieToken) return cookieToken;

  const authHeader = client.handshake.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length);
  }

  return undefined;
}
