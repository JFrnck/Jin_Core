import type { IntegrationName } from '../feature-flags/feature-flags.types';
import type { HitlLevel } from '../hitl/types';

/**
 * Declaración estática del `hitlLevel` de cada tool (BLUEPRINT 9.3,
 * AGENTS.md 5.4). ESTE es el único lugar donde un nivel se asigna a una
 * tool. El LLM jamás decide esto en runtime; cambiarlo requiere PR con
 * revisión humana + dual-confirm (AGENTS.md 5.4).
 */
export interface ToolDefinition {
  readonly name: string;
  readonly hitlLevel: HitlLevel;
  readonly description: string;
  /**
   * Solo aplica si `hitlLevel` es 'confirm'/'dual-confirm' (BLUEPRINT 9.4):
   * qué hace timeout.service cuando la aprobación expira sin respuesta.
   * 'discard' = reversible/informativo, se descarta y se notifica.
   * 'escalate' = tiene deadline externo, se escala a las 12h y se marca
   * 'abandoned' a las 24h. Ausente para tools 'auto'/'notify' (no aplica).
   */
  readonly timeoutBehavior?: 'discard' | 'escalate';
  /**
   * JSON Schema de los argumentos que el LLM debe producir para invocar
   * esta tool (Fase 5.1, `src/agent/`) — `src/model-provider/` lo traduce
   * al formato nativo de cada vendor (`input_schema` de Anthropic,
   * `parametersJsonSchema` de Gemini). Refleja los args reales que
   * consumen los handlers en `src/integrations/**` — no incluye campos de
   * plomería interna (`sessionNonce`, `requestId`) que el loop resuelve
   * por su cuenta, nunca el LLM.
   */
  readonly inputSchema: Record<string, unknown>;
  /**
   * Integración toggleable vía `config/feature-flags.yaml` (Fase 9.5,
   * BLUEPRINT §12.3) que esta tool necesita para funcionar. Ausente para
   * tools que no dependen de una integración externa apagable (plan,
   * runCode, orquestación, preview services). `AgentService` rechaza la
   * llamada ANTES de clasificarla si la integración declarada acá está
   * desactivada — chequeo único, no disperso por módulo.
   */
  readonly integration?: IntegrationName;
}

