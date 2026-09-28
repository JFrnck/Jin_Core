import type { StartPreviewServiceInput } from './executor-client.service';

/**
 * Plantilla `static` de `startPreviewService`: sirve los archivos tal cual con
 * un servidor mínimo de Node incluido por Jin, sin `npm install`.
 *
 * Por qué existe: los pods de preview no tienen salida a internet (solo DNS,
 * `agents-sandbox` default-deny), así que un proyecto Vite/React que necesite
 * `npm install` no puede arrancar. Con la plantilla, React/Tailwind se cargan
 * desde un CDN **en el navegador de quien abre la app**, no en el pod, y el
 * agente solo escribe `index.html` (+ JS/CSS opcionales). El aislamiento del
 * pod no cambia.
 *
 * Transparencia HITL: el payload que aprueba el owner dice `template:
 * "static"`; el servidor que se agrega es código fijo de Jin (este archivo),
 * no del agente.
 */
export const STATIC_TEMPLATE = 'static';
export const STATIC_TEMPLATE_PORT = 8080;
export const STATIC_SERVER_PATH = '.jin/static-server.mjs';

/** Input tal como lo manda el modelo (command/port opcionales con plantilla). */
export interface PreviewServiceToolInput {
  readonly files: Readonly<Record<string, string>>;
  readonly template?: string | undefined;
  readonly command?: readonly string[] | undefined;
  readonly port?: number | undefined;
  readonly ttlSeconds: number;
  readonly slugHint?: string | undefined;
}

export class PreviewTemplateInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreviewTemplateInputError';
  }
}

/**
 * Convierte el input de la tool en el request que entiende el Executor.
 * Errores con mensaje accionable para el modelo (el agent loop se los
 * devuelve como resultado de la tool).
 */
export function expandPreviewTemplate(
  input: PreviewServiceToolInput,
): StartPreviewServiceInput {
  const base = {
    ttlSeconds: input.ttlSeconds,
    ...(input.slugHint !== undefined ? { slugHint: input.slugHint } : {}),
  };

  if (input.template === undefined) {
    if (!input.command?.length || input.port === undefined) {
      throw new PreviewTemplateInputError(
        'Sin template hay que indicar command y port. Para una web con React/Tailwind usá template: "static" con un index.html (dependencias desde CDN): el pod no tiene internet para npm install.',
      );
    }
    return {
      ...base,
      files: input.files,
      command: input.command,
      port: input.port,
    };
  }

  if (input.template !== STATIC_TEMPLATE) {
    throw new PreviewTemplateInputError(
      `template desconocido: "${input.template}". Valores válidos: "static".`,
    );
  }
  if (!('index.html' in input.files)) {
    throw new PreviewTemplateInputError(
      'template "static" necesita un archivo index.html en la raíz.',
    );
  }
  if (STATIC_SERVER_PATH in input.files) {
    throw new PreviewTemplateInputError(
      `${STATIC_SERVER_PATH} está reservado para el servidor de la plantilla.`,
    );
  }
  return {
    ...base,
    files: { ...input.files, [STATIC_SERVER_PATH]: STATIC_SERVER_SOURCE },
    command: ['node', STATIC_SERVER_PATH],
    port: STATIC_TEMPLATE_PORT,
  };
}

/**
 * Servidor estático sin dependencias. Solo GET/HEAD, sin listado de
 * directorios, sin salir de /workspace y sin servir `.jin/`. Rutas sin
 * extensión caen a index.html (SPA con router del lado del cliente).
 */
export const STATIC_SERVER_SOURCE = `import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const ROOT = resolve(process.cwd());
const PORT = ${STATIC_TEMPLATE_PORT};
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.jsx': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

function safePath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    return null;
  }
  const full = resolve(join(ROOT, normalize(decoded)));
  if (full !== ROOT && !full.startsWith(ROOT + sep)) return null;
  if (full.startsWith(join(ROOT, '.jin'))) return null;
  return full;
}

async function fileAt(path) {
  try {
    const info = await stat(path);
    if (info.isFile()) return path;
    if (info.isDirectory()) {
      const index = join(path, 'index.html');
      const indexInfo = await stat(index).catch(() => null);
      return indexInfo?.isFile() ? index : null;
    }
  } catch {}
  return null;
}

createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  const requested = safePath(req.url ?? '/');
  if (!requested) {
    res.writeHead(404).end('No encontrado');
    return;
  }
  let file = await fileAt(requested);
  if (!file && extname(requested) === '') file = await fileAt(join(ROOT, 'index.html'));
  if (!file) {
    res.writeHead(404).end('No encontrado');
    return;
  }
  const body = await readFile(file);
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}).listen(PORT, '0.0.0.0', () => {
  console.log('jin static server en :' + PORT);
});
`;
