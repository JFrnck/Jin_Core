import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import {
  createServer,
  type Http2Server,
  type IncomingHttpHeaders,
} from 'node:http2';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApnsClient, signProviderToken } from './apns.client';
import { approvalNewPayload, liveActivityUpdatePayload } from './push.payloads';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const privateKeyPem = privateKey
  .export({ type: 'pkcs8', format: 'pem' })
  .toString();
const TOKEN = 'a'.repeat(64);

function decodePart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString()) as Record<
    string,
    unknown
  >;
}

describe('signProviderToken', () => {
  it('firma un JWT ES256 (r||s de 64 bytes) que verifica con la clave pública', () => {
    const jwt = signProviderToken({
      keyId: 'ABC123DEFG',
      teamId: 'TEAM123456',
      privateKey,
      issuedAt: new Date('2026-09-26T12:00:00Z'),
    });
    const [header, claims, signature] = jwt.split('.');
    expect(decodePart(header!)).toEqual({ alg: 'ES256', kid: 'ABC123DEFG' });
    expect(decodePart(claims!)).toEqual({ iss: 'TEAM123456', iat: 1790424000 });

    const raw = Buffer.from(signature!, 'base64url');
    expect(raw).toHaveLength(64);
    expect(
      verify(
        'sha256',
        Buffer.from(`${header}.${claims}`),
        { key: createPublicKey(privateKey), dsaEncoding: 'ieee-p1363' },
        raw,
      ),
    ).toBe(true);
  });
});

describe('ApnsClient', () => {
  let server: Http2Server;
  let url: string;
  let received: { headers: IncomingHttpHeaders; body: string }[];
  let reply: { status: number; body?: string };

  beforeEach(async () => {
    received = [];
    reply = { status: 200 };
    // HTTP/2 sin TLS (h2c): mismo protocolo que APNs, sin certificados en el test.
    server = createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (body += chunk));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(reply.body ?? '');
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function client(): ApnsClient {
    return new ApnsClient(
      {
        keyId: 'ABC123DEFG',
        teamId: 'TEAM123456',
        privateKeyPem,
        bundleId: 'com.jeanfranck.jin',
      },
      { hosts: { sandbox: url, production: url } },
    );
  }

  it('envía a /3/device/<token> con los headers de APNs y el JWT', async () => {
    const apns = client();
    const result = await apns.send(
      'sandbox',
      TOKEN,
      approvalNewPayload({
        requestId: 'r1',
        toolName: 'sendEmail',
        level: 'confirm',
        planSummary: 'Responder',
      }),
    );
    apns.close();

    expect(result).toEqual({ ok: true });
    const [request] = received;
    expect(request?.headers[':path']).toBe(`/3/device/${TOKEN}`);
    expect(request?.headers['apns-topic']).toBe('com.jeanfranck.jin');
    expect(request?.headers['apns-push-type']).toBe('alert');
    expect(request?.headers['apns-priority']).toBe('10');
    expect(request?.headers['apns-collapse-id']).toBe('r1');
    expect(request?.headers.authorization).toMatch(
      /^bearer [\w-]+\.[\w-]+\.[\w-]+$/,
    );
    expect(JSON.parse(request!.body)).toMatchObject({
      link: 'jin://approval/r1',
    });
  });

  it('Live Activity: tópico .push-type.liveactivity', async () => {
    const apns = client();
    await apns.send(
      'production',
      TOKEN,
      liveActivityUpdatePayload({
        kind: 'orchestration',
        state: {
          title: 'x',
          ready: false,
          segments: [],
          agents: [],
          phase: 'running',
        },
      }),
    );
    apns.close();
    expect(received[0]?.headers['apns-topic']).toBe(
      'com.jeanfranck.jin.push-type.liveactivity',
    );
    expect(received[0]?.headers['apns-push-type']).toBe('liveactivity');
  });

  it('410 / BadDeviceToken → invalidToken; otros rechazos no', async () => {
    const apns = client();
    reply = { status: 410, body: '{"reason":"Unregistered"}' };
    const gone = await apns.send(
      'sandbox',
      TOKEN,
      approvalNewPayload({
        requestId: 'r',
        toolName: 't',
        level: 'confirm',
        planSummary: null,
      }),
    );
    reply = { status: 400, body: '{"reason":"BadDeviceToken"}' };
    const bad = await apns.send(
      'sandbox',
      TOKEN,
      approvalNewPayload({
        requestId: 'r',
        toolName: 't',
        level: 'confirm',
        planSummary: null,
      }),
    );
    reply = { status: 429, body: '{"reason":"TooManyRequests"}' };
    const busy = await apns.send(
      'sandbox',
      TOKEN,
      approvalNewPayload({
        requestId: 'r',
        toolName: 't',
        level: 'confirm',
        planSummary: null,
      }),
    );
    apns.close();

    expect(gone).toEqual({
      ok: false,
      status: 410,
      reason: 'Unregistered',
      invalidToken: true,
    });
    expect(bad).toMatchObject({
      ok: false,
      reason: 'BadDeviceToken',
      invalidToken: true,
    });
    expect(busy).toMatchObject({ ok: false, status: 429, invalidToken: false });
  });

  it('reutiliza el JWT entre envíos (Apple rechaza renovarlo muy seguido)', async () => {
    const apns = client();
    const payload = approvalNewPayload({
      requestId: 'r',
      toolName: 't',
      level: 'confirm',
      planSummary: null,
    });
    await apns.send('sandbox', TOKEN, payload);
    await apns.send('sandbox', TOKEN, payload);
    apns.close();
    expect(received[0]?.headers.authorization).toBe(
      received[1]?.headers.authorization,
    );
  });

  it('servidor caído: devuelve el error sin lanzar', async () => {
    const apns = new ApnsClient(
      {
        keyId: 'ABC123DEFG',
        teamId: 'TEAM123456',
        privateKeyPem,
        bundleId: 'com.jeanfranck.jin',
      },
      {
        hosts: {
          sandbox: 'http://127.0.0.1:1',
          production: 'http://127.0.0.1:1',
        },
      },
    );
    const result = await apns.send(
      'sandbox',
      TOKEN,
      approvalNewPayload({
        requestId: 'r',
        toolName: 't',
        level: 'confirm',
        planSummary: null,
      }),
    );
    apns.close();
    expect(result).toMatchObject({ ok: false, status: 0, invalidToken: false });
  });
});
