import { describe, expect, it } from 'vitest';
import {
  htmlToPlain,
  markdownToTelegramHtml,
  modelFooter,
  splitForTelegram,
  TELEGRAM_CHUNK_LIMIT,
} from './telegram-format';

const md = markdownToTelegramHtml;

describe('markdownToTelegramHtml — formato', () => {
  it('negrita, cursiva y tachado', () => {
    expect(md('**negrita** y *cursiva* y ~~tachado~~')).toBe(
      '<b>negrita</b> y <i>cursiva</i> y <s>tachado</s>',
    );
  });

  it('código en línea y bloques de código, con el contenido literal', () => {
    expect(md('usa `readEmails` ahora')).toBe(
      'usa <code>readEmails</code> ahora',
    );
    expect(md('```ts\nconst a = 1 < 2 && **x**;\n```')).toBe(
      '<pre><code class="language-ts">const a = 1 &lt; 2 &amp;&amp; **x**;</code></pre>',
    );
    expect(md('```\nsin lenguaje\n```')).toBe('<pre>sin lenguaje</pre>');
  });

  it('viñetas con - * + se convierten en • y no se leen como cursiva', () => {
    expect(md('- uno\n* dos\n+ tres')).toBe('• uno\n• dos\n• tres');
    expect(md('* **Correo**: leer')).toBe('• <b>Correo</b>: leer');
  });

  it('encabezados pasan a negrita', () => {
    expect(md('# Título\n## Sub')).toBe('<b>Título</b>\n<b>Sub</b>');
  });

  it('el guion bajo de un identificador NO se toma por cursiva', () => {
    expect(md('la tool read_emails y snake_case_name')).toBe(
      'la tool read_emails y snake_case_name',
    );
    expect(md('_cursiva real_')).toBe('<i>cursiva real</i>');
  });

  it('las tablas se muestran monoespaciadas', () => {
    expect(md('| a | b |\n|---|---|\n| 1 | 2 |')).toBe(
      '<pre>| a | b |\n|---|---|\n| 1 | 2 |</pre>',
    );
  });

  it('citas y reglas horizontales', () => {
    expect(md('> cita\n> dos')).toBe('<blockquote>cita\ndos</blockquote>');
    expect(md('antes\n---\ndespués')).toBe('antes\n──────────\ndespués');
  });

  it('un mensaje de chat típico (el de la captura) queda sin asteriscos ni backticks sueltos', () => {
    const out = md(
      '**📧 Correo (Gmail)**\n- Leer y buscar correos (`readEmails`)\n- Enviar correos (con tu aprobación)',
    );
    expect(out).toBe(
      '<b>📧 Correo (Gmail)</b>\n• Leer y buscar correos (<code>readEmails</code>)\n• Enviar correos (con tu aprobación)',
    );
    expect(out).not.toContain('**');
    expect(out).not.toContain('`');
  });
});

