/**
 * cURL 文本解析：把 "Copy as cURL" 出来的命令还原成
 * { method, url, headers, body }，供重放模式使用。
 *
 * 兼容三种常见格式：
 *   bash        curl 'https://…' -H 'a: b' --data-raw '{"x":1}'
 *   cmd         curl "https://…" -H "a: b" --data-raw "{\"x\":1}"
 *   powershell  curl.exe 'https://…' -H 'a: b'
 *
 * 这是"接口改版逃生舱"的基础：只要还能在浏览器里复制到请求，就还能继续导出。
 */

const VALUE_FLAGS = new Map([
  ['-h', 'header'],
  ['--header', 'header'],
  ['-x', 'method'],
  ['--request', 'method'],
  ['-d', 'data'],
  ['--data', 'data'],
  ['--data-raw', 'data'],
  ['--data-binary', 'data'],
  ['--data-urlencode', 'data'],
  ['-b', 'cookie'],
  ['--cookie', 'cookie'],
  ['-u', 'user'],
  ['--user', 'user'],
  ['--url', 'url'],
]);

/**
 * @param {string} text 粘贴的 cURL 命令
 * @returns {{url: string, method: string, headers: Array<{name: string, value: string}>, body: string|null}}
 */
export function parseCurl(text) {
  if (!text || typeof text !== 'string') throw new Error('cURL 内容为空');

  const tokens = tokenize(normalize(text));
  if (tokens.length === 0) throw new Error('cURL 内容为空');

  let url = '';
  let method = '';
  let body = null;
  const headers = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];

    if (i === 0 && /^curl(\.exe)?$/i.test(token)) continue;

    if (token.startsWith('-')) {
      const kind = VALUE_FLAGS.get(token.toLowerCase());
      if (!kind) continue; // 忽略 --compressed、-s 这类无值开关

      const value = tokens[i + 1];
      if (value === undefined) continue;
      i += 1;

      switch (kind) {
        case 'header': {
          const idx = value.indexOf(':');
          if (idx > 0) {
            headers.push({ name: value.slice(0, idx).trim(), value: value.slice(idx + 1).trim() });
          }
          break;
        }
        case 'method':
          method = value.trim().toUpperCase();
          break;
        case 'data':
          body = body ? `${body}&${value}` : value;
          break;
        case 'cookie':
          headers.push({ name: 'Cookie', value: value.trim() });
          break;
        case 'url':
          url = value.trim();
          break;
        default:
          break;
      }
      continue;
    }

    if (!url && /^https?:\/\//i.test(token)) url = token;
  }

  if (!url) throw new Error('没能从 cURL 里找到 URL（请确认复制的是浏览器 Network 面板里的请求）');
  if (!method) method = body === null ? 'GET' : 'POST';

  return { url, method, headers: dedupeHeaders(headers), body };
}

/** 把多行命令拼成一行，处理行尾续行符。 */
function normalize(text) {
  let s = text.replace(/\r\n?/g, '\n').trim();
  s = s.replace(/\\\n\s*/g, ' '); // 反斜杠续行
  s = s.replace(/\^\n\s*/g, ' '); // cmd 续行
  s = s.replace(/`\n\s*/g, ' '); // powershell 续行
  return s.replace(/\n\s*/g, ' ');
}

/** 按引号切词，保留引号内的空格。 */
function tokenize(text) {
  const tokens = [];
  let current = '';
  let quote = null;
  let hasContent = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && quote === '"' && i + 1 < text.length && /["\\]/.test(text[i + 1])) {
        current += text[i + 1];
        i += 1;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      hasContent = true;
      continue;
    }

    // 引号之外的 \' 是 bash 的转义单引号（形如 'it'\''s'），要还原成字面字符
    if (ch === '\\' && i + 1 < text.length && /['"\\]/.test(text[i + 1])) {
      current += text[i + 1];
      i += 1;
      hasContent = true;
      continue;
    }

    if (/\s/.test(ch)) {
      if (hasContent) {
        tokens.push(current);
        current = '';
        hasContent = false;
      }
      continue;
    }

    current += ch;
    hasContent = true;
  }

  if (hasContent) tokens.push(current);
  return tokens;
}

function dedupeHeaders(headers) {
  const seen = new Map();
  for (const header of headers) seen.set(header.name.toLowerCase(), header);
  return [...seen.values()];
}

export function getHeader(headers, name) {
  const target = name.toLowerCase();
  const hit = (headers || []).find((h) => h.name.toLowerCase() === target);
  return hit ? hit.value : null;
}

/**
 * 用一条"列表请求"的 cURL 推导出"取消息请求"：
 * 换掉 path 和 query，其余（cookie、自定义鉴权头、x-client-* 等）原样保留。
 */
export function deriveMessagesRequest(curl, sessionId) {
  const url = new URL(curl.url);
  url.pathname = '/api/v0/chat/history_messages';
  url.search = '';
  url.searchParams.set('chat_session_id', String(sessionId));
  return {
    url: url.toString(),
    method: 'GET',
    headers: curl.headers.filter((h) => !/^content-length$/i.test(h.name)),
    body: null,
  };
}

/** 汇总成一行可读描述，用于日志。 */
export function describeCurl(curl) {
  const url = new URL(curl.url);
  return `${curl.method} ${url.origin}${url.pathname}${url.search}`;
}
