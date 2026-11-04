/**
 * 本地存储：索引、文件命名、增量差异。
 *
 * 两条硬性要求：
 *   1. 幂等：同样的数据重复跑，不产生重复文件、不改变结果；
 *   2. 不丢：任何一步失败都不能破坏已有备份（先写临时文件再改名）。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { summarizeSession } from './extract.mjs';

const ILLEGAL_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;
const MAX_TITLE_LEN = 48;

/** 把标题变成安全的文件名片段（Windows 保留字符、结尾的点和空格都要处理）。 */
export function sanitizeFilePart(text, maxLen = MAX_TITLE_LEN) {
  const cleaned = String(text ?? '')
    .replace(ILLEGAL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen)
    .trim()
    .replace(/[. ]+$/g, '');

  if (!cleaned) return '';
  // Windows 保留设备名
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned)) return `_${cleaned}`;
  return cleaned;
}

export function datePart(millis) {
  if (!millis) return '0000-00-00';
  const date = new Date(millis);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 文件名：日期_标题__id 短哈希.json
 * 带标题是为了人在资源管理器里也能认出来；短哈希保证"同一对话永远同一个名字、不同对话不容易撞名"。
 */
export function sessionFileName(summary) {
  const date = datePart(summary.updated_ms);
  const title = sanitizeFilePart(summary.title) || '未命名';
  const suffix = crypto.createHash('sha1').update(String(summary.id ?? '')).digest('hex').slice(0, 8);
  return `${date}_${title}__${suffix}.json`;
}

export function hashJson(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex')}`;
}

export function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    fs.renameSync(tempPath, filePath);
  } catch {
    // 极少数情况下 Windows 上改名会被占用，退化为覆盖写
    fs.copyFileSync(tempPath, filePath);
    fs.unlinkSync(tempPath);
  }
}

export function readJsonFile(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    const backup = `${filePath}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(filePath, backup);
    } catch {
      /* 尽力而为 */
    }
    throw new Error(`${filePath} 已损坏，已备份到 ${backup}（${error.message}）`);
  }
}

export function indexPath(dataDir) {
  return path.join(dataDir, 'index.json');
}

export function emptyIndex() {
  return { schema: 1, updatedAt: null, complete: false, pagination: { strategy: null }, sessions: {} };
}

export function loadIndex(dataDir) {
  const loaded = readJsonFile(indexPath(dataDir), null);
  if (!loaded || typeof loaded !== 'object') return emptyIndex();
  return {
    ...emptyIndex(),
    ...loaded,
    sessions: loaded.sessions && typeof loaded.sessions === 'object' ? loaded.sessions : {},
  };
}

export function saveIndex(dataDir, index) {
  atomicWriteJson(indexPath(dataDir), { ...index, updatedAt: new Date().toISOString() });
}

/**
 * 对比远端会话列表与本地索引，决定抓哪些。
 * @param {any[]} remoteRaw 远端原始会话对象数组
 * @param {{sessions: Record<string, any>}} index
 * @param {{full?: boolean}} options
 */
export function planSync(remoteRaw, index, { full = false } = {}) {
  const entries = index.sessions ?? {};
  const toFetch = [];
  const unchanged = [];

  for (const raw of remoteRaw) {
    const summary = summarizeSession(raw);
    if (!summary.id) continue;

    const previous = entries[summary.id];
    if (!previous) {
      toFetch.push({ summary, reason: '新增' });
      continue;
    }
    if (full) {
      toFetch.push({ summary, reason: '强制全量' });
      continue;
    }

    const prevTime = previous.updated_at ?? null;
    const nextTime = summary.updated_at ?? null;

    let changed;
    if (prevTime !== null && nextTime !== null) {
      changed = String(prevTime) !== String(nextTime);
    } else if (previous.message_count != null && summary.message_count != null) {
      changed = previous.message_count !== summary.message_count;
    } else {
      changed = false; // 两边都没有可比字段，认定为未变，避免每次全量重抓
    }

    if (changed) toFetch.push({ summary, reason: '有更新' });
    else unchanged.push({ summary, previous });
  }

  const remoteIds = new Set(remoteRaw.map((raw) => summarizeSession(raw).id).filter(Boolean));
  const goneFromRemote = Object.keys(entries).filter((id) => !remoteIds.has(id));

  return { toFetch, unchanged, goneFromRemote };
}

/** 写单个会话文件，返回索引条目。 */
export function writeSessionFile(dataDir, summary, rawSession, messages) {
  const fileName = sessionFileName(summary);
  const relative = path.join('sessions', fileName);
  const absolute = path.join(dataDir, relative);

  const payload = {
    schema: 1,
    fetchedAt: new Date().toISOString(),
    session: rawSession, // 原始对象，不做任何裁剪
    messages, // 原始数组，一条都不动
  };

  atomicWriteJson(absolute, payload);

  return {
    file: relative,
    title: summary.title,
    created_at: summary.created_at ?? null,
    updated_at: summary.updated_at ?? null,
    message_count: messages.length,
    content_hash: hashJson(messages),
    fetched_at: payload.fetchedAt,
  };
}

/** 删除改名后遗留的旧文件（标题变了会生成新文件名）。 */
export function removeStaleFile(dataDir, relativePath) {
  if (!relativePath) return false;
  try {
    fs.unlinkSync(path.join(dataDir, relativePath));
    return true;
  } catch {
    return false;
  }
}
