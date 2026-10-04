import type {
  DemoDbEngine,
  StartPreviewServiceInput,
} from './executor-client.service';

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

/**
 * Plantilla `node` (2026-10-02): un backend de Node (frontend + API en el mismo
 * servidor, un solo puerto) que instala sus dependencias por el proxy de npm de
 * Jin y arranca con `npm start`. El pod escucha en `PORT` (8080) y SOLO sale a
 * ese proxy; los scripts de instalación de las dependencias NO corren.
 */
export const NODE_TEMPLATE = 'node';
export const DEMO_DB_ENGINES: readonly DemoDbEngine[] = [
  'sqlite',
  'redis',
  'postgres',
  'mongodb',
];
/** Estos motores necesitan una librería cliente de npm: solo hay camino con template "node". */
const DB_NEEDS_NODE_TEMPLATE: readonly DemoDbEngine[] = [
  'redis',
  'postgres',
  'mongodb',
];
export const NODE_TEMPLATE_PORT = 8080;
/** Comando FIJO (sin texto del modelo): instala con lockfile si hay y arranca. */
export const NODE_TEMPLATE_COMMAND: readonly string[] = [
  'sh',
  '-c',
  'if [ -f package-lock.json ]; then npm ci; else npm install; fi && exec npm start',
];

/** Input tal como lo manda el modelo (command/port opcionales con plantilla). */
export interface PreviewServiceToolInput {
  readonly files: Readonly<Record<string, string>>;
  readonly template?: string | undefined;
  readonly command?: readonly string[] | undefined;
  readonly port?: number | undefined;
  readonly ttlSeconds: number;
  readonly slugHint?: string | undefined;
  /** El pod podrá enviar correo (proxy `mail-egress`); el owner lo ve en la aprobación. */
  readonly mailEgress?: boolean | undefined;
  /** Base de datos de demo (datos de prueba, no producción). */
  readonly db?: string | undefined;
  /** Nombres de secretos de demo (el owner crea el Secret; el valor nunca pasa por aquí). */
  readonly secrets?: readonly string[] | undefined;
  /** SOLO nombres de las variables de entorno de la demo; los valores viven en `EnvVaultService`. */
  readonly envNames?: readonly string[] | undefined;
}

const SECRET_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,38}$/;
const MAX_SECRETS = 5;

/** Solo NOMBRES: el valor vive en un Secret de K8s que el owner crea; ni el modelo ni Jin lo ven. */
function parseSecrets(
  secrets: readonly string[] | undefined,
): readonly string[] | undefined {
  if (secrets === undefined || secrets.length === 0) return undefined;
  if (secrets.length > MAX_SECRETS) {
    throw new PreviewTemplateInputError(
      `secrets admite como máximo ${MAX_SECRETS} nombres.`,
    );
  }
  for (const name of secrets) {
    if (typeof name !== 'string' || !SECRET_NAME_PATTERN.test(name)) {
      throw new PreviewTemplateInputError(
        `Nombre de secreto inválido: "${String(name)}" (minúsculas, números y guiones; es el nombre, NO el valor).`,
      );
    }
  }
  return [...new Set(secrets)];
}

function parseDb(db: string | undefined): DemoDbEngine | undefined {
  if (db === undefined) return undefined;
  if (!(DEMO_DB_ENGINES as readonly string[]).includes(db)) {
    throw new PreviewTemplateInputError(
      `db desconocida: "${db}". Valores válidos: ${DEMO_DB_ENGINES.map((e) => `"${e}"`).join(', ')}.`,
    );
  }
  return db as DemoDbEngine;
}

/** `package.json` bien formado y con cómo arrancar (`scripts.start` o `main`), o un error accionable. */
function validateNodePackageJson(
  files: Readonly<Record<string, string>>,
): void {
  const raw = files['package.json'];
  if (raw === undefined) {
    throw new PreviewTemplateInputError(
      'template "node" necesita un package.json en la raíz (con dependencies y scripts.start).',
    );
  }
  let pkg: unknown;
  try {
    pkg = JSON.parse(raw);
  } catch {
    throw new PreviewTemplateInputError('package.json no es JSON válido.');
  }
  const record =
    pkg !== null && typeof pkg === 'object'
      ? (pkg as Record<string, unknown>)
      : null;
  const scripts = record?.scripts;
  const start =
    scripts !== null && typeof scripts === 'object'
      ? (scripts as Record<string, unknown>).start
      : undefined;
  if (typeof start !== 'string' && typeof record?.main !== 'string') {
    throw new PreviewTemplateInputError(
      'package.json necesita scripts.start (o main) para saber cómo arrancar. El servidor debe escuchar en process.env.PORT.',
    );
  }
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
  const db = parseDb(input.db);
  const secrets = parseSecrets(input.secrets);
  if (db !== undefined && input.template === STATIC_TEMPLATE) {
    throw new PreviewTemplateInputError(
      'db no se puede usar con template "static": no tiene backend. Usá template: "node" (frontend y API en un servidor Node).',
    );
  }
  if (
    db !== undefined &&
    DB_NEEDS_NODE_TEMPLATE.includes(db) &&
    input.template !== NODE_TEMPLATE
  ) {
    throw new PreviewTemplateInputError(
      `${db} necesita una librería cliente de npm: usá template: "node" con un package.json que la declare. (sqlite sí funciona sin npm, con node:sqlite).`,
    );
  }
  const base = {
    ttlSeconds: input.ttlSeconds,
    ...(input.slugHint !== undefined ? { slugHint: input.slugHint } : {}),
    ...(input.mailEgress === true ? { mailEgress: true } : {}),
    ...(db !== undefined ? { db } : {}),
    ...(secrets !== undefined ? { secrets } : {}),
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

  if (input.template === NODE_TEMPLATE) {
    validateNodePackageJson(input.files);
    return {
      ...base,
      files: input.files,
      command: NODE_TEMPLATE_COMMAND,
      port: NODE_TEMPLATE_PORT,
      npm: true,
    };
  }

  if (input.template !== STATIC_TEMPLATE) {
    throw new PreviewTemplateInputError(
      `template desconocido: "${input.template}". Valores válidos: "static", "node".`,
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
