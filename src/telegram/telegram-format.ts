/**
 * Convierte el Markdown que escribe el LLM al subconjunto de HTML que acepta
 * Telegram (`parse_mode: 'HTML'`), y trocea el resultado al límite de mensaje.
 *
 * Por qué existe: las respuestas del agente se enviaban como texto plano, así
 * que el owner veía `**negrita**` y `` `código` `` literales. El `parse_mode:
 * 'Markdown'` de Telegram NO sirve para esto: es el "Markdown" legacy, se rompe
 * con cualquier `_` o `*` suelto (nombres de tools como `read_emails`, listas)
 * y devuelve 400 "can't parse entities". HTML es estricto pero predecible.
 *
 * SEGURIDAD -- el texto del LLM puede contener contenido NO CONFIABLE (un correo
 * o un anuncio de Canvas colado por prompt injection). Por eso:
 *  1. **Todo** el texto se escapa (`& < >`) ANTES de generar ninguna etiqueta:
 *     las únicas etiquetas que existen en la salida son las que este módulo
 *     emite, de una lista cerrada (`b i s u code pre blockquote`). Un `<a>` o un
 *     `<script>` del modelo llega como texto inerte.
 *  2. **Nunca se emite `<a href>`**. Un enlace Markdown `[Tu banco](https://x)`
 *     ocultaría el destino real detrás de un texto engañoso (phishing dentro del
 *     chat de confianza del owner). Se muestra `Tu banco (https://x)`: la URL
 *     queda visible y Telegram la vuelve tocable por su cuenta.
 *  3. El resultado se envía con un respaldo a texto plano (ver
 *     `TelegramBotService.replyRich`): si Telegram rechaza el HTML, el mensaje NO se pierde.
 */

/** Límite real de Telegram es 4096 caracteres; margen para las etiquetas. */
export const TELEGRAM_CHUNK_LIMIT = 3900;

export const escapeHtml = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** Marcadores privados (caracteres de uso privado Unicode) para proteger código. */
const OPEN = '\uE000';
const CLOSE = '\uE001';

export function markdownToTelegramHtml(markdown: string): string {
  const protectedBlocks: string[] = [];
  const stash = (html: string): string => {
    protectedBlocks.push(html);
    return `${OPEN}${protectedBlocks.length - 1}${CLOSE}`;
  };

  // Los marcadores internos son caracteres de uso privado: si el texto (que puede
  // venir de contenido no confiable) trae los suyos, se restituiría en su
  // posición un bloque de código AJENO. Se eliminan de la entrada.
  let text = markdown
    .replaceAll('\r\n', '\n')
    .replaceAll(/[\uE000\uE001]/g, '');

  // 1) Bloques de código: su contenido va literal, sin ningún otro formateo.
  text = text.replace(
    /```([A-Za-z0-9_+-]*)[^\S\n]*\n?([\s\S]*?)```/g,
    (_match, language: string, code: string) => {
      const body = escapeHtml(code.replace(/\n$/, ''));
      return stash(
        language
          ? `<pre><code class="language-${escapeHtml(language)}">${body}</code></pre>`
          : `<pre>${body}</pre>`,
      );
    },
  );

  // 2) Tablas de Markdown (`| a | b |`): Telegram no las renderiza, y en
  //    proporcional se desalinean. Monoespaciadas se leen.
  text = text.replace(/(?:^\|.*\|[^\S\n]*(?:\n|$))+/gm, (table) =>
    stash(`<pre>${escapeHtml(table.replace(/\n$/, ''))}</pre>`),
  );

  // 3) Código en línea.
  text = text.replace(/`([^`\n]+)`/g, (_match, code: string) =>
    stash(`<code>${escapeHtml(code)}</code>`),
  );

  // 4) Todo lo demás se escapa ANTES de introducir etiquetas propias.
  text = escapeHtml(text);

  // 5) Enlaces `[texto](url)` -> `texto (url)`. Nunca <a href> (ver cabecera).
  text = text.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_match, label: string, url: string) =>
      label.trim() === url ? url : `${label} (${url})`,
  );

  // 6) Encabezados `# Título` -> negrita (Telegram no tiene encabezados).
  text = text.replace(
    /^[^\S\n]{0,3}#{1,6}[^\S\n]+(.+?)[^\S\n]*#*[^\S\n]*$/gm,
    '<b>$1</b>',
  );

  // 7) Reglas horizontales.
  text = text.replace(
    /^[^\S\n]*(?:-{3,}|\*{3,}|_{3,})[^\S\n]*$/gm,
    '──────────',
  );

  // 8) Citas `> texto` (ya escapado: `&gt;`).
  text = text.replace(/^&gt;[^\S\n]?(.*)$/gm, '<blockquote>$1</blockquote>');
  text = text.replaceAll('</blockquote>\n<blockquote>', '\n');

  // 9) Viñetas `- x` / `* x` / `+ x` -> `• x` (ANTES de la cursiva, para que un
  //    `* ` de lista no se lea como apertura de cursiva).
  text = text.replace(/^([^\S\n]*)[-*+][^\S\n]+/gm, '$1• ');

  // 10) Énfasis. Negrita antes que cursiva; `_` solo en fronteras de palabra
  //     para no romper `read_emails` ni `snake_case`.
  text = text.replace(/\*\*([^\n*]+?)\*\*/g, '<b>$1</b>');
  text = text.replace(
    /(?<![\p{L}\p{N}_])__([^\n_]+?)__(?![\p{L}\p{N}_])/gu,
    '<b>$1</b>',
  );
  text = text.replace(/~~([^\n~]+?)~~/g, '<s>$1</s>');
  text = text.replace(
    /(?<![\p{L}\p{N}*])\*([^\s*][^\n*]*?)\*(?![\p{L}\p{N}*])/gu,
    '<i>$1</i>',
  );
  text = text.replace(
    /(?<![\p{L}\p{N}_])_([^\s_][^\n_]*?)_(?![\p{L}\p{N}_])/gu,
    '<i>$1</i>',
  );

  // 11) Restituir el código protegido.
  return text.replace(
    new RegExp(`${OPEN}(\\d+)${CLOSE}`, 'g'),
    (_match, index: string) => protectedBlocks[Number(index)] ?? '',
  );
}

