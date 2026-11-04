/**
 * token 获取与嗅探。
 *
 * 设计前提：我们无法保证 DeepSeek 把 token 存在 localStorage 的哪个键里，
 * 也可能把 token 包在 `{"value":"…","__version":"0"}` 这样的 JSON 字符串里。
 * 所以这里不绑定任何键名，而是用"形状识别"：
 *   1. 整段就是一个 token（用户直接复制的 token / Bearer xxx）
 *   2. 能从任意位置找到 JWT 形状的字符串
 *   3. 能递归解析 JSON，找到名字里带 token/auth/jwt 的字段
 */

import fs from 'node:fs';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
const SINGLE_TOKEN_RE = /^[A-Za-z0-9._~+/=-]{10,}$/;

/** 一眼就是登录凭证的字段名。DeepSeek 用的是 userToken。 */
const PRIMARY_KEY_RE = /^(user_?token|access_?token|auth_?token|token|authorization|bearer)$/i;
/** 名字里带 token 的次选。 */
const SECONDARY_KEY_RE = /token/i;

/**
 * 给候选值排优先级。这一步是关键：
 * DeepSeek 的 userToken 是 64 位不透明串，而 localStorage 里还有个叫 settingsJwt 的
 * 东西长得像 JWT——如果先按形状匹配 JWT，就会错抓 settingsJwt 当凭证。
 * 所以字段名的可信度必须高于"长得像 JWT"。
 */
function rankOf(key, value) {
  if (PRIMARY_KEY_RE.test(key || '')) return 0;
  if (SECONDARY_KEY_RE.test(key || '')) return 1;
  if (isJwtLike(value)) return 2;
  return 3;
}

/** 判断一个字符串是否"像是一个 token"（单行、无空格、够长）。 */
export function looksLikeToken(value) {
  return typeof value === 'string' && SINGLE_TOKEN_RE.test(value.trim());
}

/** 是否是 JWT 形状。 */
export function isJwtLike(value) {
  return typeof value === 'string' && /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.trim());
}

/**
 * 从用户粘贴的任意文本中提取 token。
 * @param {string} blob
 * @returns {string|null}
 */
export function findToken(blob) {
  if (!blob) return null;
  let text = String(blob).replace(/^\uFEFF/, '').trim();
  if (!text) return null;

  // 允许带引号粘贴
  text = stripWrappingQuotes(text);

  // 允许粘贴成 "Authorization: Bearer xxx"
  const bearer = text.match(/^(?:authorization\s*[:=]\s*)?Bearer\s+(.+)$/i);
  if (bearer) text = stripWrappingQuotes(bearer[1].trim());

  // 情况 1：整段就是一个 token
  if (looksLikeToken(text) && !text.startsWith('{') && !text.endsWith('}')) return text;

  // 情况 2：localStorage 导出的 JSON —— 按字段名可信度排序（字段名优先于"长得像 JWT"）
  const candidates = collectTokenCandidates(text);
  const ranked = candidates.find((item) => item.rank <= 2);
  if (ranked) return ranked.value;

  // 情况 3：不是 JSON，但里面混着 JWT，只能靠形状兜底
  const jwt = text.match(JWT_RE);
  if (jwt) return jwt[0];

  return null;
}

