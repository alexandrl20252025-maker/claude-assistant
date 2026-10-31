// Markdown (как пишет агент) -> HTML, который понимает Telegram.
// Telegram HTML поддерживает: <b> <i> <s> <u> <a> <code> <pre> <blockquote>.

const TG_LIMIT = 4096;
const CHUNK_SOURCE_LIMIT = 3300; // запас под HTML-теги и &amp;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

/** Inline-разметка внутри одной строки (без блоков кода). */
function inline(text: string): string {
  const slots: string[] = [];
  const keep = (html: string) => `\u0000${slots.push(html) - 1}\u0000`;

  // `код`
  let s = text.replace(/`([^`\n]+)`/g, (_, c: string) => keep(`<code>${escapeHtml(c)}</code>`));
  // [текст](url)
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t: string, u: string) =>
    keep(`<a href="${escapeAttr(u)}">${escapeHtml(t)}</a>`),
  );
  s = escapeHtml(s);
  s = s.replace(/\*\*(?=\S)([^*\n]+?)\*\*/g, "<b>$1</b>");
  s = s.replace(/__(?=\S)([^_\n]+?)__/g, "<b>$1</b>");
  s = s.replace(/~~(?=\S)([^~\n]+?)~~/g, "<s>$1</s>");
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*\n]+?)\*(?=[^\w*]|$)/g, "$1<i>$2</i>");
  s = s.replace(/(^|[^\w])_(?=\S)([^_\n]+?)_(?=[^\w]|$)/g, "$1<i>$2</i>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => slots[Number(i)]);
}

/** Полный Markdown-фрагмент -> Telegram HTML. */
export function markdownToTelegramHtml(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // ```блок кода```
    const fence = line.match(/^\s*```\s*([\w+-]*)\s*$/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++; // закрывающий ```
      const lang = fence[1] ? ` class="language-${escapeAttr(fence[1])}"` : "";
      out.push(`<pre><code${lang}>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    // Таблица | a | b | -> моноширинный блок (Telegram не рисует таблицы)
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) {
          rows.push(
            lines[i]
              .trim()
              .replace(/^\||\|$/g, "")
              .split("|")
              .map((c) => c.trim())
              .join(" | "),
          );
        }
        i++;
      }
      out.push(`<pre>${escapeHtml(rows.join("\n"))}</pre>`);
      continue;
    }

    // > цитата
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(inline(lines[i++].replace(/^\s*>\s?/, "")));
      out.push(`<blockquote>${quote.join("\n")}</blockquote>`);
      continue;
    }

    const heading = line.match(/^\s*#{1,6}\s+(.*)$/);
    if (heading) {
      out.push(`<b>${inline(heading[1].replace(/\s*#+\s*$/, ""))}</b>`);
    } else if (/^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line)) {
      out.push("──────────");
    } else {
      const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
      out.push(bullet ? `${bullet[1]}• ${inline(bullet[2])}` : inline(line));
    }
    i++;
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Режет Markdown на куски, каждый из которых после конвертации влезает в одно
 * сообщение Telegram. Режет по абзацам/строкам и не рвёт блоки кода.
 */
export function splitMarkdown(md: string, limit = CHUNK_SOURCE_LIMIT): string[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const chunks: string[] = [];
  let cur: string[] = [];
  let curLen = 0;
  let inFence: string | null = null;

  const flush = () => {
    if (!cur.length) return;
    if (inFence) cur.push("```");
    chunks.push(cur.join("\n").trim());
    cur = inFence ? [inFence] : [];
    curLen = cur.join("\n").length;
  };

  for (let line of lines) {
    // Слишком длинная строка — режем её на части
    while (line.length > limit) {
      if (curLen) flush();
      cur.push(line.slice(0, limit));
      curLen = limit;
      flush();
      line = line.slice(limit);
    }
    const isBlankBoundary = line.trim() === "" && !inFence;
    if (curLen + line.length + 1 > limit || (isBlankBoundary && curLen > limit * 0.8)) flush();
    cur.push(line);
    curLen += line.length + 1;
    const f = line.match(/^\s*```/);
    if (f) inFence = inFence ? null : line.trim();
  }
  inFence = null;
  flush();
  return chunks.filter((c) => c.trim().length > 0);
}

/** Готовые к отправке HTML-сообщения. */
export function toTelegramMessages(md: string): { html: string; plain: string }[] {
  return splitMarkdown(md).map((chunk) => {
    const html = markdownToTelegramHtml(chunk);
    return { html: html.length <= TG_LIMIT ? html : "", plain: chunk.slice(0, TG_LIMIT) };
  });
}