// `as const` es solo un contrato de tipos — Object.freeze es lo que da la
// garantía real en runtime de que nadie muta el registry (defensa en
// profundidad: "el hitlLevel jamás se decide en runtime" también aplica
// a que un `as any` no pueda colarse un .push()).
const TOOL_REGISTRY: readonly ToolDefinition[] = Object.freeze([
  Object.freeze({
    name: 'readEmails',
    integration: 'google',
    hitlLevel: 'auto',
    description:
      'Lee correos del usuario. Solo lectura, sin efectos secundarios.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Query de búsqueda estilo Gmail (ej. "is:unread label:INBOX").',
        },
        threadId: {
          type: 'string',
          description: 'Si se provee, lee un hilo específico en vez de listar.',
        },
        maxResults: {
          type: 'number',
          description: 'Tope de mensajes a devolver.',
        },
      },
    },
  }),
  Object.freeze({
    name: 'createCalendarEvent',
    integration: 'google',
    hitlLevel: 'notify',
    description:
      'Crea un evento en Google Calendar. Se ejecuta y se notifica después.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Título del evento.' },
        description: { type: 'string' },
        location: { type: 'string' },
        start: {
          type: 'string',
          format: 'date-time',
          description: 'ISO 8601.',
        },
        end: { type: 'string', format: 'date-time', description: 'ISO 8601.' },
      },
      required: ['summary', 'start', 'end'],
    },
  }),
  Object.freeze({
    name: 'sendEmail',
    integration: 'google',
    hitlLevel: 'confirm',
    description:
      'Envía un correo en nombre del usuario. Requiere 1 aprobación.',
    // Reversible/informativo (BLUEPRINT 9.4, ejemplo explícito: "responder
    // correo"): al expirar se descarta y se notifica, no se escala.
    timeoutBehavior: 'discard',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', format: 'email' },
        subject: { type: 'string' },
        body: { type: 'string' },
        threadId: {
          type: 'string',
          description:
            'Si se provee, responde en ese hilo en vez de crear uno nuevo.',
        },
      },
      required: ['to', 'subject', 'body'],
    },
  }),
  // Fase 3.1 (Canvas LMS, BLUEPRINT 7.1 / PROMPTS.md 3.1). Declaración
  // únicamente — el handler real (src/integrations/canvas/) lo construye
  // Antigravity en su propio PR, consumiendo estas 3 tools ya
  // registradas (WORKFLOW.md 2.2: registry.ts es área de Claude Code).
  Object.freeze({
    name: 'canvasListAssignments',
    integration: 'canvas',
    hitlLevel: 'auto',
    description:
      'Lista tareas/entregables próximos de Canvas. Solo lectura, sin efectos secundarios.',
    inputSchema: {
      type: 'object',
      properties: {
        courseId: {
          type: 'number',
          description:
            'Filtra por curso. Si se omite, lista de todos los cursos.',
        },
      },
    },
  }),
  Object.freeze({
    name: 'canvasGetCourseContent',
    integration: 'canvas',
    hitlLevel: 'auto',
    description:
      'Lee materiales de un curso de Canvas (anuncios, archivos). Solo lectura.',
    inputSchema: {
      type: 'object',
      properties: {
        courseIds: {
          type: 'array',
          items: { type: 'number' },
          description: 'IDs de los cursos a consultar.',
        },
        sinceDate: {
          type: 'string',
          format: 'date',
          description: 'Solo contenido publicado desde esta fecha (ISO 8601).',
        },
      },
      required: ['courseIds'],
    },
  }),
  Object.freeze({
    name: 'canvasScheduleStudyBlock',
    integration: 'canvas',
    hitlLevel: 'notify',
    description:
      'Crea un bloque de estudio sugerido en Google Calendar a partir de tareas de Canvas. Se ejecuta y se notifica después.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        startTime: {
          type: 'string',
          format: 'date-time',
          description: 'ISO 8601.',
        },
        endTime: {
          type: 'string',
          format: 'date-time',
          description: 'ISO 8601.',
        },
      },
      required: ['title', 'startTime', 'endTime'],
    },
  }),
  // Fase 4.2 (Google Calendar + Gmail, BLUEPRINT 7.2 / PROMPTS.md 4.2).
  // Declaración únicamente — el handler real (src/integrations/google/)
  // lo construye Antigravity (WORKFLOW.md 2.2: registry.ts es área de
  // Claude Code). Gmail no suma tools nuevas: "listar/leer" reusa
  // `readEmails` (ya `auto`) y "responder/enviar nuevo" reusa `sendEmail`
  // (ya `confirm`) — ambos pares comparten nivel HITL, no hay motivo
  // para duplicar declaraciones. `createCalendarEvent` (arriba) también
  // se reusa tal cual.
  Object.freeze({
    name: 'listCalendarEvents',
    integration: 'google',
    hitlLevel: 'auto',
    description:
      'Lista eventos de Google Calendar. Solo lectura, sin efectos secundarios.',
    inputSchema: {
      type: 'object',
      properties: {
        timeMin: {
          type: 'string',
          format: 'date-time',
          description: 'ISO 8601.',
        },
        timeMax: {
          type: 'string',
          format: 'date-time',
          description: 'ISO 8601.',
        },
        maxResults: { type: 'number' },
      },
    },
  }),
  Object.freeze({
    name: 'updateCalendarEvent',
    integration: 'google',
    hitlLevel: 'notify',
    // Owner decidió 'notify' (no está en BLUEPRINT/PROMPTS explícito):
    // mismo riesgo que crear un evento nuevo — se ejecuta y se notifica
    // después, no requiere aprobación previa.
    description:
      'Actualiza un evento existente en Google Calendar. Se ejecuta y se notifica después.',
    inputSchema: {
      type: 'object',
      properties: {
        eventId: { type: 'string' },
        eventData: {
          type: 'object',
          description: 'Solo los campos a cambiar.',
          properties: {
            summary: { type: 'string' },
            description: { type: 'string' },
            location: { type: 'string' },
            start: { type: 'string', format: 'date-time' },
            end: { type: 'string', format: 'date-time' },
          },
        },
      },
      required: ['eventId', 'eventData'],
    },
  }),
  // "Borrar evento pasado: notify. Borrar evento futuro: confirm"
  // (PROMPTS.md 4.2) no se puede expresar como una sola tool: el
  // hitlLevel es estático por tool y NUNCA depende de los inputs en
  // runtime (AGENTS.md 5.4, probado en classifier.spec.ts). Se separan
  // en dos tools — la distinción pasa de "input en runtime" a "qué tool
  // estática se invoca", el LLM elige cuál según la fecha del evento
  // ANTES de llamar, no el clasificador después.
  Object.freeze({
    name: 'deleteCalendarEventPast',
    integration: 'google',
    hitlLevel: 'notify',
    description:
      'Borra un evento pasado de Google Calendar. Se ejecuta y se notifica después.',
    inputSchema: {
      type: 'object',
      properties: { eventId: { type: 'string' } },
      required: ['eventId'],
    },
  }),
  Object.freeze({
    name: 'deleteCalendarEventFuture',
    integration: 'google',
    hitlLevel: 'confirm',
    description:
      'Borra un evento futuro de Google Calendar. Requiere 1 aprobación.',
    // Reversible/informativo (mismo criterio que sendEmail): al expirar
    // se descarta y se notifica, el evento simplemente no se borra.
    timeoutBehavior: 'discard',
    inputSchema: {
      type: 'object',
      properties: { eventId: { type: 'string' } },
      required: ['eventId'],
    },
  }),
  // Fase 5.2 (ejecución aislada, BLUEPRINT 4 / PROMPTS.md 5.2). Declaración
  // únicamente — el handler real (src/executor-client/) llama al Executor
  // por HTTP, que a su vez decide de forma automática si corre local
  // (Deno) o escala a Modal según `language` (BLUEPRINT 4.5: "decisión
  // automática por el Executor", nunca del LLM ni de este registry).
  Object.freeze({
    name: 'runCode',
    hitlLevel: 'confirm',
    description:
      'Ejecuta código TypeScript o Python en un entorno aislado (pod Deno local o sandbox de Modal para dependencias científicas como pandas). Requiere 1 aprobación.',
    // Reversible/informativo (BLUEPRINT 9.4): no aprobar significa que el
    // código simplemente nunca corre, sin deadline externo que escalar —
    // mismo criterio que sendEmail/deleteCalendarEventFuture.
    timeoutBehavior: 'discard',
    // Deliberadamente NO expone `env` al LLM (defensa en profundidad: el
    // modelo no necesita ni debe poder inyectar variables de entorno
    // arbitrarias al pod/sandbox) — src/executor-client/ arma el request
    // completo al Executor con env fijo.
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Código fuente a ejecutar.' },
        language: {
          type: 'string',
          enum: ['typescript', 'python'],
          description:
            'typescript corre local en un pod Deno aislado; python escala automáticamente a Modal (dependencias científicas).',
        },
      },
      required: ['code', 'language'],
    },
  }),
  // Fase 5.4 (orquestación multi-agente, ADR 0005). Tool SINTÉTICA: no
  // ejecuta ninguna acción externa, es el mecanismo por el que el
  // orquestador escala un conflicto MATERIAL entre sub-agentes al owner
  // — reusa el HITL/Telegram existente en vez de inventar un canal de
  // escalamiento nuevo. Aprobar = aceptar la resolución propuesta por el
  // orquestador y desbloquear el ticket; rechazar = el ticket queda
  // 'blocked' para revisión manual.
  Object.freeze({
    name: 'resolveAgentConflict',
    hitlLevel: 'confirm',
    description:
      'Escala al owner un conflicto material detectado entre sub-agentes durante una orquestación multi-agente, con una resolución propuesta. Requiere 1 aprobación.',
    // Reversible/informativo: el ticket simplemente queda bloqueado si no
    // se aprueba, sin deadline externo — mismo criterio que runCode.
    timeoutBehavior: 'discard',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: { type: 'string' },
        conflictSummary: { type: 'string' },
        proposedResolution: { type: 'string' },
      },
      required: ['ticketId', 'conflictSummary', 'proposedResolution'],
    },
  }),
  // Fase 5.4 (orquestación multi-agente, ADR 0005). Declarada por
  // completitud del guardrail que pide PROMPTS.md §5.4 (trabajo de
  // código de un sub-agente SIEMPRE en `feature/agent/<ticket>`, merge a
  // main solo vía tool confirm) — el executor es un 501 documentado
  // (`AgentBranchMergeNotImplementedError`, mismo patrón que
  // `CalendarNotImplementedError`): hoy ningún tool registrado le da a
  // un sub-agente la capacidad de escribir código o crear una branch
  // real, así que esta tool no tiene todavía quién la invoque con un
  // payload real. Se activa cuando exista una tool de edición de código.
  Object.freeze({
    name: 'mergeAgentBranch',
    hitlLevel: 'confirm',
    description:
      'Mergea a main la branch feature/agent/<ticket> de un sub-agente. Requiere 1 aprobación. NO IMPLEMENTADA todavía (501) — no existe hoy ninguna tool que le dé a un sub-agente la capacidad de producir una branch real.',
    timeoutBehavior: 'discard',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: { type: 'string' },
        branchName: { type: 'string' },
      },
      required: ['ticketId', 'branchName'],
    },
  }),
  // Fase 5.5 (pods de servicio, ADR 0006). `files` llega inline (mapa
  // ruta->contenido) — ninguna tool existente le da hoy a un agente
  // acceso a un repo git real, así que "código clonado de su branch"
  // (texto literal de PROMPTS.md §5.5) queda como extensión futura, ver
  // el ADR. El Executor empaqueta `files` a tar.gz y lo extrae con un
  // init container, sin ConfigMap ni shell (mismo criterio de seguridad
  // que el `data:` URL de `runCode`).
  Object.freeze({
    name: 'startPreviewService',
    hitlLevel: 'confirm',
    description:
      'Levanta un pod de servicio de larga vida (ej. npm run dev) expuesto bajo https://<slug>.jinserver.com, con TTL obligatorio. Requiere 1 aprobación: expone código de agentes a internet, aunque sea en el dominio sandbox.',
    timeoutBehavior: 'discard',
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Mapa ruta relativa -> contenido del proyecto a servir.',
        },
        command: {
          type: 'array',
          items: { type: 'string' },
          description: 'argv del proceso principal, ej. ["npm","run","dev"].',
        },
        port: { type: 'number', description: 'Puerto que expone el proceso.' },
        ttlSeconds: {
          type: 'number',
          description:
            'Tiempo de vida antes de que el reaper lo destruya automáticamente (cap duro: 24h).',
        },
        slugHint: {
          type: 'string',
          description:
            'Nombre legible cosmético — la entropía real del subdominio la agrega el Executor.',
        },
      },
      required: ['files', 'command', 'port', 'ttlSeconds'],
    },
  }),
  Object.freeze({
    name: 'stopPreviewService',
    hitlLevel: 'notify',
    description:
      'Detiene y destruye un pod de servicio activo antes de su TTL.',
    inputSchema: {
      type: 'object',
      properties: { serviceId: { type: 'string' } },
      required: ['serviceId'],
    },
  }),
  Object.freeze({
    name: 'listPreviewServices',
    hitlLevel: 'auto',
    description:
      'Lista los pods de servicio activos del owner y su TTL restante. Solo lectura.',
    inputSchema: { type: 'object', properties: {} },
  }),
  // Fase 7.3 (ADR 0008, BLUEPRINT §6.4): documentación técnica externa
  // vía MCP servers oficiales (Context7 hoy, config/mcp-servers.yaml),
  // sin pipeline propio de scraping. Ejecutor real en
  // src/mcp/mcp.module.ts. `auto`: es un lookup de solo lectura, sin
  // efectos secundarios -- el resultado (contenido externo) pasa por
  // wrapUntrustedContent como cualquier otra tool, en
  // AgentService.handleRealToolCall, sin código nuevo ahí.
  Object.freeze({
    name: 'queryExternalDocs',
    hitlLevel: 'auto',
    description:
      'Busca documentación oficial de una librería o framework externo (ej. "react", "tailwindcss") sobre un tema puntual. Solo lectura, vía MCP.',
    inputSchema: {
      type: 'object',
      properties: {
        library: {
          type: 'string',
          description: 'Nombre de la librería/framework, ej. "react".',
        },
        query: {
          type: 'string',
          description: 'Qué se necesita saber, ej. "hooks useEffect cleanup".',
        },
      },
      required: ['library', 'query'],
    },
  }),
] satisfies ToolDefinition[]);

const TOOL_REGISTRY_BY_NAME: ReadonlyMap<string, ToolDefinition> = new Map(
  TOOL_REGISTRY.map((tool) => [tool.name, tool]),
);

export function getToolDefinition(name: string): ToolDefinition | undefined {
  return TOOL_REGISTRY_BY_NAME.get(name);
}

export function listRegisteredTools(): readonly ToolDefinition[] {
  return TOOL_REGISTRY;
}
