import { describe, expect, it } from 'vitest';
import { PtyInputGate } from './pty-input-gate';

const buf = (text: string): Buffer => Buffer.from(text, 'utf8');
const lines = (gate: PtyInputGate, ...chunks: string[]): (string | null)[] =>
  chunks.flatMap((chunk) => gate.feed(buf(chunk)).map((step) => step.line));

describe('PtyInputGate (línea tecleada → audit antes del Enter)', () => {
  it('teclas sueltas se reenvían sin auditar; la línea sale recién con el Enter', () => {
    const gate = new PtyInputGate();
    const typing = gate.feed(buf('npm ins'));
    expect(typing).toEqual([{ bytes: buf('npm ins'), line: null }]);

    const done = gate.feed(buf('tall\r'));
    expect(done).toEqual([{ bytes: buf('tall\r'), line: 'npm install' }]);
  });

  it('los bytes del Enter viajan en el mismo paso que la línea (se retienen juntos)', () => {
    const gate = new PtyInputGate();
    const [step] = gate.feed(buf('ls -la\r'));
    expect(step?.line).toBe('ls -la');
    expect(step?.bytes.toString()).toBe('ls -la\r');
  });

  it('un pegado con varias líneas produce un paso por línea, en orden', () => {
    const gate = new PtyInputGate();
    const steps = gate.feed(buf('cd app\nnpm i\nnpm run build\n'));
    expect(steps.map((s) => s.line)).toEqual([
      'cd app',
      'npm i',
      'npm run build',
    ]);
    expect(Buffer.concat(steps.map((s) => s.bytes)).toString()).toBe(
      'cd app\nnpm i\nnpm run build\n',
    );
  });

  it('un Enter con la línea vacía no se audita (pero se reenvía)', () => {
    const gate = new PtyInputGate();
    expect(gate.feed(buf('\r'))).toEqual([{ bytes: buf('\r'), line: null }]);
    expect(lines(new PtyInputGate(), '   \r')).toEqual([null]);
  });

  it('\\r\\n cuenta como una línea y una vacía, sin auditar dos veces', () => {
    const gate = new PtyInputGate();
    expect(gate.feed(buf('ls\r\n')).map((s) => s.line)).toEqual(['ls', null]);
  });

  it('borrar (Backspace/DEL) corrige la línea', () => {
    const gate = new PtyInputGate();
    expect(lines(gate, 'lss\x7f\r')).toEqual(['ls']);
    expect(lines(gate, 'cat\x08\x08\x08pwd\r')).toEqual(['pwd']);
  });

  it('borrar respeta caracteres de varios bytes (no rompe UTF-8)', () => {
    const gate = new PtyInputGate();
    expect(lines(gate, 'echo ñ\x7fa\r')).toEqual(['echo a']);
  });

  it('Ctrl+U y Ctrl+C descartan lo tecleado; Ctrl+W borra la última palabra', () => {
    expect(lines(new PtyInputGate(), 'rm -rf x\x15ls\r')).toEqual(['ls']);
    expect(lines(new PtyInputGate(), 'sleep 100\x03echo hola\r')).toEqual([
      'echo hola',
    ]);
    expect(lines(new PtyInputGate(), 'git commit -m fix\x17\r')).toEqual([
      'git commit -m',
    ]);
  });

  it('las flechas y otras secuencias de escape no entran a la línea', () => {
    const gate = new PtyInputGate();
    expect(lines(gate, 'ls\x1b[A\x1b[B\x1b[1;5C -l\x1bOA\r')).toEqual([
      'ls -l',
    ]);
  });

  it('una secuencia de escape partida entre dos mensajes no se cuela como texto', () => {
    const gate = new PtyInputGate();
    expect(
      lines(gate, 'ls\x1b', '[', 'A', '\r').filter((line) => line !== null),
    ).toEqual(['ls']);
  });

  it('un carácter UTF-8 partido entre dos mensajes se reensambla', () => {
    const gate = new PtyInputGate();
    const bytes = Buffer.from('echo ñ\r');
    const cut = bytes.indexOf(0xc3) + 1;
    const first = gate.feed(bytes.subarray(0, cut));
    const second = gate.feed(bytes.subarray(cut));
    expect([...first, ...second].map((s) => s.line)).toEqual([null, 'echo ñ']);
  });

  it('una línea larguísima no acumula sin tope', () => {
    const gate = new PtyInputGate();
    const [step] = gate.feed(buf(`${'a'.repeat(100_000)}\r`));
    expect(step?.line?.length).toBeLessThanOrEqual(4096);
    expect(step?.bytes.length).toBe(100_001);
  });

  it('normaliza los espacios repetidos en el texto a auditar', () => {
    expect(lines(new PtyInputGate(), 'npm    run   dev\r')).toEqual([
      'npm run dev',
    ]);
  });

  it('Tab no entra a la línea (en el shell es autocompletar, no un espacio)', () => {
    expect(lines(new PtyInputGate(), 'ls\t\r')).toEqual(['ls']);
  });

  it('reset() descarta la línea a medias (tras un fallo del audit)', () => {
    const gate = new PtyInputGate();
    gate.feed(buf('rm -rf /'));
    gate.reset();
    expect(lines(gate, 'ls\r')).toEqual(['ls']);
  });
});
