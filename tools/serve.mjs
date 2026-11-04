#!/usr/bin/env node
/**
 * 本地 web 界面。
 *
 *   node tools/serve.mjs              # 默认 http://127.0.0.1:7788
 *   node tools/serve.mjs --port 8080 --open
 *
 * 为什么需要服务而不是静态文件：语义搜索要把查询词嵌入成向量，
 * 这需要 API Key。静态页面里放 key 等于公开它；服务端可以只在内存里持有。
 *
 * 只监听 127.0.0.1，不对外网开放。
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { parseArgs, usage } from '../lib/args.mjs';
import { createEmbeddingClient, decodeVector, nearest, normalize } from '../lib/embed.mjs';
import { renderAtlasHtml } from '../lib/atlas-html.mjs';
import { renderGraphHtml } from '../lib/graph-html.mjs';
import { loadIndex } from '../lib/store.mjs';
import { firstUserText, monthOf, sessionMessages } from '../lib/topics.mjs';
import { layout, renderChat, renderError, renderOverview, renderSearch, renderTasks, renderTimeline } from '../lib/web.mjs';
import { TASKS, executeTask } from '../lib/tasks.mjs';
import { loadConfig, resolveRuntime, saveConfig } from '../lib/config.mjs';
import { oneLine } from '../lib/util.mjs';

const SPEC = {
  port: { type: 'number', default: 7788, desc: '端口（默认 7788）' },
  data: { type: 'string', default: 'data', desc: '备份目录（默认 data）' },
  out: { type: 'string', default: 'memory', desc: '向量与图谱目录（默认 memory）' },
  'base-url': { type: 'string', desc: '模型端点（OpenAI 兼容，也可从已有向量缓存里读）' },
  'api-key': { type: 'string', desc: '模型端点 Key（也可用环境变量 DS_API_KEY）' },
  open: { type: 'boolean', desc: '启动后打开浏览器' },
  help: { type: 'boolean', alias: 'h', desc: '显示帮助' },
};

const NAV_HTML = `<nav class="top" style="border-bottom:2px solid #1B1F24;margin:0 -22px 26px;padding:14px 22px 0;display:flex;gap:22px;align-items:baseline;flex-wrap:wrap;font-family:var(--mono,monospace);font-size:12px">
<a href="/" style="text-decoration:none;color:#5A6470">← 返回档案</a></nav>`;

const log = (m = '') => console.log(m);

/** 读取请求体（任务参数是 JSON）。 */
function readBody(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > limit) reject(new Error('请求体太大'));
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

/** updated_at 可能是秒也可能是毫秒。 */
function monthOfValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return monthOf(n > 1e11 ? n : n * 1000);
}

