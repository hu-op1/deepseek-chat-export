#!/usr/bin/env node
/**
 * 用向量聚类代替 LLM 归并。
 *
 * 为什么要这条备用路线：840 个标签一次性丢给模型，端点会直接 504；
 * 分块归并也会被推理预算拖死（每批几十秒，中途断了前功尽弃）。
 * 标签都是短词，嵌入 + k-means 十几秒就能跑完，而且完全确定、可复现。
 *
 *   node tools/cluster.mjs                 # 默认聚成 30 类
 *   node tools/cluster.mjs --k 20
 */

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import process from 'node:process';

import { parseArgs, usage } from '../lib/args.mjs';
import { createEmbeddingClient, cosine, decodeVector, encodeVector, normalize } from '../lib/embed.mjs';
import { atomicWriteJson } from '../lib/store.mjs';
import { oneLine } from '../lib/util.mjs';

const SPEC = {
  k: { type: 'number', default: 30, desc: '聚成多少类（默认 30）' },
  out: { type: 'string', default: 'memory', desc: '目录（默认 memory）' },
  'api-key': { type: 'string', desc: '嵌入端点 Key（也可用环境变量 DS_API_KEY）' },
  iterations: { type: 'number', default: 60, desc: 'k-means 迭代次数' },
  help: { type: 'boolean', alias: 'h', desc: '显示帮助' },
};

const log = (m = '') => console.log(m);

