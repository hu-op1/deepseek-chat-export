/**
 * 生成三维星座图数据：memory/atlas3d.json
 *
 * 和二维版（tools/atlas.mjs）的区别：多一个 z 轴，页面上可以拖动旋转。
 * 投影用 t-SNE（dims=3）——二维版之所以用力导向，是因为 497 个点在语义上是连续谱、
 * 离散团不明显；三维空间宽松得多，t-SNE 的局部结构优势能发挥出来。
 *
 * 纯计算，不调用任何模型。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { parseArgs, usage } from '../lib/args.mjs';
import { atomicWriteJson } from '../lib/store.mjs';
import { cosine, decodeVector, layout2d, pca3, tsne } from '../lib/embed.mjs';
import { oneLine } from '../lib/util.mjs';

const log = (m = '') => console.log(m);

const SPEC = {
  out: { type: 'string', default: 'memory', desc: '数据目录' },
  layout: { type: 'string', default: 'tsne', desc: '投影算法：tsne（默认，三维 t-SNE）或 pca' },
  neighbors: { type: 'number', default: 6, desc: '每个点记录几个最近邻（默认 6）' },
  iterations: { type: 'number', default: 600, desc: 't-SNE 迭代次数' },
  help: { type: 'boolean', alias: 'h', desc: '显示帮助' },
};

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv, SPEC);
  if (options.help) {
    log(usage('生成三维星座图数据（可拖动旋转）', SPEC));
    return 0;
  }

  const outDir = path.resolve(options.out);
  const vectorFile = path.join(outDir, 'vectors.json');
  const graphFile = path.join(outDir, 'graph.json');
  const target = path.join(outDir, 'atlas3d.json');

  if (!fs.existsSync(vectorFile)) {
    log(`! 缺少 ${vectorFile}，先跑 node tools/embed.mjs`);
    return 1;
  }

  const cache = JSON.parse(fs.readFileSync(vectorFile, 'utf8'));
  const ids = Object.keys(cache.items ?? {});
  if (!ids.length) {
    log('! 向量文件是空的');
    return 1;
  }

  log(`向量：${ids.length} 条，${cache.dim} 维（${cache.model}）`);

  const vectors = ids.map((id) => decodeVector(cache.items[id].v));
  const usable = ids.filter((_, i) => vectors[i].length > 0);
  const usableVectors = vectors.filter((v) => v.length > 0);

  // 标题/月份/摘要从图谱或索引里取，取不到就留空
  let meta = {};
  if (fs.existsSync(graphFile)) {
    try {
      meta = JSON.parse(fs.readFileSync(graphFile, 'utf8')).conversations ?? {};
    } catch {
      meta = {};
    }
  }

  log(`正在计算最近邻（${options.neighbors} 个）…`);
  const k = Math.max(1, Math.min(options.neighbors, usable.length - 1));
  const neighborLists = usableVectors.map((vector, i) => {
    const scored = [];
    for (let j = 0; j < usableVectors.length; j += 1) {
      if (i === j) continue;
      scored.push([j, cosine(vector, usableVectors[j])]);
    }
    scored.sort((a, b) => b[1] - a[1]);
    return scored.slice(0, k).map(([j, score]) => ({ id: usable[j], score: Number(score.toFixed(4)) }));
  });

  const started = Date.now();
  log(`正在计算三维投影（${usable.length} 个点）…`);
  let raw;
  if (options.layout === 'pca') {
    raw = pca3(usableVectors);
  } else {
    raw = tsne(usableVectors, { dims: 3, iterations: options.iterations });
  }
  log(`  完成，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);

  // 归一化到 [-1, 1]，页面只需要相对位置
  const spans = [0, 1, 2].map((d) => {
    let max = 0;
    for (const point of raw) max = Math.max(max, Math.abs(point[d] ?? 0));
    return max || 1;
  });

  const points = usable.map((id, i) => {
    const info = meta[id] ?? {};
    return {
      id,
      t: info.title ?? '(无标题)',
      m: info.month ?? '',
      s: info.summary ?? '',
      x: Number(((raw[i][0] ?? 0) / spans[0]).toFixed(5)),
      y: Number(((raw[i][1] ?? 0) / spans[1]).toFixed(5)),
      z: Number(((raw[i][2] ?? 0) / spans[2]).toFixed(5)),
      n: neighborLists[i],
    };
  });

  atomicWriteJson(target, {
    schema: 1,
    generatedAt: new Date().toISOString(),
    model: cache.model,
    dim: cache.dim,
    layout: options.layout === 'pca' ? 'pca3' : 'tsne3',
    points,
  });

  const byMonth = new Map();
  for (const point of points) if (point.m) byMonth.set(point.m, (byMonth.get(point.m) ?? 0) + 1);

  log('');
  log(`点：${points.length} 个，月份：${[...byMonth.keys()].sort().join('、')}`);
  log(`数据：${target}`);
  log('页面：/atlas3d');
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    log(`\n出错了：${oneLine(error)}`);
    process.exitCode = 1;
  }
}
