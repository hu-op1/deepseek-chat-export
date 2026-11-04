/**
 * 响应归一化：从"不知道确切结构"的 JSON 里，稳妥地找到会话数组和消息数组。
 *
 * 为什么要这么啰嗦：DeepSeek 的响应包了 data / biz_data 两层，字段名也可能变。
 * 硬编码某一条路径，一次小改版就全废；这里用"形状识别 + 路径记日志"：
 * 找到什么路径、以什么理由判定，都会打印出来，方便下次改版时快速定位。
 */

const SESSION_MARKER_KEYS = ['title', 'updated_at', 'created_at', 'seq_id', 'chat_session_id'];
const MESSAGE_MARKER_KEYS = ['role', 'message_id', 'thinking_content', 'inserted_at'];

/** 业务层是否成功。 */
export function isSuccess(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if ('code' in payload) return Number(payload.code) === 0;
  return true;
}

/** 抽出鉴权类错误码。 */
export function authErrorOf(payload) {
  const code = Number(payload?.code);
  if (code === 40002 || code === 40003) {
    return { code, message: String(payload?.msg ?? payload?.message ?? '') };
  }
  return null;
}

/**
 * 在 JSON 里深度查找第一个满足条件的"对象数组"。
 * @returns {{array: any[], path: string}|null}
 */
export function findArray(root, accept) {
  const seen = new Set();

  const walk = (node, path, depth) => {
    if (!node || typeof node !== 'object' || depth > 8) return null;
    if (seen.has(node)) return null;
    seen.add(node);

    if (Array.isArray(node)) {
      if (node.length > 0 && node.every((item) => item && typeof item === 'object') && accept(node)) {
        return { array: node, path };
      }
      for (let i = 0; i < node.length && i < 5; i += 1) {
        const hit = walk(node[i], `${path}[${i}]`, depth + 1);
        if (hit) return hit;
      }
      return null;
    }

    for (const [key, value] of Object.entries(node)) {
      const hit = walk(value, path ? `${path}.${key}` : key, depth + 1);
      if (hit) return hit;
    }
    return null;
  };

  return walk(root, '', 0);
}

const hasAnyKey = (obj, keys) => keys.some((key) => obj[key] !== undefined && obj[key] !== null);

/** 会话对象的判据：有 id，且有 title/时间/seq 其中之一，且不像消息。 */
export function looksLikeSession(item) {
  if (!item || typeof item !== 'object') return false;
  const hasId = typeof item.id === 'string' || typeof item.id === 'number';
  if (!hasId) return false;
  if (item.role !== undefined) return false;
  return hasAnyKey(item, SESSION_MARKER_KEYS);
}

/** 消息对象的判据：有 role 或 message_id。 */
export function looksLikeMessage(item) {
  if (!item || typeof item !== 'object') return false;
  return hasAnyKey(item, ['role', 'message_id']);
}

/**
 * @returns {{sessions: any[], hasMore: boolean, path: string}}
 */
export function extractSessions(payload) {
  const explicit = [
    payload?.data?.biz_data?.chat_sessions,
    payload?.data?.chat_sessions,
    payload?.biz_data?.chat_sessions,
    payload?.chat_sessions,
    payload?.data?.data?.chat_sessions,
  ].find((value) => Array.isArray(value));

  if (explicit) {
    return {
      sessions: explicit.filter((item) => item && typeof item === 'object'),
      hasMore: readHasMore(payload),
      path: 'chat_sessions（已知路径）',
    };
  }

  const found = findArray(payload, (array) => array.every(looksLikeSession));
  if (found) {
    return { sessions: found.array, hasMore: readHasMore(payload), path: `${found.path}（形状识别）` };
  }

  return { sessions: [], hasMore: false, path: '(未找到会话数组)' };
}

/**
 * @returns {{messages: any[], path: string}}
 */
export function extractMessages(payload) {
  const explicit = [
    payload?.data?.biz_data?.chat_messages,
    payload?.data?.chat_messages,
    payload?.biz_data?.chat_messages,
    payload?.chat_messages,
    payload?.data?.data?.chat_messages,
  ].find((value) => Array.isArray(value));

  if (explicit) {
    return { messages: explicit, path: 'chat_messages（已知路径）' };
  }

  const found = findArray(payload, (array) => array.every(looksLikeMessage));
  if (found) {
    return { messages: found.array, path: `${found.path}（形状识别）` };
  }

  return { messages: [], path: '(未找到消息数组)' };
}

/** has_more 可能出现在多个层级，逐个找。 */
export function readHasMore(payload) {
  const candidates = [
    payload?.data?.biz_data?.has_more,
    payload?.data?.has_more,
    payload?.biz_data?.has_more,
    payload?.has_more,
  ];
  for (const value of candidates) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
  }
  return false;
}

/**
 * 服务器时间可能是秒、毫秒或 ISO 字符串，统一成毫秒数用于比较。
 * 无法解析时返回 null（调用方应退化为"每次都重抓"）。
 */
export function toMillis(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value > 1e11 ? value : value * 1000;
  }
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return toMillis(Number(text));
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

/** 从会话对象里取我们要用的几个字段（不改原始对象）。 */
export function summarizeSession(session) {
  const id = String(session?.id ?? session?.chat_session_id ?? '');
  const updatedAt = session?.updated_at ?? session?.update_time ?? session?.modified_at ?? null;
  return {
    id,
    title: typeof session?.title === 'string' ? session.title : '',
    created_at: session?.created_at ?? session?.created_time ?? null,
    updated_at: updatedAt,
    updated_ms: toMillis(updatedAt),
    message_count:
      typeof session?.message_count === 'number'
        ? session.message_count
        : typeof session?.total_message_count === 'number'
          ? session.total_message_count
          : null,
  };
}

/** 消息数组的稳定哈希，用于判断"内容真的变了没有"。 */
export function fingerprint(value) {
  return JSON.stringify(value ?? null);
}
