/**
 * 传输层：两种模式
 *   - token 模式（主路径）：Bearer token 直连 REST 接口
 *   - cURL 模式（逃生舱）：原样重放浏览器里复制出来的请求，接口改版也不怕
 *
 * 两种模式对外暴露相同的形状，上层（export.mjs）不需要关心用的是哪种。
 */

import fs from 'node:fs';
import path from 'node:path';

import { authErrorOf, extractSessions, isSuccess } from './extract.mjs';
import { deriveMessagesRequest, describeCurl, getHeader, parseCurl } from './curl.mjs';
import { sleep } from './util.mjs';

export const BASE = 'https://chat.deepseek.com';

export const ENDPOINTS = {
  listSessions: '/api/v0/chat_session/fetch_page',
  historyMessages: '/api/v0/chat/history_messages',
  currentUser: '/api/v0/users/current',
};

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** kind: auth | gone | network | rate-limit | shape | biz */
export class ApiError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.code = extra.code ?? null;
    this.status = extra.status ?? null;
    this.hint = extra.hint ?? null;
  }
}

const backoff = (attempt) => Math.min(15000, 800 * 2 ** attempt) + Math.floor(Math.random() * 300);

/** 业务层限流的错误码。40029 = TOO_MANY_REQUESTS（实测），429 是标准 HTTP 语义。 */
const RATE_LIMIT_CODES = new Set([40029, 429]);

function dumpRaw(debugDir, label, url, text) {
  if (!debugDir) return;
  try {
    fs.mkdirSync(debugDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(debugDir, `${stamp}_${label}.txt`), `URL: ${url}\n\n${text}`, 'utf8');
  } catch {
    /* 调试转储失败不该影响主流程 */
  }
}

/**
 * 发请求并解析出业务 JSON，带重试与错误分类。
 * @returns {Promise<any>} 解析后的响应体（code === 0）
 */