function loadLabels(topicDir) {
  const counts = new Map();
  if (!fs.existsSync(topicDir)) return [];
  for (const file of fs.readdirSync(topicDir).filter((f) => f.endsWith('.json'))) {
    let record;
    try {
      record = JSON.parse(fs.readFileSync(path.join(topicDir, file), 'utf8'));
    } catch {
      continue;
    }
    for (const topic of record.topics ?? []) {
      const label = String(topic.label ?? '').trim();
      if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }
  return [...counts.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
}

/** k-means++ 初始化，固定种子保证可复现。 */
function kmeans(vectors, k, iterations) {
  const n = vectors.length;
  if (n === 0) return { assignments: [], centroids: [] };
  const dim = vectors[0].length;

  let seed = 20261104;
  const rand = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  const centroids = [vectors[Math.floor(rand() * n)].slice()];
  while (centroids.length < Math.min(k, n)) {
    const distances = vectors.map((v) => {
      let best = -1;
      for (const c of centroids) best = Math.max(best, cosine(v, c));
      return 1 - best;
    });
    const total = distances.reduce((a, b) => a + b, 0) || 1;
    let target = rand() * total;
    let pick = 0;
    for (let i = 0; i < n; i += 1) {
      target -= distances[i];
      if (target <= 0) {
        pick = i;
        break;
      }
    }
    centroids.push(vectors[pick].slice());
  }

  let assignments = new Array(n).fill(0);

  for (let iter = 0; iter < iterations; iter += 1) {
    let moved = 0;
    for (let i = 0; i < n; i += 1) {
      let best = -Infinity;
      let bestIndex = 0;
      for (let c = 0; c < centroids.length; c += 1) {
        const sim = cosine(vectors[i], centroids[c]);
        if (sim > best) {
          best = sim;
          bestIndex = c;
        }
      }
      if (assignments[i] !== bestIndex) {
        assignments[i] = bestIndex;
        moved += 1;
      }
    }

    const sums = Array.from({ length: centroids.length }, () => new Float64Array(dim));
    const sizes = new Array(centroids.length).fill(0);
    for (let i = 0; i < n; i += 1) {
      const c = assignments[i];
      sizes[c] += 1;
      for (let d = 0; d < dim; d += 1) sums[c][d] += vectors[i][d];
    }
    for (let c = 0; c < centroids.length; c += 1) {
      if (sizes[c] === 0) continue;
      const next = new Float64Array(dim);
      for (let d = 0; d < dim; d += 1) next[d] = sums[c][d] / sizes[c];
      centroids[c] = normalize(next);
    }

    if (moved === 0) break;
  }

  return { assignments, centroids };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv, SPEC);
  if (options.help) {
    log(usage('把主题标签向量化后聚类，产出 canonical.json（不需要 LLM）', SPEC));
    return 0;
  }

  const apiKey = options['api-key'] ?? process.env.DS_API_KEY ?? process.env.OPENAI_API_KEY ?? null;
  const outDir = path.resolve(options.out);
  const topicDir = path.join(outDir, 'topics');
  const vectorFile = path.join(outDir, 'vectors.json');
  const labelFile = path.join(outDir, 'label-vectors.json');

  const labels = loadLabels(topicDir);
  if (labels.length === 0) {
    log(`! ${topicDir} 里没有标签。先跑 node tools/topics.mjs`);
    return 1;
  }
  if (!fs.existsSync(vectorFile)) {
    log(`! 缺少 ${vectorFile}（对话向量），需要它来确认嵌入端点信息`);
    return 1;
  }

  const conversationCache = JSON.parse(fs.readFileSync(vectorFile, 'utf8'));
  const { baseUrl, model } = conversationCache;
  log(`标签：${labels.length} 种，目标 ${options.k} 类`);
  log(`嵌入端点：${model} @ ${baseUrl}`);

  // 标签向量单独缓存：换 k 不必重新嵌入
  let cache = null;
  if (fs.existsSync(labelFile)) {
    try {
      cache = JSON.parse(fs.readFileSync(labelFile, 'utf8'));
    } catch {
      cache = null;
    }
  }
  if (cache && (cache.model !== model || cache.baseUrl !== baseUrl)) cache = null;

  const existing = cache?.items ?? {};
  const missing = labels.filter((item) => !existing[item.label]);

  if (missing.length) {
    if (!apiKey) {
      log('! 需要 API Key 来嵌入标签：--api-key 或 DS_API_KEY');
      return 1;
    }
    const client = createEmbeddingClient({ baseUrl, apiKey, model, batchSize: 32 });
    log(`正在嵌入 ${missing.length} 个标签…`);
    const vectors = await client.embed(missing.map((item) => item.label));
    vectors.forEach((vector, i) => {
      existing[missing[i].label] = encodeVector(normalize(vector));
    });
    atomicWriteJson(labelFile, {
      schema: 1,
      model,
      baseUrl,
      dim: vectors[0]?.length ?? 0,
      createdAt: new Date().toISOString(),
      items: existing,
    });
  } else {
    log('标签向量已缓存，跳过嵌入');
  }

  const items = labels
    .map((item) => ({ ...item, vector: decodeVector(existing[item.label]) }))
    .filter((item) => item.vector.length > 0);

  log('正在聚类…');
  const { assignments, centroids } = kmeans(
    items.map((item) => item.vector),
    Math.min(options.k, items.length),
    options.iterations,
  );

  // 用"离聚类中心最近的那个标签"给类命名——比随机挑一个更像人话
  const topics = centroids.map((centroid, index) => {
    const members = items
      .map((item, i) => ({ item, i }))
      .filter((entry) => assignments[entry.i] === index)
      .map((entry) => entry.item);

    if (members.length === 0) return null;

    let best = members[0];
    let bestSim = -Infinity;
    for (const member of members) {
      const sim = cosine(member.vector, centroid);
      if (sim > bestSim) {
        bestSim = sim;
        best = member;
      }
    }

    // 名字取中心标签；太长的（超过 14 字）截断，避免图里放不下
    const label = best.label.length > 14 ? best.label.slice(0, 12) : best.label;
    return {
      id: `c${index + 1}`,
      label,
      aliases: members.map((m) => m.label),
      count: members.length,
    };
  }).filter(Boolean);

  topics.sort((a, b) => b.aliases.length - a.aliases.length);
  const canonical = {
    generatedAt: new Date().toISOString(),
    grain: options.k,
    method: 'embedding-kmeans',
    topics: topics.map((topic, index) => ({ id: `c${index + 1}`, label: topic.label, aliases: topic.aliases })),
    stats: {
      rawLabels: labels.length,
      canonicalTopics: topics.length,
      model,
      k: options.k,
    },
  };

  atomicWriteJson(path.join(outDir, 'canonical.json'), canonical);

  log(`\n完成：${labels.length} 个标签 → ${topics.length} 类`);
  for (const topic of topics.slice(0, 12)) {
    log(`  ${String(topic.aliases.length).padStart(3)} 个标签  ${topic.label}`);
  }
  if (topics.length > 12) log(`  …还有 ${topics.length - 12} 类`);
  log(`\n下一步：node tools/graph.mjs`);
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
