/** 与业务无关的小工具。 */

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 固定并发的任务池：单项失败不影响整体，结果按输入顺序返回。
 * @template T, R
 * @param {T[]} items
 * @param {number} size
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<Array<R|Error>>}
 */
export async function pool(items, size, worker) {
  const results = new Array(items.length);
  let next = 0;

  const run = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        results[index] = error instanceof Error ? error : new Error(String(error));
      }
    }
  };

  const workers = Array.from({ length: Math.max(1, Math.min(size, items.length)) }, run);
  await Promise.all(workers);
  return results;
}

/** 把 ISO 字符串或毫秒数格式化成本地可读时间。 */
export function formatTime(value) {
  const millis =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value)
        ? Number(value)
        : Date.parse(String(value));
  if (!millis || Number.isNaN(millis)) return '未知时间';
  const date = new Date(millis);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 人类可读的体积。 */
export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '?';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}

/** 压成一行，避免错误信息刷屏。 */
export function oneLine(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, ' ').trim();
}

/** 截断过长标题，用于终端输出。 */
export function clip(text, max = 40) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!value) return '(无标题)';
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * 全局节奏控制：所有请求按开始时间均匀排队。
 *
 * 为什么需要它：并发 3 + 每个 300ms 睡一次，实际是"一波 3 个同时打出去"，
 * 服务端看到的是突发流量，跑几百个对话后就会开始回 TOO_MANY_REQUESTS。
 * 这里把"开始时间"串成等间隔，并发多高都不会变成突发；
 * 一旦被限流就自动拉长间隔，之后慢慢恢复。
 */
export function createGate({ gapMs = 300, maxGapMs = 4000 } = {}) {
  const base = Math.max(0, gapMs);
  let gap = base;
  let nextAt = 0;

  return {
    async wait() {
      const now = Date.now();
      const at = Math.max(now, nextAt);
      nextAt = at + gap;
      if (at > now) await sleep(at - now);
    },
    /** 被限流后拉长间隔（下一次请求至少等这么久）。 */
    slowDown(factor = 2) {
      gap = Math.min(Math.max(gap, base || 100) * factor, maxGapMs);
      return gap;
    },
    /** 慢慢恢复原速，避免限流过去后一直慢速爬。 */
    speedUp() {
      if (gap > base) gap = Math.max(base, gap * 0.8);
    },
    coolDown(ms) {
      nextAt = Math.max(nextAt, Date.now() + ms);
    },
    get gap() {
      return Math.round(gap);
    },
  };
}
