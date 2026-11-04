#!/usr/bin/env node
/**
 * 第二步：把向量投影成星座图。
 *
 *   node tools/atlas.mjs               # 生成 memory/atlas.html
 *   node tools/atlas.mjs --open
 *
 * 投影在 Node 里离线算好再写进页面，浏览器只负责画——
 * 这样每次打开不用重跑 t-SNE，也不会因为随机种子不同看到不同的图。
 */

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';

import { parseArgs, usage } from '../lib/args.mjs';
import { decodeVector, layout2d, nearest, tsne } from '../lib/embed.mjs';
import { buildAtlasPayload, normalizeCoords, renderAtlasHtml } from '../lib/atlas-html.mjs';
import { atomicWriteJson, loadIndex } from '../lib/store.mjs';
import { firstUserText, sessionMessages } from '../lib/topics.mjs';
import { clip, oneLine } from '../lib/util.mjs';

const SPEC = {
  data: { type: 'string', default: 'data', desc: '备份目录（默认 data）' },
  out: { type: 'string', default: 'memory', desc: '向量缓存与输出目录（默认 memory）' },
  neighbors: { type: 'number', default: 6, desc: '每个点记几个近邻（默认 6）' },
  layout: { type: 'string', default: 'force', desc: '布局算法：force（默认）或 tsne' },
  perplexity: { type: 'number', default: 30, desc: 't-SNE 困惑度（仅在 --layout tsne 时生效）' },
  iterations: { type: 'number', default: 600, desc: 't-SNE 迭代次数（默认 600）' },
  title: { type: 'string', default: '对话星座图', desc: '页面标题' },
  open: { type: 'boolean', desc: '生成后用默认浏览器打开' },
  help: { type: 'boolean', alias: 'h', desc: '显示帮助' },
};

const log = (m = '') => console.log(m);

function snippetFor(dataDir, entry) {
  try {
    const json = JSON.parse(fs.readFileSync(path.join(dataDir, entry.file), 'utf8'));
    return firstUserText(sessionMessages(json), 150);
  } catch {
    return '';
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv, SPEC);
  if (options.help) {
    log(usage('把向量投影成二维星座图', SPEC));
    return 0;
  }

  const dataDir = path.resolve(options.data);
  const outDir = path.resolve(options.out);
  const vectorFile = path.join(outDir, 'vectors.json');

  if (!fs.existsSync(vectorFile)) {
    log(`! 找不到 ${vectorFile}。先跑：node tools/embed.mjs --base-url … --model …`);
    return 1;
  }

  const cache = JSON.parse(fs.readFileSync(vectorFile, 'utf8'));
  const index = loadIndex(dataDir);

  const items = Object.entries(cache.items ?? {})
    .map(([id, item]) => ({
      id,
      vector: decodeVector(item.v),
      title: item.t ?? index.sessions[id]?.title ?? '',
      month: item.m ?? '',
    }))
    .filter((item) => item.vector.length > 0);

  if (items.length < 5) {
    log(`! 只有 ${items.length} 条向量，太少，画不出有意义的图。`);
    return 1;
  }

  log(`向量：${items.length} 条，${cache.dim} 维（${cache.model}）`);

  log('正在计算近邻…');
  const neighbors = {};
  for (const item of items) {
    neighbors[item.id] = nearest(item.vector, items, options.neighbors + 1)
      .filter((hit) => hit.id !== item.id)
      .slice(0, options.neighbors)
      .map((hit) => ({ id: hit.id, score: Number(hit.score.toFixed(4)) }));
  }
  log(`  完成，平均每点 ${options.neighbors} 个近邻`);

  const layout = options.layout === 'tsne' ? 'tsne' : 'force';
  log('正在计算二维投影（497 个点约需十几秒）…');
  const started = Date.now();
  const raw = layout === 'tsne'
    ? tsne(items.map((item) => item.vector), { perplexity: options.perplexity, iterations: options.iterations })
    : layout2d(items.map((item) => item.vector), { iterations: options.iterations });
  log(`  完成，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);

  const coords = normalizeCoords(raw);
  const months = [...new Set(items.map((item) => item.month).filter(Boolean))].sort();

  const points = items.map((item) => ({
    id: item.id,
    title: item.title,
    month: item.month,
    snippet: index.sessions[item.id] ? snippetFor(dataDir, index.sessions[item.id]) : '',
  }));

  const atlas = buildAtlasPayload({
    items: points,
    coords,
    neighbors,
    months,
    meta: { model: cache.model, dim: cache.dim, layout, builtAt: new Date().toISOString() },
  });

  atomicWriteJson(path.join(outDir, 'atlas.json'), atlas);
  fs.writeFileSync(path.join(outDir, 'atlas.html'), renderAtlasHtml(atlas, { title: options.title }), 'utf8');

  // 顺手报几个信号，让人知道图里大概有什么
  const scores = [];
  for (const item of items.slice(0, 60)) {
    const top = neighbors[item.id]?.[0];
    if (top) scores.push(top.score);
  }
  const avgTop = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

  log(`\n页面：${path.join(outDir, 'atlas.html')}`);
  log(`数据：${path.join(outDir, 'atlas.json')}`);
  log(`\n最相似邻居的平均相似度：${(avgTop * 100).toFixed(1)}%`);
  if (avgTop > 0.95) {
    log('  ! 偏高：说明很多对话彼此非常像（或嵌入模型区分度低），图会挤成一团。');
  } else if (avgTop < 0.6) {
    log('  · 偏低：说明对话之间差异很大，图会比较分散。');
  }

  if (options.open) {
    execFile('cmd', ['/c', 'start', '', path.join(outDir, 'atlas.html')], () => {});
  }
  return 0;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main()
    .then((code) => {
      process.exitCode = code ?? 0;
    })
    .catch((error) => {
      console.error(`\n出错了：${oneLine(error)}`);
      process.exitCode = 1;
    });
}