export async function requestJson(
  url,
  {
    method = 'GET',
    headers = [],
    body = null,
    retries = 2,
    rateRetries = 6,
    timeoutMs = 30000,
    debugDir = null,
    label = 'request',
    gate = null,
    log,
  } = {},
) {
  let attempt = 0;
  let rateAttempt = 0;

  for (;;) {
    let response;
    let text = '';

    await gate?.wait();

    try {
      response = await fetch(url, {
        method,
        headers: headersToObject(headers),
        body,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await response.text();
    } catch (error) {
      if (attempt < retries) {
        const wait = backoff(attempt);
        log?.(`  ! 网络异常，${Math.round(wait / 1000)}s 后重试：${error?.message ?? error}`);
        await sleep(wait);
        attempt += 1;
        continue;
      }
      throw new ApiError('network', `网络请求失败（${label}）：${error?.message ?? error}`);
    }

    const status = response.status;
    const contentType = response.headers.get('content-type') ?? '';

    // 限流与服务端临时故障：退避重试
    if (status === 429 || (status >= 500 && status < 600)) {
      const isRateLimit = status === 429;
      const budget = isRateLimit ? rateRetries : retries;
      const used = isRateLimit ? rateAttempt : attempt;

      if (used < budget) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const wait =
          Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 60000) : backoff(used);
        if (isRateLimit) {
          gate?.slowDown();
          gate?.coolDown(wait);
          rateAttempt += 1;
        } else {
          attempt += 1;
        }
        log?.(`  ! HTTP ${status}，${Math.round(wait / 1000)}s 后重试`);
        await sleep(wait);
        continue;
      }
      throw new ApiError(isRateLimit ? 'rate-limit' : 'network', `HTTP ${status}，重试后仍失败`, { status });
    }

    if (status === 401 || status === 403) {
      throw new ApiError('auth', `HTTP ${status}：登录凭证被拒绝`, { status });
    }

    // 返回网页 = 走到了 SPA 兜底路由，说明接口路径已经不存在了
    if (/html/i.test(contentType) || /^\s*</.test(text)) {
      dumpRaw(debugDir, `${label}-html`, url, text.slice(0, 4000));
      throw new ApiError('gone', `接口返回了网页而不是数据（${url}），很可能接口已经改版`, {
        status,
        hint: '用 --from-curl 模式：在浏览器 Network 面板里对同样的请求点「Copy as cURL」，粘给脚本重放。',
      });
    }

    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      /* 下面统一处理 */
    }

    if (!payload || typeof payload !== 'object') {
      dumpRaw(debugDir, `${label}-unparsable`, url, text.slice(0, 4000));
      throw new ApiError('shape', `响应不是 JSON（HTTP ${status}），无法解析`, { status });
    }

    const authError = authErrorOf(payload);
    if (authError) {
      throw new ApiError('auth', `登录凭证无效（code ${authError.code}${authError.message ? ` ${authError.message}` : ''}）`, {
        code: authError.code,
        status,
      });
    }

    if (!isSuccess(payload)) {
      const code = Number(payload.code);
      const message = String(payload.msg ?? payload.message ?? '');

      // 业务层限流：HTTP 200 + code 40029。这个最坑——它看起来像"成功的响应"，
      // 但其实是服务端在说"你太快了"。必须当成限流退避重试，不能当普通错误判死。
      if (RATE_LIMIT_CODES.has(code) || /TOO_MANY|RATE_?LIMIT|频繁/i.test(message)) {
        if (rateAttempt < rateRetries) {
          const wait = Math.min(60000, 2000 * 2 ** rateAttempt) + Math.floor(Math.random() * 500);
          gate?.slowDown();
          gate?.coolDown(wait);
          rateAttempt += 1;
          log?.(`  ! 服务端限流（${message || code}），${Math.round(wait / 1000)}s 后重试`);
          await sleep(wait);
          continue;
        }
        throw new ApiError('rate-limit', `服务端限流，重试 ${rateRetries} 次后仍失败（code ${code} ${message}）`, {
          code,
          status,
        });
      }

      dumpRaw(debugDir, `${label}-biz`, url, text.slice(0, 4000));
      throw new ApiError('biz', `接口返回业务错误：code=${payload.code} msg=${message}`, {
        code: payload.code,
        status,
      });
    }

    gate?.speedUp();
    return payload;
  }
}

/** Chrome 复制出来的 cURL 里可能带 :method、authority、content-length，交给 fetch 会出错。 */
export function sanitizeHeaders(headers) {
  const blocked = new Set(['host', 'content-length', 'connection', 'accept-encoding', 'transfer-encoding']);
  return (headers || []).filter((h) => {
    const name = String(h.name ?? '');
    if (!name || name.startsWith(':')) return false;
    if (blocked.has(name.toLowerCase())) return false;
    return true;
  });
}

function headersToObject(headers) {
  const out = {};
  for (const h of sanitizeHeaders(headers)) out[h.name] = h.value;
  return out;
}

/* ───────────────────────── token 模式 ───────────────────────── */

export function createTokenClient({ token, baseUrl = BASE, retries = 2, rateRetries = 6, gate = null, timeoutMs = 30000, debugDir = null, log } = {}) {
  if (!token) throw new Error('createTokenClient 需要 token');

  const baseHeaders = () => [
    { name: 'Accept', value: '*/*' },
    { name: 'Accept-Language', value: 'zh-CN,zh;q=0.9,en;q=0.8' },
    { name: 'Authorization', value: `Bearer ${token}` },
    { name: 'Referer', value: `${baseUrl}/` },
    { name: 'User-Agent', value: DEFAULT_UA },
  ];

  const send = (endpoint, { method = 'GET', query = {}, body = null, label = endpoint } = {}) => {
    const url = new URL(endpoint, baseUrl);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const headers = baseHeaders();
    if (body !== null) headers.push({ name: 'Content-Type', value: 'application/json' });
    return requestJson(url.toString(), {
      method,
      headers,
      body: body ?? null,
      retries,
      rateRetries,
      gate,
      timeoutMs,
      debugDir,
      label,
      log,
    });
  };

  return {
    mode: 'token',
    describe: () => `token 模式（Bearer ${token.slice(0, 6)}…）`,
    listPage: ({ query = {} } = {}) => send(ENDPOINTS.listSessions, { method: 'GET', query, label: 'list' }),
    getMessages: (sessionId) =>
      send(ENDPOINTS.historyMessages, { query: { chat_session_id: sessionId }, label: `messages-${sessionId}` }),
  };
}

