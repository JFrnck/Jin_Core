import { StringDecoder } from 'node:string_decoder';

/** Un tramo de teclas a reenviar al TTY, en orden. */
export interface PtyInputStep {
  readonly bytes: Buffer;
  /**
   * Línea tecleada que hay que auditar ANTES de reenviar `bytes` (que terminan
   * en Enter). `null`: nada que auditar (teclas sueltas o una línea vacía).
   */
  readonly line: string | null;
}

/** Igual que `TERMINAL_MAX_COMMAND_LENGTH` de los comandos: más de eso no se acumula. */
const MAX_LINE_CHARS = 4096;

const ESC = 0x1b;
const CR = 0x0d;
const LF = 0x0a;
const BACKSPACE = 0x08;
const DEL = 0x7f;
const CTRL_C = 0x03;
const CTRL_U = 0x15;
const CTRL_W = 0x17;

type EscapeState = 'none' | 'esc' | 'csi' | 'ss3';

/**
 * Reconstruye la línea que el owner va tecleando en la terminal interactiva,
 * para poder auditarla antes de que el Enter llegue al shell (ADR 0016: "cada
 * comando queda en el audit ANTES de ejecutarse, fail-closed"). Es una
 * aproximación, no un intérprete de shell: cubre caracteres, borrar, Ctrl+U/W/C
 * y salta las secuencias de escape (flechas, Home/End). Lo que no puede saber
 * (Tab que completa, historial con flecha arriba) queda sin reflejar.
 */
export class PtyInputGate {
  private line = '';
  private decoder = new StringDecoder('utf8');
  private escape: EscapeState = 'none';

  feed(data: Buffer): PtyInputStep[] {
    const steps: PtyInputStep[] = [];
    let start = 0;

    for (let index = 0; index < data.length; index += 1) {
      const byte = data[index] as number;

      if (this.escape !== 'none') {
        this.consumeEscape(byte);
        continue;
      }
      if (byte === ESC) {
        this.escape = 'esc';
        continue;
      }
      if (byte === CR || byte === LF) {
        const line = this.takeLine();
        steps.push({ bytes: data.subarray(start, index + 1), line });
        start = index + 1;
        continue;
      }
      this.applyKey(byte);
    }

    if (start < data.length) {
      steps.push({ bytes: data.subarray(start), line: null });
    }
    return steps;
  }

  /** Descarta lo acumulado (tras cancelar la línea con Ctrl+C por un fallo del audit). */
  reset(): void {
    this.line = '';
    this.decoder = new StringDecoder('utf8');
    this.escape = 'none';
  }

  private takeLine(): string | null {
    this.line += this.decoder.end();
    const line = this.line.replace(/\s+/g, ' ').trim();
    this.line = '';
    return line.length > 0 ? line : null;
  }

  private consumeEscape(byte: number): void {
    if (this.escape === 'esc') {
      if (byte === 0x5b) this.escape = 'csi';
      else if (byte === 0x4f) this.escape = 'ss3';
      else this.escape = 'none';
      return;
    }
    if (this.escape === 'csi') {
      // Parámetros (0x30-0x3f) e intermedios (0x20-0x2f) siguen; 0x40-0x7e cierra.
      if (byte >= 0x40 && byte <= 0x7e) this.escape = 'none';
      return;
    }
    this.escape = 'none';
  }

  private applyKey(byte: number): void {
    if (byte === BACKSPACE || byte === DEL) {
      this.line = Array.from(this.line).slice(0, -1).join('');
      return;
    }
    if (byte === CTRL_C || byte === CTRL_U) {
      this.line = '';
      this.decoder = new StringDecoder('utf8');
      return;
    }
    if (byte === CTRL_W) {
      this.line = this.line.replace(/\s*\S*$/, '');
      return;
    }
    if (byte < 0x20) return;
    const text = this.decoder.write(Buffer.from([byte]));
    if (this.line.length < MAX_LINE_CHARS) this.line += text;
  }
}