/** 本地时区的 YYYY-MM（toISOString 是 UTC，会跨月错位）。 */
function localMonth(ms) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv, SPEC);
  if (options.help) {
    log(usage('本地 web 界面：概览 / 搜索 / 对话阅读 / 星座图 / 主题图谱 / 任务', SPEC));
    return;
  }

  const dataDir = path.resolve(options.data);
  const outDir = path.resolve(options.out);

  // 端点和 Key 的优先级：命令行 > 环境变量 > memory/config.json（网页上保存的）
  const runtime = resolveRuntime({ outDir, flagBaseUrl: options['base-url'], flagApiKey: options['api-key'] });

  // 两套端点：嵌入用于搜索/向量，对话用于标注
  const embedNet = () => ({ baseUrl: runtime.embed.baseUrl || getVectors()?.baseUrl || '', apiKey: runtime.embed.apiKey });
  const chatNet = () => ({ baseUrl: runtime.chat.baseUrl, apiKey: runtime.chat.apiKey });

  // 全部按需加载并缓存：启动时不读 10MB 向量文件
  const cache = { index: null, vectors: null, atlas: null, graph: null };

  // 任务页一次只跑一个；进度靠临时接管 console.log 采集
  const taskState = { running: false, name: null, title: null, log: [], code: null, startedAt: null, finishedAt: null };

  /**
   * 带修改时间校验的 JSON 缓存。
   *
   * 两个坑都踩过：
   *   1. 把"文件还没生成"缓存住，之后生成了页面也永远 404；
   *   2. 在另一个终端重新生成了文件，服务还在用旧内容（图谱从 80 个主题退回 30 个）。
   * 所以只缓存"读到了且在 mtime 没变"的结果。
   */
  const jsonCache = (file, slot) => {
    if (!fs.existsSync(file)) return false;
    const mtime = fs.statSync(file).mtimeMs;
    if (cache[slot] && cache[`${slot}Mtime`] === mtime) return cache[slot];
    cache[slot] = JSON.parse(fs.readFileSync(file, 'utf8'));
    cache[`${slot}Mtime`] = mtime;
    return cache[slot];
  };

  const getIndex = () => jsonCache(path.join(dataDir, 'index.json'), 'index') || loadIndex(dataDir);
  const getVectors = () => jsonCache(path.join(outDir, 'vectors.json'), 'vectors');
  const getAtlas = () => jsonCache(path.join(outDir, 'atlas.json'), 'atlas');
  const getGraph = () => jsonCache(path.join(outDir, 'graph.json'), 'graph');

  const readSession = (entry) => JSON.parse(fs.readFileSync(path.join(dataDir, entry.file), 'utf8'));

  /** 把查询词嵌入成向量，再和全部对话算余弦。 */
  async function semanticSearch(query, top = 12) {
    const vectors = getVectors();
    if (!vectors) {
      return { hits: [], error: '还没有向量缓存。先运行：node tools/embed.mjs --base-url … --model …' };
    }
    const key = embedNet().apiKey;
    if (!key) {
      return { hits: [], error: '服务端没有 API Key，无法把查询词嵌入。重启时加上 --api-key 或设置 DS_API_KEY。' };
    }

    const client = createEmbeddingClient({ baseUrl: vectors.baseUrl, apiKey: key, model: vectors.model });
    const [raw] = await client.embed([query]);
    if (!raw) return { hits: [], error: '嵌入端点没有返回向量。' };

    const target = normalize(raw);
    const items = Object.entries(vectors.items)
      .map(([id, item]) => ({ id, vector: decodeVector(item.v), title: item.t, month: item.m }))
      .filter((item) => item.vector.length > 0);

    const index = getIndex();
    const notes = conversationNotes();
    const hits = nearest(target, items, top).map((hit) => {
      const entry = index.sessions[hit.id];
      let snippet = '';
      let messageCount = 0;
      if (entry?.file) {
        try {
          const session = readSession(entry);
          messageCount = session.messages?.length ?? 0;
          snippet = firstUserText(sessionMessages(session), 120);
        } catch {
          /* 单个文件读失败不该影响整页 */
        }
      }
      // 标题和月份从索引里取（最权威）；缓存里的 t/m 只当兜底
      return {
        id: hit.id,
        score: hit.score,
        title: entry?.title ?? hit.item?.title ?? '',
        month: monthOfValue(entry?.updated_at) ?? hit.item?.month ?? '',
        snippet,
        date: entry?.updated_at ?? null,
        summary: notes.get(hit.id)?.summary ?? '',
        topics: topicLabelsOf(notes.get(hit.id)?.topics),
        messageCount,
      };
    });

    return { hits, model: vectors.model };
  }

  /** 每段对话的标注（摘要、主题、实体），来自 graph.json；没有就返回空表。 */
  function conversationNotes() {
    const graph = getGraph();
    const map = new Map();
    if (!graph?.conversations) return map;
    for (const [id, info] of Object.entries(graph.conversations)) map.set(id, info);
    return map;
  }

  /** 主题 id → 可读名字。 */
  function topicLabelsOf(ids, limit = 4) {
    if (!Array.isArray(ids) || !ids.length) return [];
    const graph = getGraph();
    if (!graph?.topics) return [];
    const byId = new Map(graph.topics.map((t) => [t.id, t.label]));
    return ids
      .map((id) => byId.get(id))
      .filter(Boolean)
      .slice(0, limit);
  }

  // 首页统计要遍历 48MB 会话文件，不能每次刷新都算一遍
  const heavyCache = { key: null, value: null };

  function overviewStats() {
    const index = getIndex();
    const entries = Object.values(index.sessions);
    const graphForCache = getGraph();
    const cacheKey = `${index.updatedAt ?? ''}|${entries.length}|${graphForCache?.generatedAt ?? ''}`;
    if (heavyCache.key === cacheKey) return heavyCache.value;
    const times = entries.map((e) => Number(e.updated_at)).filter((n) => Number.isFinite(n) && n > 0);
    const toMs = (v) => (v > 1e11 ? v : v * 1000);

    let messages = 0;
    let chars = 0;
    const countsByMonth = {};
    for (const entry of entries) {
      if (!entry.file) continue;
      try {
        const session = readSession(entry);
        messages += session.messages?.length ?? 0;
        for (const message of session.messages ?? []) {
          for (const fragment of message.fragments ?? []) {
            if (typeof fragment.content === 'string') chars += fragment.content.length;
          }
        }
      } catch {
        /* 忽略损坏文件 */
      }
      // 用本地时间算月份：toISOString 是 UTC，会把这边的月初对话算到上个月
      const ms = toMs(Number(entry.updated_at));
      const month = entry.updated_at && Number.isFinite(ms) ? localMonth(ms) : null;
      if (month) countsByMonth[month] = (countsByMonth[month] ?? 0) + 1;
    }

    const months = Object.keys(countsByMonth).sort();
    const vectors = getVectors();
    const graph = getGraph();
    const notes = conversationNotes();

    // 最近 8 段：首页最有用的东西其实是"我最近在聊什么"
    // 注意 id 是 index.sessions 的键，条目本身没有 id 字段
    const recent = Object.entries(index.sessions)
      .filter(([, e]) => e.file)
      .sort((a, b) => toMs(Number(b[1].updated_at)) - toMs(Number(a[1].updated_at)))
      .slice(0, 8)
      .map(([id, e]) => ({
        id,
        title: e.title || '(无标题)',
        month: monthOfValue(e.updated_at) ?? '',
        summary: notes.get(id)?.summary ?? '',
        date: notes.get(id)?.date ?? e.updated_at,
        topics: topicLabelsOf(notes.get(id)?.topics, 3),
      }));

    // 聊得最多的主题
    const topTopics = (graph?.topics ?? [])
      .slice()
      .sort((a, b) => b.count - a.count)
      .slice(0, 12)
      .map((t) => ({ id: t.id, label: t.label, count: t.count }));

    const result = {
      stats: {
        conversations: entries.length,
        messages,
        chars,
        span: times.length
          ? `${new Date(toMs(Math.min(...times))).toISOString().slice(0, 10)} → ${new Date(toMs(Math.max(...times))).toISOString().slice(0, 10)}`
          : '无时间数据',
        vectors: vectors ? Object.keys(vectors.items).length : 0,
        vectorLabel: vectors ? `${vectors.dim} 维 · ${vectors.model}` : '尚未生成',
        topics: graph?.counts?.topics ?? 0,
        annotated: notes.size,
      },
      months,
      countsByMonth,
      recent,
      topTopics,
      artifacts: {
        '备份数据': { ok: fs.existsSync(path.join(dataDir, 'index.json')), label: `${entries.length} 段` },
        '向量缓存': { ok: Boolean(vectors), label: vectors ? `${Object.keys(vectors.items).length} 条` : '缺失' },
        '星座图': { ok: Boolean(getAtlas()), label: getAtlas() ? '已生成' : '缺失' },
        '主题图谱': { ok: Boolean(getGraph()), label: getGraph() ? `${getGraph().counts.topics} 个主题` : '缺失' },
        '主题标注': {
          ok: fs.existsSync(path.join(outDir, 'topics')),
          label: fs.existsSync(path.join(outDir, 'topics'))
            ? `${fs.readdirSync(path.join(outDir, 'topics')).filter((f) => f.endsWith('.json')).length} / ${entries.length}`
            : '未开始',
        },
      },
    };

    heavyCache.key = cacheKey;
    heavyCache.value = result;
    return result;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (status, body, type = 'text/html; charset=utf-8') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    const page = (html, status = 200) => send(status, html);

    try {
      if (url.pathname === '/') {
        const overview = overviewStats();
        return page(layout({ title: '对话档案', active: 'home', body: renderOverview(overview) }));
      }

      if (url.pathname === '/timeline') {
        const graph = getGraph();
        if (!graph?.conversations) {
          return page(layout({ title: '时间线', active: 'timeline', body: renderTimeline({ months: [] }) }));
        }

        const topicLabel = new Map((graph.topics ?? []).map((t) => [t.id, t.label]));
        const byMonth = new Map();

        for (const [id, info] of Object.entries(graph.conversations)) {
          const month = info.month;
          if (!month) continue;
          if (!byMonth.has(month)) byMonth.set(month, { month, total: 0, topicCount: new Map(), items: [] });
          const bucket = byMonth.get(month);
          bucket.total += 1;
          for (const tid of info.topics ?? []) bucket.topicCount.set(tid, (bucket.topicCount.get(tid) ?? 0) + 1);
          bucket.items.push({ id, title: info.title, summary: info.summary, date: info.date ?? null });
        }

        const months = [...byMonth.values()]
          .sort((a, b) => (a.month < b.month ? 1 : -1))
          .map((bucket) => ({
            month: bucket.month,
            total: bucket.total,
            topics: [...bucket.topicCount.entries()]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 6)
              .map(([tid, count]) => ({ label: topicLabel.get(tid) ?? tid, count })),
            items: bucket.items.slice(0, 6),
          }));

        return page(layout({ title: '时间线', active: 'timeline', body: renderTimeline({ months }) }));
      }

      if (url.pathname === '/search') {
        const query = (url.searchParams.get('q') ?? '').trim();
        if (!query) {
          const vectors = getVectors();
          return page(
            layout({
              title: '搜索',
              active: 'search',
              body: renderSearch({
                total: vectors ? Object.keys(vectors.items).length : 0,
                model: vectors ? vectors.model : '',
              }),
            }),
          );
        }
        const result = await semanticSearch(query);
        return page(
          layout({
            title: `搜索：${query}`,
            active: 'search',
            body: renderSearch({
              query,
              hits: result.hits,
              error: result.error ?? '',
              model: result.model ?? '',
              total: getVectors() ? Object.keys(getVectors().items).length : 0,
            }),
          }),
        );
      }

      if (url.pathname.startsWith('/chat/')) {
        const id = decodeURIComponent(url.pathname.slice('/chat/'.length));
        const index = getIndex();
        const entry = index.sessions[id];
        if (!entry?.file) return page(layout({ title: '找不到对话', body: renderError({ message: `没有 id 为 ${id} 的对话` }) }), 404);

        const session = readSession(entry);
        const atlas = getAtlas();
        const neighbors = (atlas?.neighbors?.[id] ?? []).slice(0, 5).map((n) => ({
          id: n.id,
          score: n.score,
          title: atlas.points.find((p) => p.id === n.id)?.t ?? '',
        }));

        const note = conversationNotes().get(id);
        return page(
          layout({
            title: entry.title ?? '对话',
            body: renderChat({
              entry,
              session,
              neighbors,
              summary: note?.summary ?? '',
              topics: topicLabelsOf(note?.topics, 5),
            }),
          }),
        );
      }

      if (url.pathname === '/atlas') {
        const atlas = getAtlas();
        if (!atlas) return page(layout({ title: '星座图', active: 'atlas', body: renderError({ message: '还没有星座图，先运行 node tools/atlas.mjs' }) }), 404);
        return page(renderAtlasHtml(atlas, { title: '对话星座图', nav: NAV_HTML }));
      }

      if (url.pathname === '/topics') {
        const graph = getGraph();
        if (!graph) return page(layout({ title: '主题图谱', active: 'topics', body: renderError({ message: '还没有主题图谱，先运行 node tools/topics.mjs 和 node tools/graph.mjs' }) }), 404);
        return page(renderGraphHtml(graph, { title: '主题图谱', nav: NAV_HTML }));
      }

      if (url.pathname === '/api/search') {
        const query = (url.searchParams.get('q') ?? '').trim();
        if (!query) return send(400, JSON.stringify({ error: '缺少 q 参数' }), 'application/json; charset=utf-8');
        const result = await semanticSearch(query, Number(url.searchParams.get('top') ?? 12));
        return send(200, JSON.stringify(result), 'application/json; charset=utf-8');
      }

      if (url.pathname === '/tasks') {
        const vectors = getVectors();
        const embed = embedNet();
        const chat = chatNet();
        return page(
          layout({
            title: '任务',
            active: 'tasks',
            body: renderTasks({
              tasks: TASKS,
              endpoints: {
                chat: { baseUrl: chat.baseUrl, hasKey: Boolean(chat.apiKey), model: runtime.config.chatModel },
                embed: { baseUrl: embed.baseUrl, hasKey: Boolean(embed.apiKey), model: vectors?.model ?? runtime.config.embedModel },
              },
              config: { ...runtime.config, embedBaseUrl: embed.baseUrl },
            }),
          }),
        );
      }

      if (url.pathname === '/api/config') {
        if (req.method === 'GET') {
          const embed = embedNet();
          const chat = chatNet();
          return send(
            200,
            JSON.stringify({
              ...runtime.config,
              chatBaseUrl: chat.baseUrl,
              embedBaseUrl: embed.baseUrl,
              chatApiKey: chat.apiKey ? '已保存' : '',
              embedApiKey: embed.apiKey ? '已保存' : '',
            }),
            'application/json; charset=utf-8',
          );
        }

        if (req.method === 'POST') {
          let payload;
          try {
            payload = JSON.parse(await readBody(req));
          } catch {
            return send(400, JSON.stringify({ error: '请求体不是合法 JSON' }), 'application/json; charset=utf-8');
          }

          // Key 留空表示"不修改"，避免每次保存都把已存的 Key 冲掉
          const patch = { ...payload };
          if (!String(patch.chatApiKey ?? '').trim()) delete patch.chatApiKey;
          if (!String(patch.embedApiKey ?? '').trim()) delete patch.embedApiKey;
          if (!String(patch.apiKey ?? '').trim()) delete patch.apiKey;

          const saved = saveConfig(outDir, patch);
          runtime.config = saved;
          // 配置改了就重新解析一次运行时端点
          Object.assign(runtime, resolveRuntime({ outDir, flagBaseUrl: options['base-url'], flagApiKey: options['api-key'] }));

          return send(200, JSON.stringify({ ok: true }), 'application/json; charset=utf-8');
        }
      }

      if (url.pathname === '/api/models') {
        const which = url.searchParams.get('which') === 'chat' ? 'chat' : 'embed';
        const net = which === 'chat' ? chatNet() : embedNet();
        const baseUrl = net.baseUrl;
        if (!baseUrl) {
          return send(400, JSON.stringify({ error: `先填${which === 'chat' ? '对话' : '嵌入'}端点地址` }), 'application/json; charset=utf-8');
        }
        const key = net.apiKey;
        try {
          const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
            headers: key ? { authorization: `Bearer ${key}` } : {},
            signal: AbortSignal.timeout(20000),
          });
          const text = await response.text();
          let ids = [];
          try {
            ids = (JSON.parse(text).data ?? []).map((m) => m.id).filter(Boolean).sort();
          } catch {
            return send(502, JSON.stringify({ error: `端点没返回模型列表：${text.slice(0, 120)}` }), 'application/json; charset=utf-8');
          }
          return send(200, JSON.stringify({ models: ids }), 'application/json; charset=utf-8');
        } catch (error) {
          return send(502, JSON.stringify({ error: `拉取失败：${oneLine(error)}` }), 'application/json; charset=utf-8');
        }
      }

      if (url.pathname === '/api/task') {
        if (req.method === 'GET') {
          return send(200, JSON.stringify(taskState), 'application/json; charset=utf-8');
        }

        if (req.method === 'POST') {
          if (taskState.running) {
            return send(409, JSON.stringify({ error: '已有任务在跑，等它结束' }), 'application/json; charset=utf-8');
          }

          let payload;
          try {
            payload = JSON.parse(await readBody(req));
          } catch {
            return send(400, JSON.stringify({ error: '请求体不是合法 JSON' }), 'application/json; charset=utf-8');
          }

          const task = TASKS[payload?.name];
          if (!task) {
            return send(400, JSON.stringify({ error: `没有这个任务：${payload?.name}` }), 'application/json; charset=utf-8');
          }

          const env = { chat: chatNet(), embed: embedNet() };

          // 先把状态占住再回 202：否则"响应已发出、任务还没开始"这条缝里，
          // 第二个请求会看到 running=false 而溜进来。
          taskState.running = true;
          taskState.name = payload.name;
          taskState.title = task.title;
          taskState.log = ['启动中…'];
          taskState.code = null;
          taskState.startedAt = Date.now();
          taskState.finishedAt = null;

          send(202, JSON.stringify({ ok: true, name: payload.name }), 'application/json; charset=utf-8');

          setImmediate(() => {
            executeTask(taskState, payload.name, payload.params ?? {}, env)
              .then(() => {
                // 产物变了，清掉缓存让页面立刻能看到
                cache.vectors = null;
                cache.atlas = null;
                cache.graph = null;
              })
              .catch((error) => {
                taskState.log.push(`! 任务异常：${oneLine(error)}`);
                taskState.running = false;
              });
          });

          return;
        }
      }

      if (url.pathname === '/api/health') {
        const vectors = getVectors();
        return send(
          200,
          JSON.stringify({
            ok: true,
            conversations: Object.keys(getIndex().sessions).length,
            vectors: vectors ? Object.keys(vectors.items).length : 0,
            hasKey: Boolean(embedNet().apiKey),
            chatEndpoint: chatNet().baseUrl || null,
            embedEndpoint: embedNet().baseUrl || null,
          }),
          'application/json; charset=utf-8',
        );
      }

      return page(layout({ title: '404', body: renderError({ message: `没有这个页面：${url.pathname}` }) }), 404);
    } catch (error) {
      log(`! ${oneLine(error)}`);
      return page(layout({ title: '出错了', body: renderError({ message: oneLine(error) }) }), 500);
    }
  });

  const port = options.port;
  server.listen(port, '127.0.0.1', () => {
    const target = `http://127.0.0.1:${port}`;
    log('');
    log(`对话档案 → ${target}`);
    log(`数据 ${dataDir} · 向量 ${outDir}`);
    const embed = embedNet();
    const chat = chatNet();
    log('嵌入端点：' + (embed.baseUrl || '未配置') + (embed.apiKey ? '（Key 已加载）' : '（缺少 Key）'));
    log('对话端点：' + (chat.baseUrl || '未配置') + (chat.apiKey ? '（Key 已加载）' : '（无 Key）'));
    log('只监听 127.0.0.1，按 Ctrl+C 停止');
    log('');
    if (options.open) execFile('cmd', ['/c', 'start', '', target], () => {});
  });
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) main();
