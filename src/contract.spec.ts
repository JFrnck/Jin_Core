import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Guarda del contrato OpenAPI (regla de oro #11: Web y CLI generan sus tipos
// desde `contracts/openapi.json`). Un defecto real ya pasó por acá: dos DTOs de
// unión anónimos (`createZodDto(...)` sin clase) compartían el nombre interno
// "AugmentedZodDto", Swagger dejaba solo uno, y `POST /api/hitl/{id}/approve`
// terminó documentando la respuesta de `POST /api/autonomy`. Ningún test lo veía
// porque el contrato nunca se validaba: solo se regeneraba.
interface OpenApiDoc {
  paths: Record<
    string,
    Record<
      string,
      {
        responses?: Record<
          string,
          { content?: Record<string, { schema?: unknown }> }
        >;
      }
    >
  >;
  components: { schemas: Record<string, unknown> };
}

const doc = JSON.parse(
  readFileSync(join(process.cwd(), 'contracts', 'openapi.json'), 'utf-8'),
) as OpenApiDoc;

function responseRef(path: string, method: string): string | undefined {
  const schema = doc.paths[path]?.[method]?.responses?.['200']?.content?.[
    'application/json'
  ]?.schema as { $ref?: string } | undefined;
  return schema?.$ref?.split('/').pop();
}

describe('contracts/openapi.json', () => {
  it('ningún esquema se llama AugmentedZodDto (= un createZodDto anónimo colisionando)', () => {
    const anonymous = Object.keys(doc.components.schemas).filter((k) =>
      k.startsWith('AugmentedZodDto'),
    );
    expect(anonymous).toEqual([]);
  });

  it('POST /api/hitl/{requestId}/approve documenta SU respuesta, no la de otro endpoint', () => {
    expect(responseRef('/api/hitl/{requestId}/approve', 'post')).toBe(
      'ResolveAndExecuteResult_Output',
    );
  });

  it('POST /api/autonomy documenta la respuesta de cambio de modo', () => {
    expect(responseRef('/api/autonomy', 'post')).toBe(
      'ChangeModeResult_Output',
    );
    expect(responseRef('/api/autonomy', 'get')).toBe(
      'AutonomyStatusDto_Output',
    );
  });

  it('todo $ref de una respuesta 200 apunta a un esquema que existe', () => {
    const missing: string[] = [];
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const method of Object.keys(methods)) {
        const ref = responseRef(path, method);
        if (ref !== undefined && !(ref in doc.components.schemas)) {
          missing.push(`${method.toUpperCase()} ${path} -> ${ref}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('los dos esquemas de unión conviven (ninguno pisó al otro)', () => {
    expect(doc.components.schemas).toHaveProperty(
      'ResolveAndExecuteResult_Output',
    );
    expect(doc.components.schemas).toHaveProperty('ChangeModeResult_Output');
  });
});