function stripWrappingQuotes(text) {
  const t = text.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * 递归扫描 JSON，收集所有"像登录凭证"的字符串，并按可信度排序。
 *
 * 两个细节：
 *   1. localStorage 的值常常是"序列化后的 JSON 字符串"，要下钻；
 *   2. `userToken` 的真实结构是 `{"value":"…","__version":"0"}`，
 *      下钻后字段名会变成 `value`，所以要把父字段名带下来。
 */
export function collectTokenCandidates(text) {
  let root;
  try {
    root = JSON.parse(text);
  } catch {
    return [];
  }

  const hits = [];
  const visit = (node, key, parentKey, depth) => {
    if (depth > 8) return;

    if (typeof node === 'string') {
      const value = node.trim();

      // 值是"序列化后的 JSON"时继续下钻，例如 localStorage 的单键 JSON 字符串
      if ((value.startsWith('{') && value.endsWith('}')) || (value.startsWith('[') && value.endsWith(']'))) {
        try {
          visit(JSON.parse(value), key, key, depth + 1);
        } catch {
          /* 不是合法 JSON，忽略 */
        }
        return;
      }

      if (!looksLikeToken(value)) return;
      // {"userToken": {"value": "…"}} → 用外层字段名作为可信度依据
      const effectiveKey = (key === 'value' || key === 'v') && parentKey ? parentKey : key;
      hits.push({ key: effectiveKey, value, rank: rankOf(effectiveKey, value) });
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node.slice(0, 64)) visit(item, key, parentKey, depth + 1);
      return;
    }

    if (node && typeof node === 'object') {
      for (const [childKey, childValue] of Object.entries(node)) {
        visit(childValue, childKey, key, depth + 1);
      }
    }
  };

  visit(root, '', '', 0);
  return hits.sort((a, b) => a.rank - b.rank);
}

/** 返回最可信的那个 token（保留旧接口给外部用）。 */
export function scanJsonForToken(text) {
  const best = collectTokenCandidates(text).find((item) => item.rank <= 2);
  return best ? best.value : null;
}

/** 打码后再打印，避免 token 出现在截图/日志里。 */
export function maskToken(token) {
  if (!token) return '(空)';
  if (token.length <= 16) return `${token.slice(0, 4)}****`;
  return `${token.slice(0, 8)}…${token.slice(-6)}（共 ${token.length} 字符）`;
}

/**
 * 按优先级取 token：命令行参数 → 本地缓存文件 → 交互粘贴。
 * @returns {Promise<{token: string, source: string}|null>}
 */
export async function resolveToken({ flagToken, tokenFile, allowPrompt = true, log = () => {} } = {}) {
  if (flagToken) {
    const token = findToken(flagToken);
    if (!token) throw new Error('--token 里没有识别出 token（既不是 JWT，也不像 token 字符串）');
    return { token, source: '--token' };
  }

  if (tokenFile && fs.existsSync(tokenFile)) {
    const token = findToken(fs.readFileSync(tokenFile, 'utf8'));
    if (token) return { token, source: '本地缓存 .token' };
    log('本地缓存的 .token 无法解析，将重新获取');
  }

  if (!allowPrompt) return null;

  printHowToCopy();
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question('把上面复制的整段内容粘贴到这里，回车：\n> ');
    const token = findToken(answer);
    if (!token) {
      throw new Error(
        '没能从粘贴的内容里识别出 token。\n' +
          '请确认复制的是 Console 里 `copy(JSON.stringify(localStorage))` 的输出（一行 JSON）。',
      );
    }
    return { token, source: '手工粘贴' };
  } finally {
    rl.close();
  }
}

/** 持久化 token，供下次免粘贴使用。 */
export function saveToken(tokenFile, token) {
  fs.mkdirSync(tokenFile.replace(/[\\/][^\\/]+$/, '') || '.', { recursive: true });
  fs.writeFileSync(tokenFile, token, { encoding: 'utf8', mode: 0o600 });
}

export function printHowToCopy() {
  console.log(`
────────────────────────────────────────────────────────────
 需要一次 DeepSeek 登录凭证（之后会缓存，不用天天弄）
────────────────────────────────────────────────────────────
 1. 浏览器打开 https://chat.deepseek.com 并确保已登录
 2. 按 F12（或右键「检查」）→ 打开 Console 标签
 3. 粘贴下面这一行，回车：

      copy(JSON.stringify(localStorage))

    （这一步只是把你自己浏览器的登录信息复制到剪贴板，
      不会发送到任何第三方；clipboard 里是这个网站的登录令牌）

 4. 回到这里，直接 Ctrl+V 粘贴，回车
────────────────────────────────────────────────────────────
`);
}
