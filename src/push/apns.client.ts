import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import {
  connect,
  constants,
  type ClientHttp2Session,
  type SecureClientSessionOptions,
} from 'node:http2';
import type {
  ApnsEnvironment,
  ApnsNotification,
  ApnsSendResult,
} from './push.types';

/**
 * Cliente de APNs sin dependencias (ADR 0014): `node:http2` + JWT ES256
 * firmado con `node:crypto`. Una sesión HTTP/2 por entorno, reutilizada
 * (Apple pide no abrir una conexión por envío).
 */

export const APNS_HOSTS: Readonly<Record<ApnsEnvironment, string>> = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
};

/** Apple rechaza tokens de más de 1 h y pide no renovarlos más de 1 vez cada 20 min. */
const JWT_LIFETIME_MS = 50 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

/** Motivos de APNs que significan "este token no va a funcionar nunca más". */
const INVALID_TOKEN_REASONS = new Set([
  'BadDeviceToken',
  'Unregistered',
  'DeviceTokenNotForTopic',
  'ExpiredToken',
]);

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * JWT de proveedor de APNs: ES256, `kid` = Key ID, `iss` = Team ID.
 * `dsaEncoding: 'ieee-p1363'` da la firma r||s de 64 bytes que exige JOSE
 * (el default de Node es DER, que Apple rechaza).
 */
export function signProviderToken(input: {
  keyId: string;
  teamId: string;
  privateKey: KeyObject;
  issuedAt: Date;
}): string {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: input.keyId }));
  const claims = base64url(
    JSON.stringify({
      iss: input.teamId,
      iat: Math.floor(input.issuedAt.getTime() / 1000),
    }),
  );
  const signingInput = `${header}.${claims}`;
  const signature = sign('sha256', Buffer.from(signingInput), {
    key: input.privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${base64url(signature)}`;
}

export interface ApnsCredentials {
  readonly keyId: string;
  readonly teamId: string;
  /** Contenido del .p8 (PEM, PKCS#8, curva P-256). */
  readonly privateKeyPem: string;
  readonly bundleId: string;
}

export interface ApnsClientOptions {
  /** Hosts alternativos (tests contra un servidor HTTP/2 local). */
  readonly hosts?: Readonly<Record<ApnsEnvironment, string>>;
  readonly tls?: SecureClientSessionOptions;
  readonly now?: () => Date;
}

export class ApnsClient {
  private readonly privateKey: KeyObject;
  private readonly hosts: Readonly<Record<ApnsEnvironment, string>>;
  private readonly sessions = new Map<ApnsEnvironment, ClientHttp2Session>();
  private cachedToken: { value: string; issuedAt: number } | null = null;

  constructor(
    private readonly credentials: ApnsCredentials,
    private readonly options: ApnsClientOptions = {},
  ) {
    this.privateKey = createPrivateKey(credentials.privateKeyPem);
    this.hosts = options.hosts ?? APNS_HOSTS;
  }

  /**
   * Envía un aviso. Nunca lanza por un rechazo de Apple: devuelve el motivo
   * para que el llamador borre tokens inválidos o lo loguee.
   */
  async send(
    environment: ApnsEnvironment,
    deviceToken: string,
    notification: ApnsNotification,
  ): Promise<ApnsSendResult> {
    const topic =
      notification.pushType === 'liveactivity'
        ? `${this.credentials.bundleId}.push-type.liveactivity`
        : this.credentials.bundleId;
    const headers: Record<string, string | number> = {
      [constants.HTTP2_HEADER_METHOD]: 'POST',
      [constants.HTTP2_HEADER_PATH]: `/3/device/${deviceToken}`,
      authorization: `bearer ${this.providerToken()}`,
      'apns-topic': topic,
      'apns-push-type': notification.pushType,
      'apns-priority': notification.priority,
      'apns-expiration': notification.expiration ?? 0,
      'content-type': 'application/json',
    };
    if (notification.collapseId !== undefined) {
      headers['apns-collapse-id'] = notification.collapseId;
    }

    try {
      const { status, body } = await this.request(
        environment,
        headers,
        JSON.stringify(notification.body),
      );
      if (status === 200) return { ok: true };
      const reason = parseReason(body);
      return {
        ok: false,
        status,
        reason,
        invalidToken: status === 410 || INVALID_TOKEN_REASONS.has(reason),
      };
    } catch (err: unknown) {
      // Conexión caída: se descarta la sesión para reconectar en el próximo envío.
      this.dropSession(environment);
      return {
        ok: false,
        status: 0,
        reason: err instanceof Error ? err.message : String(err),
        invalidToken: false,
      };
    }
  }

  close(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }

  private providerToken(): string {
    const now = (this.options.now ?? (() => new Date()))();
    if (
      this.cachedToken &&
      now.getTime() - this.cachedToken.issuedAt < JWT_LIFETIME_MS
    ) {
      return this.cachedToken.value;
    }
    const value = signProviderToken({
      keyId: this.credentials.keyId,
      teamId: this.credentials.teamId,
      privateKey: this.privateKey,
      issuedAt: now,
    });
    this.cachedToken = { value, issuedAt: now.getTime() };
    return value;
  }

  private session(environment: ApnsEnvironment): ClientHttp2Session {
    const existing = this.sessions.get(environment);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = connect(this.hosts[environment], this.options.tls);
    session.on('error', () => this.dropSession(environment));
    session.on('goaway', () => this.dropSession(environment));
    this.sessions.set(environment, session);
    return session;
  }

  private dropSession(environment: ApnsEnvironment): void {
    const session = this.sessions.get(environment);
    this.sessions.delete(environment);
    if (session && !session.destroyed) session.destroy();
  }

  private request(
    environment: ApnsEnvironment,
    headers: Record<string, string | number>,
    payload: string,
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const stream = this.session(environment).request(headers);
      let status = 0;
      let body = '';
      stream.setEncoding('utf8');
      stream.setTimeout(REQUEST_TIMEOUT_MS, () => {
        stream.close(constants.NGHTTP2_CANCEL);
        reject(new Error('APNs: tiempo de espera agotado'));
      });
      stream.on('response', (responseHeaders) => {
        status = Number(responseHeaders[constants.HTTP2_HEADER_STATUS] ?? 0);
      });
      stream.on('data', (chunk: string) => {
        body += chunk;
      });
      stream.on('end', () => resolve({ status, body }));
      stream.on('error', reject);
      stream.end(payload);
    });
  }
}

function parseReason(body: string): string {
  try {
    const parsed = JSON.parse(body) as { reason?: unknown };
    return typeof parsed.reason === 'string' ? parsed.reason : 'Unknown';
  } catch {
    return body.slice(0, 100) || 'Unknown';
  }
}