/* ───────────────────────── cURL 重放模式 ───────────────────────── */

export function createCurlClient(curlText, { retries = 2, rateRetries = 6, gate = null, timeoutMs = 30000, debugDir = null, log } = {}) {
  const template = parseCurl(curlText);
  const contentType = getHeader(template.headers, 'content-type') ?? '';

  const replay = (request, label) =>
    requestJson(request.url, {
      method: request.method,
      headers: sanitizeHeaders(request.headers),
      body: request.body ?? null,
      retries,
      rateRetries,
      gate,
      timeoutMs,
      debugDir,
      label,
      log,
    });

  return {
    mode: 'curl',
    describe: () => `cURL 重放模式（${describeCurl(template)}）`,
    listPage: ({ query = {} } = {}) => {
      const url = new URL(template.url);
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }

      let body = template.body ?? null;
      if (body && /json/i.test(contentType)) {
        try {
          const parsed = JSON.parse(body);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            Object.assign(parsed, query);
            body = JSON.stringify(parsed);
          }
        } catch {
          /* 不是 JSON body，原样发送 */
        }
      }

      return replay({ url: url.toString(), method: template.method, headers: template.headers, body }, 'list');
    },
    getMessages: (sessionId) => replay(deriveMessagesRequest(template, sessionId), `messages-${sessionId}`),
  };
}

/* ───────────────────────── 会话列表分页 ───────────────────────── */

/**
 * 从网页端 bundle 里挖出来的真实分页机制（2026-11 实测）：
 *
 *   GET /api/v0/chat_session/fetch_page
 *       ?count=100
 *       &lte_cursor.updated_at=<秒>
 *       &lte_cursor.pinned=<true|false>
 *
 * 要点，全部踩过坑：
 *   - updated_at 必须传**秒**，传毫秒直接 HTTP 400
 *   - lte_cursor.pinned 必填，不传则整个游标被忽略（永远返回第一页）
 *   - count 上限 100，传 200 会静默返回 0 条（看起来像"没有数据"）
 *   - 游标是闭区间（lte），所以每页首条会和上一页末条重复，需要按 id 去重
 */
export const MAX_PAGE_SIZE = 100;

/** 从会话对象推导下一页游标；推不出来就返回 null（调用方应停止翻页并报警）。 */
export function cursorOf(session) {
  const raw = session?.updated_at ?? session?.update_time;
  const numeric = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;

  const seconds = numeric > 1e11 ? numeric / 1000 : numeric; // 毫秒 → 秒
  return {
    'lte_cursor.updated_at': seconds,
    'lte_cursor.pinned': Boolean(session?.pinned),
  };
}

/**
 * 拉取服务端全部会话。
 *
 * @returns {Promise<{sessions: any[], complete: boolean, pages: number, notes: string[]}>}
 */
