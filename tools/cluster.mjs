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
  'embed-base-url': { type: 'string', desc: '标签嵌入端点（默认沿用对话向量的端点）' },
  'embed-model': { type: 'string', desc: '标签嵌入模型（默认沿用对话向量用的模型）' },
  k: { type: 'number', default: 0, desc: '聚成多少类（默认按标签数自适应：约每 12 个标签一类，上限 80）' },
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
/**
 * k-means（余弦距离）。
 *
 * 之前是朴素写法，两个地方复杂度写错了，k 一大就跑不动：
 *   1. 初始化每加一个中心，所有点都要跟"全部已有中心"重算一遍 → O(n·k²)
 *      实测 k=260 要 6500 万次 cosine，约 5000 亿次浮点运算
 *   2. cosine() 每次都重算两个向量的范数，但这里的向量早就归一化了 → 白算 3 倍
 *
 * 现在：向量拍平成一个 Float32Array（缓存友好），归一化后点积即余弦，
 * 初始化改成标准的增量做法（每点只维护"离最近中心的距离"）→ O(n·k)。
 */
function kmeans(rawVectors, k, iterations) {
  const n = rawVectors.length;
  if (n === 0) return { assignments: [], centroids: [] };

  const dim = rawVectors[0].length;
  const kk = Math.min(k, n);

  // 拍平 + 归一化（点积即余弦）
  const flat = new Float32Array(n * dim);
  for (let i = 0; i < n; i += 1) {
    let norm = 0;
    for (let d = 0; d < dim; d += 1) norm += rawVectors[i][d] * rawVectors[i][d];
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < dim; d += 1) flat[i * dim + d] = rawVectors[i][d] / norm;
  }

  const dotAt = (ai, bi) => {
    let sum = 0;
    for (let d = 0; d < dim; d += 1) sum += flat[ai + d] * flat[bi + d];
    return sum;
  };

  let seed = 20261104;
  const rand = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  // k-means++ 增量式：只跟最新加入的中心比较，O(n·k)
  const picked = [0];
  const best = new Float64Array(n);
  for (let i = 0; i < n; i += 1) best[i] = 1 - dotAt(i * dim, 0);

  while (picked.length < kk) {
    let total = 0;
    for (let i = 0; i < n; i += 1) total += best[i];
    if (total <= 0) break;

    let target = rand() * total;
    let pick = n - 1;
    for (let i = 0; i < n; i += 1) {
      target -= best[i];
      if (target <= 0) {
        pick = i;
        break;
      }
    }
    picked.push(pick);

    const base = pick * dim;
    for (let i = 0; i < n; i += 1) {
      const dist = 1 - dotAt(i * dim, base);
      if (dist < best[i]) best[i] = dist;
    }
  }

  const centroids = picked.map((index) => Float32Array.from(flat.subarray(index * dim, index * dim + dim)));
  const assignments = new Array(n).fill(-1);

  for (let iter = 0; iter < iterations; iter += 1) {
    let moved = 0;

    for (let i = 0; i < n; i += 1) {
      const base = i * dim;
      let bestSim = -Infinity;
      let bestIndex = 0;
      for (let c = 0; c < centroids.length; c += 1) {
        const centroid = centroids[c];
        let sum = 0;
        for (let d = 0; d < dim; d += 1) sum += flat[base + d] * centroid[d];
        if (sum > bestSim) {
          bestSim = sum;
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
      const base = i * dim;
      for (let d = 0; d < dim; d += 1) sums[c][d] += flat[base + d];
    }

    for (let c = 0; c < centroids.length; c += 1) {
      if (sizes[c] === 0) continue;
      let norm = 0;
      for (let d = 0; d < dim; d += 1) {
        sums[c][d] /= sizes[c];
        norm += sums[c][d] * sums[c][d];
      }
      norm = Math.sqrt(norm) || 1;
      for (let d = 0; d < dim; d += 1) sums[c][d] /= norm;
      centroids[c] = sums[c];
    }

    // 收敛就提前停：变动少于 0.1%
    if (moved / n < 0.001) break;
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

  // 标签向量和对话向量是两个独立的空间，不必用同一个嵌入模型：
  // 对话向量决定搜索/星座图，标签向量只用于把标签聚成主题。
  // 所以 --embed-base-url / --embed-model 可以单独指定（比如对话用远程 8b、标签用本地 4b）。
  const baseUrl = options['embed-base-url'] || conversationCache.baseUrl;
  const model = options['embed-model'] || conversationCache.model;

  // 固定的 k 是之前的问题：840 个标签塞进 30 类，每类 28 个，必然混进不相干的东西。
  // 默认按标签数量估算，每 12 个标签一类，夹在 15-80 之间。
  const k = options.k > 0 ? options.k : Math.min(80, Math.max(15, Math.round(labels.length / 12)));
  log(`标签：${labels.length} 种，目标 ${k} 类${options.k > 0 ? '（手动指定）' : '（按标签数自适应）'}`);
  log(`标签嵌入端点：${model} @ ${baseUrl}${options['embed-model'] ? '（手动指定）' : ''}`);

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
    // 本地端点（LM Studio / Ollama）不需要 Key
    const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(baseUrl);
    if (!apiKey && !isLocal) {
      log('! 需要 API Key 来嵌入标签：--api-key 或 DS_API_KEY');
      return 1;
    }

    const client = createEmbeddingClient({ baseUrl, apiKey, model, batchSize: 16 });
    log(`正在嵌入 ${missing.length} 个标签…`);

    // 分批嵌入并且每批落盘：1940 个标签要跑几十个请求，中途被 429 打断时
    // 已完成的批次不能白费（之前一次性提交，失败就全丢）。
    const CHUNK = 64;
    let done = 0;
    for (let start = 0; start < missing.length; start += CHUNK) {
      const slice = missing.slice(start, start + CHUNK);

      // 限流时指数退避重试，最多 6 次
      let vectors = null;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          vectors = await client.embed(slice.map((item) => item.label));
          break;
        } catch (error) {
          const retriable = /429|rate|too many|限流|timeout|ECONN|fetch failed/i.test(error.message);
          if (!retriable || attempt === 5) throw error;
          const wait = Math.min(30000, 1500 * 2 ** attempt);
          log(`  · 限流/网络错误，${Math.round(wait / 1000)}s 后重试（第 ${attempt + 1} 次）`);
          await new Promise((resolve) => setTimeout(resolve, wait));
        }
      }

      vectors.forEach((vector, i) => {
        existing[slice[i].label] = encodeVector(normalize(vector));
      });
      done += slice.length;

      atomicWriteJson(labelFile, {
        schema: 1,
        model,
        baseUrl,
        dim: vectors[0]?.length ?? 0,
        createdAt: new Date().toISOString(),
        items: existing,
      });
      log(`  · ${done}/${missing.length}`);
    }
  } else {
    log('标签向量已缓存，跳过嵌入');
  }

  const items = labels
    .map((item) => ({ ...item, vector: decodeVector(existing[item.label]) }))
    .filter((item) => item.vector.length > 0);

  log('正在聚类…');
  const { assignments, centroids } = kmeans(
    items.map((item) => item.vector),
    Math.min(k, items.length),
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
    grain: k,
    method: 'embedding-kmeans',
    topics: topics.map((topic, index) => ({ id: `c${index + 1}`, label: topic.label, aliases: topic.aliases })),
    stats: {
      rawLabels: labels.length,
      canonicalTopics: topics.length,
      model,
      k,
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
