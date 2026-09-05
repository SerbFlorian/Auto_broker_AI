/**
 * Telegram HTML helpers — safer than Markdown for AI / user-generated text.
 * Markdown breaks on unmatched _, *, `, [ from GPT replies.
 */

export function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Escape for use inside href="..." */
export function escapeHtmlAttr(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

export function htmlBold(text: string): string {
  return `<b>${escapeHtml(text)}</b>`;
}

export function htmlItalic(text: string): string {
  return `<i>${escapeHtml(text)}</i>`;
}

export function htmlLink(label: string, url: string): string {
  return `<a href="${escapeHtmlAttr(url)}">${escapeHtml(label)}</a>`;
}

/**
 * Convert light Markdown from the AI into Telegram HTML.
 * Escapes all model text; only emits our own <b>/<i>/<code> tags.
 * Strips leftover # / ** so they never show as raw characters.
 */
export function aiReplyToTelegramHtml(raw: string): string {
  const lines = String(raw ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  const out: string[] = [];

  for (const line of lines) {
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push('');
      continue;
    }

    const header = line.match(/^\s{0,3}#{1,6}\s+(.*?)\s*$/);
    if (header) {
      const title = stripResidualMd(header[1] || '').trim();
      out.push(title ? htmlBold(title) : '');
      continue;
    }

    out.push(inlineMdToHtml(line));
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function stripResidualMd(s: string): string {
  return s
    .replace(/\*\*/g, '')
    .replace(/__/g, '')
    .replace(/`/g, '')
    .replace(/^#+\s*/, '')
    .replace(/#{1,6}/g, '');
}

function inlineMdToHtml(line: string): string {
  const tokens: string[] = [];
  const park = (html: string): string => {
    const i = tokens.length;
    tokens.push(html);
    return `\u0000T${i}\u0000`;
  };

  let s = line;

  s = s.replace(/`([^`]+)`/g, (_m, code: string) =>
    park(`<code>${escapeHtml(code)}</code>`)
  );

  s = s.replace(/\*\*([^*]+)\*\*/g, (_m, bold: string) =>
    park(`<b>${escapeHtml(bold)}</b>`)
  );
  s = s.replace(/__([^_]+)__/g, (_m, bold: string) =>
    park(`<b>${escapeHtml(bold)}</b>`)
  );

  // Italic *…* (avoid treating list markers as italic)
  s = s.replace(/(^|[^*\n])\*([^*\n]+)\*(?!\*)/g, (_m, pre: string, ital: string) =>
    `${pre}${park(`<i>${escapeHtml(ital)}</i>`)}`
  );

  s = s.replace(/#{1,6}/g, '').replace(/\*\*/g, '').replace(/__/g, '');

  let escaped = escapeHtml(s);
  escaped = escaped.replace(/\u0000T(\d+)\u0000/g, (_m, i: string) => tokens[Number(i)] || '');
  return escaped;
}
