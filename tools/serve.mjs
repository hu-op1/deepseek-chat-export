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

import { parseArgs, usage } from '../lib/args.mjs';
import { createEmbeddingClient, decodeVector, nearest, normalize } from '../lib/embed.mjs';
import { renderAtlasHtml } from '../lib/atlas-html.mjs';
import { renderGraphHtml } from '../lib/graph-html.mjs';
import { loadIndex } from '../lib/store.mjs';
import { firstUserText, monthOf, sessionMessages } from '../lib/topics.mjs';
import { layout, renderChat, renderError, renderOverview, renderSearch } from '../lib/web.mjs';
import { oneLine } from '../lib/util.mjs';

const SPEC = {
  port: { type: 'number', default: 7788, desc: '端口（默认 7788）' },
  data: { type: 'string', default: 'data', desc: '备份目录（默认 data）' },
  out: { type: 'string', default: 'memory', desc: '向量与图谱目录（默认 memory）' },
  'api-key': { type: 'string', desc: '嵌入端点 Key（也可用环境变量 DS_API_KEY）' },
  open: { type: 'boolean', desc: '启动后打开浏览器' },
  help: { type: 'boolean', alias: 'h', desc: '显示帮助' },
};

const NAV_HTML = `<nav class="top" style="border-bottom:2px solid #1B1F24;margin:0 -22px 26px;padding:14px 22px 0;display:flex;gap:22px;align-items:baseline;flex-wrap:wrap;font-family:var(--mono,monospace);font-size:12px">
<a href="/" style="text-decoration:none;color:#5A6470">← 返回档案</a></nav>`;

const log = (m = '') => console.log(m);

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

function main() {
  const options = parseArgs(process.argv.slice(2), SPEC);
  if (options.help) {
    log(usage('本地 web 界面：概览 / 搜索 / 对话阅读 / 星座图 / 主题图谱', SPEC));
    return;
  }

  const dataDir = path.resolve(options.data);
  const outDir = path.resolve(options.out);
  const apiKey = options['api-key'] ?? process.env.DS_API_KEY ?? process.env.OPENAI_API_KEY ?? null;

  // 全部按需加载并缓存：启动时不读 10MB 向量文件
  const cache = { index: null, vectors: null, atlas: null, graph: null };

  const getIndex = () => {
    cache.index ??= loadIndex(dataDir);
    return cache.index;
  };

  const getVectors = () => {
    if (cache.vectors !== null) return cache.vectors;
    const file = path.join(outDir, 'vectors.json');
    // 别把'文件还没生成'缓存住，否则生成后页面永远 404
    if (!fs.existsSync(file)) return false;
    cache.vectors = JSON.parse(fs.readFileSync(file, 'utf8'));
    return cache.vectors;
  };

  const getAtlas = () => {
    if (cache.atlas !== null) return cache.atlas;
    const file = path.join(outDir, 'atlas.json');
    if (!fs.existsSync(file)) return false;
    cache.atlas = JSON.parse(fs.readFileSync(file, 'utf8'));
    return cache.atlas;
  };

  const getGraph = () => {
    if (cache.graph !== null) return cache.graph;
    const file = path.join(outDir, 'graph.json');
    if (!fs.existsSync(file)) return false;
    cache.graph = JSON.parse(fs.readFileSync(file, 'utf8'));
    return cache.graph;
  };

  const readSession = (entry) => JSON.parse(fs.readFileSync(path.join(dataDir, entry.file), 'utf8'));

  /** 把查询词嵌入成向量，再和全部对话算余弦。 */
  async function semanticSearch(query, top = 12) {
    const vectors = getVectors();
    if (!vectors) {
      return { hits: [], error: '还没有向量缓存。先运行：node tools/embed.mjs --base-url … --model …' };
    }
    if (!apiKey) {
      return { hits: [], error: '服务端没有 API Key，无法把查询词嵌入。重启时加上 --api-key 或设置 DS_API_KEY。' };
    }

    const client = createEmbeddingClient({ baseUrl: vectors.baseUrl, apiKey, model: vectors.model });
    const [raw] = await client.embed([query]);
    if (!raw) return { hits: [], error: '嵌入端点没有返回向量。' };

    const target = normalize(raw);
    const items = Object.entries(vectors.items)
      .map(([id, item]) => ({ id, vector: decodeVector(item.v), title: item.t, month: item.m }))
      .filter((item) => item.vector.length > 0);

    const index = getIndex();
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
        messageCount,
      };
    });

    return { hits, model: vectors.model };
  }

  function overviewStats() {
    const index = getIndex();
    const entries = Object.values(index.sessions);
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

    return {
      stats: {
        conversations: entries.length,
        messages,
        chars,
        span: times.length
          ? `${new Date(toMs(Math.min(...times))).toISOString().slice(0, 10)} → ${new Date(toMs(Math.max(...times))).toISOString().slice(0, 10)}`
          : '无时间数据',
        vectors: vectors ? Object.keys(vectors.items).length : 0,
        vectorLabel: vectors ? `${vectors.dim} 维 · ${vectors.model}` : '尚未生成',
      },
      months,
      countsByMonth,
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

        return page(layout({ title: entry.title ?? '对话', body: renderChat({ entry, session, neighbors }) }));
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

      if (url.pathname === '/api/health') {
        const vectors = getVectors();
        return send(
          200,
          JSON.stringify({
            ok: true,
            conversations: Object.keys(getIndex().sessions).length,
            vectors: vectors ? Object.keys(vectors.items).length : 0,
            hasKey: Boolean(apiKey),
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
    log(apiKey ? '语义搜索：可用（服务端持有 Key）' : '语义搜索：缺少 API Key（加 --api-key 或设 DS_API_KEY）');
    log('只监听 127.0.0.1，按 Ctrl+C 停止');
    log('');
    if (options.open) execFile('cmd', ['/c', 'start', '', target], () => {});
  });
}

main();
