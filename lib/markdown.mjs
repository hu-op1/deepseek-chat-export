/**
 * 极简 Markdown → HTML。
 *
 * 只有一个要求：**安全**。对话正文里可能出现任何内容（含 HTML、脚本片段），
 * 所以一律先转义再处理格式。宁可少支持几种语法，也不能让 ${'<script>'} 活着走出去。
 */

export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

const BLOCK_TOKEN = '\u0000CODEBLOCK';

/**
 * @param {string} src
 * @returns {string} 已转义的 HTML
 */
export function renderMarkdown(src) {
  if (!src || typeof src !== 'string') return '';

  // 1) 先把围栏代码块抽出来，避免里面的内容被行内规则改写
  const blocks = [];
  let text = src.replace(/```([\w+#.-]*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    const index = blocks.length;
    blocks.push(
      `<pre class="code"><code data-lang="${escapeHtml(lang || '')}">${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`,
    );
    return `${BLOCK_TOKEN}${index}\u0000`;
  });

  // 2) 其余内容整体转义
  text = escapeHtml(text);

  // 3) 行内格式
  text = text.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|[\s(])\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1<a href="$3" target="_blank" rel="noreferrer">$2</a>');

  // 4) 分块：标题、列表、普通段落
  const out = [];
  for (const rawBlock of text.split(/\n{2,}/)) {
    const block = rawBlock.trim();
    if (!block) continue;

    if (block.startsWith(`${BLOCK_TOKEN}`)) {
      out.push(block); // 占位符，最后统一还原
      continue;
    }

    const heading = block.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = Math.min(4, heading[1].length + 1);
      out.push(`<h${level}>${heading[2]}</h${level}>`);
      continue;
    }

    const lines = block.split('\n');
    if (lines.every((line) => /^\s*[-*•]\s+/.test(line))) {
      out.push(`<ul>${lines.map((line) => `<li>${line.replace(/^\s*[-*•]\s+/, '')}</li>`).join('')}</ul>`);
      continue;
    }
    if (lines.every((line) => /^\s*\d+[.)]\s+/.test(line))) {
      out.push(`<ol>${lines.map((line) => `<li>${line.replace(/^\s*\d+[.)]\s+/, '')}</li>`).join('')}</ol>`);
      continue;
    }

    out.push(`<p>${block.replace(/\n/g, '<br>')}</p>`);
  }

  // 5) 还原代码块
  return out
    .join('\n')
    .replace(new RegExp(`${BLOCK_TOKEN}(\\d+)\\u0000`, 'g'), (_m, index) => blocks[Number(index)] ?? '');
}