export async function listAllSessions(client, { count = MAX_PAGE_SIZE, delayMs = 300, maxPages = 500, log } = {}) {
  const collected = new Map();
  const notes = [];

  const pageSize = Math.min(Math.max(1, count), MAX_PAGE_SIZE);
  if (count > MAX_PAGE_SIZE) {
    notes.push(`每页最多 ${MAX_PAGE_SIZE} 条，已从 ${count} 降到 ${MAX_PAGE_SIZE}（传更大会被服务端当成 0 条）`);
  }

  const absorb = (sessions) => {
    let fresh = 0;
    for (const raw of sessions) {
      const id = String(raw?.id ?? raw?.chat_session_id ?? '');
      if (!id) continue;
      if (!collected.has(id)) {
        collected.set(id, raw);
        fresh += 1;
      }
    }
    return fresh;
  };

  let cursor = null;
  let pages = 0;
  let complete = false;

  while (pages < maxPages) {
    const query = cursor ? { count: pageSize, ...cursor } : { count: pageSize };
    const payload = await client.listPage({ query });
    const { sessions, hasMore } = extractSessions(payload);
    const fresh = absorb(sessions);
    pages += 1;

    log?.(
      `  第 ${pages} 页：拿到 ${sessions.length} 条，新增 ${fresh} 条（累计 ${collected.size}），has_more=${hasMore}`,
    );

    if (!hasMore) {
      complete = true;
      break;
    }
    if (sessions.length === 0) {
      notes.push(`第 ${pages} 页为空但 has_more=true，服务端行为异常，已停止翻页`);
      break;
    }
    if (fresh === 0) {
      notes.push(`第 ${pages} 页没有新数据（游标可能没有推进），已停止翻页以免死循环`);
      break;
    }

    const last = sessions[sessions.length - 1];
    const nextCursor = cursorOf(last);
    if (!nextCursor) {
      notes.push('最后一页的会话缺少 updated_at，无法推导游标，已停止翻页');
      break;
    }
    // 游标没前进说明会死循环
    if (cursor && nextCursor['lte_cursor.updated_at'] >= cursor['lte_cursor.updated_at']) {
      notes.push('游标没有向前推进，已停止翻页以免死循环');
      break;
    }

    cursor = nextCursor;
    await sleep(delayMs);
  }

  if (!complete && pages >= maxPages) {
    notes.push(`已达翻页上限 ${maxPages} 页，后面的对话没有抓取`);
  }

  return { sessions: [...collected.values()], complete, pages, notes };
}

/* ───────────────────────── 无 token 的接口探测 ───────────────────────── */

/**
 * 不携带任何凭证探测接口是否还活着。
 * 判据：返回 JSON 且带 code 字段 → 接口存在（只是没登录）；返回 HTML → 接口已下线。
 */
export async function probeEndpoints({ timeoutMs = 15000, delayMs = 200 } = {}) {
  const targets = [
    { name: '对话列表', path: ENDPOINTS.listSessions, query: { count: 1 }, required: true },
    { name: '对话消息', path: ENDPOINTS.historyMessages, query: { chat_session_id: '0' }, required: true },
    { name: '当前用户', path: ENDPOINTS.currentUser, query: {}, required: false },
  ];

  const results = [];

  for (const target of targets) {
    const url = new URL(target.path, BASE);
    for (const [key, value] of Object.entries(target.query)) url.searchParams.set(key, String(value));

    try {
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: { Accept: '*/*', Referer: `${BASE}/`, 'User-Agent': DEFAULT_UA },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      const contentType = response.headers.get('content-type') ?? '';
      const looksHtml = /html/i.test(contentType) || /^\s*</.test(text);

      let payload = null;
      try {
        payload = JSON.parse(text);
      } catch {
        /* 保持 null */
      }

      results.push({
        ...target,
        status: response.status,
        alive: Boolean(payload) && !looksHtml,
        code: payload?.code ?? null,
        msg: payload?.msg ?? payload?.message ?? null,
        note: looksHtml ? '返回网页（接口可能已下线）' : payload ? '接口存在' : '响应无法解析',
      });
    } catch (error) {
      results.push({ ...target, status: null, alive: false, code: null, msg: null, note: `请求失败：${error?.message ?? error}` });
    }

    await sleep(delayMs);
  }

  return results;
}
