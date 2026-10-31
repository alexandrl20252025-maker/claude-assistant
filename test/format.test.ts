import assert from "node:assert/strict";
import { test } from "node:test";
import { markdownToTelegramHtml, splitMarkdown, toTelegramMessages } from "../src/format";

test("жирный, курсив, код, ссылки, заголовки, списки", () => {
  const html = markdownToTelegramHtml(
    "# Итог\n**Важно**: срок _3 дня_, см. `ст. 18.8` и [КоАП](https://example.com/a?b=1&c=2)\n- пункт один\n* пункт два",
  );
  assert.equal(
    html,
    '<b>Итог</b>\n<b>Важно</b>: срок <i>3 дня</i>, см. <code>ст. 18.8</code> и <a href="https://example.com/a?b=1&amp;c=2">КоАП</a>\n• пункт один\n• пункт два',
  );
});

test("экранирует < > & и не ломает snake_case", () => {
  assert.equal(markdownToTelegramHtml("a < b & c > d, file_name_here"), "a &lt; b &amp; c &gt; d, file_name_here");
});

test("блок кода и таблица", () => {
  const html = markdownToTelegramHtml("```python\nx = 1 < 2\n```\n| Страна | Срок |\n|---|---|\n| Грузия | 365 |");
  assert.equal(html, '<pre><code class="language-python">x = 1 &lt; 2</code></pre>\n<pre>Страна | Срок\nГрузия | 365</pre>');
});

test("цитата и разделитель", () => {
  assert.equal(markdownToTelegramHtml("> цитата **важная**\n---"), "<blockquote>цитата <b>важная</b></blockquote>\n──────────");
});

test("длинный текст режется на куски, каждый влезает в Telegram", () => {
  const para = "Абзац с текстом. ".repeat(40);
  const md = Array.from({ length: 20 }, (_, i) => `## Раздел ${i}\n${para}`).join("\n\n");
  const parts = toTelegramMessages(md);
  assert.ok(parts.length > 1);
  for (const p of parts) {
    assert.ok(p.html.length > 0 && p.html.length <= 4096, `длина ${p.html.length}`);
  }
  assert.equal(parts.map((p) => p.plain).join("").replace(/\s/g, "").length, md.replace(/\s/g, "").length);
});

test("разрез внутри блока кода закрывает и снова открывает блок", () => {
  const code = Array.from({ length: 400 }, (_, i) => `line ${i} ${"x".repeat(10)}`).join("\n");
  const chunks = splitMarkdown("```\n" + code + "\n```", 1000);
  assert.ok(chunks.length > 2);
  for (const c of chunks) {
    const fences = c.split("\n").filter((l) => l.trim().startsWith("```")).length;
    assert.equal(fences % 2, 0, "непарные ограждения кода в куске:\n" + c.slice(0, 80));
  }
});