/**
 * Trocea al límite de Telegram cortando en saltos de línea. Un bloque `<pre>`
 * que cae en el corte se cierra y se reabre para que cada trozo sea HTML
 * válido por sí solo.
 */
export function splitForTelegram(
  html: string,
  limit: number = TELEGRAM_CHUNK_LIMIT,
): string[] {
  if (html.length <= limit) return [html];

  const chunks: string[] = [];
  let current = '';
  let inPre = false;

  const flush = () => {
    if (current.trim().length === 0) return;
    chunks.push(inPre ? `${current}</pre>` : current);
    current = inPre ? '<pre>' : '';
  };

  for (const line of html.split('\n')) {
    // Una línea sola más larga que el límite (p. ej. una URL enorme): se parte.
    const pieces =
      line.length > limit
        ? (line.match(new RegExp(`[\\s\\S]{1,${limit}}`, 'g')) ?? [line])
        : [line];

    for (const piece of pieces) {
      if (current.length + piece.length + 1 > limit) flush();
      current += (current.length > 0 ? '\n' : '') + piece;
      const opens = (piece.match(/<pre>|<pre /g) ?? []).length;
      const closes = (piece.match(/<\/pre>/g) ?? []).length;
      if (opens > closes) inPre = true;
      if (closes > opens) inPre = false;
    }
  }

  if (current.trim().length > 0) chunks.push(current);
  return chunks;
}

/** Pie con el/los modelo(s) que respondieron. Vacío si no hay dato. */
export function modelFooter(modelsUsed: readonly string[] | undefined): string {
  if (!modelsUsed || modelsUsed.length === 0) return '';
  const [first, ...rest] = modelsUsed;
  const chain = rest.length > 0 ? [first, ...rest].join(' → ') : first;
  return `🤖 ${chain}`;
}

/**
 * Versión en texto plano de un trozo de HTML de Telegram: quita las etiquetas y
 * deshace el escape. Es el respaldo cuando Telegram rechaza el HTML (400 "can't
 * parse entities"): el mensaje llega igual, solo que sin formato.
 */
export function htmlToPlain(html: string): string {
  return html
    .replaceAll(/<[^>]+>/g, '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}