describe('markdownToTelegramHtml — SEGURIDAD (el texto del LLM puede venir de contenido no confiable)', () => {
  it('HTML del modelo llega como texto inerte: nada de etiquetas propias del atacante', () => {
    const out = md(
      '<script>alert(1)</script> <b onclick="x">hola</b> <img src=x>',
    );
    expect(out).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt; &lt;b onclick="x"&gt;hola&lt;/b&gt; &lt;img src=x&gt;',
    );
    expect(out).not.toMatch(/<(?!\/?(?:b|i|s|u|code|pre|blockquote)[ >])/);
  });

  it('un <a href> escrito por el modelo NO se convierte en enlace', () => {
    const out = md('<a href="https://evil.example">click</a>');
    expect(out).not.toContain('<a');
    expect(out).toContain('&lt;a href=');
  });

  it('un enlace Markdown muestra la URL real: el texto no puede ocultar el destino', () => {
    const out = md('[Tu banco](https://evil.example/login)');
    expect(out).toBe('Tu banco (https://evil.example/login)');
    expect(out).not.toContain('<a');
    expect(out).not.toContain('href');
  });

  it('un enlace con texto igual a la URL no se duplica', () => {
    expect(md('[https://x.example](https://x.example)')).toBe(
      'https://x.example',
    );
  });

  it('solo se reconocen enlaces http(s): javascript: y data: quedan como texto', () => {
    const out = md('[x](javascript:alert(1)) [y](data:text/html,hola)');
    expect(out).not.toContain('<a');
    expect(out).toContain('[x](javascript:alert(1))');
  });

  it('el contenido de un bloque de código se escapa, sin importar lo que contenga', () => {
    const out = md('```\n</pre><b>rompe</b>\n```');
    expect(out).toBe('<pre>&lt;/pre&gt;&lt;b&gt;rompe&lt;/b&gt;</pre>');
  });

  it('el marcador interno de código no se puede falsificar desde el texto', () => {
    // Si el texto trae los marcadores privados, antes se restituía en esa posición
    // un bloque de código AJENO (aquí, el `codigo` de más abajo).
    const forged = '\uE000' + '0' + '\uE001';
    const out = md(`${forged} y \`codigo\``);
    expect(out).toBe('0 y <code>codigo</code>');
    expect(out).not.toMatch(/[\uE000\uE001]/);
  });

  it('el atributo class del lenguaje se escapa (no se puede inyectar un atributo)', () => {
    // El lenguaje solo admite [A-Za-z0-9_+-]: un intento con comillas no abre el bloque con lenguaje.
    const out = md('```x" onmouseover="y\ncodigo\n```');
    expect(out).not.toContain('onmouseover="y"');
  });
});

describe('splitForTelegram', () => {
  it('un mensaje corto queda en un solo trozo', () => {
    expect(splitForTelegram('hola')).toEqual(['hola']);
  });

  it('parte por líneas y ningún trozo excede el límite', () => {
    const html = Array.from(
      { length: 400 },
      (_, i) => `línea número ${i} con algo de texto`,
    ).join('\n');
    const chunks = splitForTelegram(html);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_CHUNK_LIMIT);
    }
    expect(chunks.join('\n').replaceAll('\n', '')).toBe(
      html.replaceAll('\n', ''),
    );
  });

  it('una línea única mayor al límite (p. ej. una URL enorme) también se parte', () => {
    const chunks = splitForTelegram('x'.repeat(TELEGRAM_CHUNK_LIMIT * 2 + 10));
    expect(chunks.length).toBe(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_CHUNK_LIMIT);
    }
  });

  it('un <pre> cortado a mitad se cierra y se reabre: cada trozo es HTML válido', () => {
    const body = Array.from(
      { length: 300 },
      (_, i) => `código ${i} ${'y'.repeat(20)}`,
    ).join('\n');
    const chunks = splitForTelegram(`<pre>${body}</pre>`);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const opens = (chunk.match(/<pre>/g) ?? []).length;
      const closes = (chunk.match(/<\/pre>/g) ?? []).length;
      expect(opens).toBe(closes);
    }
  });
});

describe('modelFooter', () => {
  it('un solo modelo', () => {
    expect(modelFooter(['claude-sonnet-5'])).toBe('🤖 claude-sonnet-5');
  });

  it('varios modelos: se ve la cadena (hubo fallback en el turno)', () => {
    expect(modelFooter(['claude-sonnet-5', 'claude-haiku-4-5-20251001'])).toBe(
      '🤖 claude-sonnet-5 → claude-haiku-4-5-20251001',
    );
  });

  it('sin dato no inventa nada', () => {
    expect(modelFooter([])).toBe('');
    expect(modelFooter(undefined)).toBe('');
  });
});

describe('htmlToPlain', () => {
  it('quita etiquetas y deshace el escape (respaldo cuando Telegram rechaza el HTML)', () => {
    expect(htmlToPlain('<b>hola</b> a &lt; b &amp;&amp; c &gt; d')).toBe(
      'hola a < b && c > d',
    );
  });
});
