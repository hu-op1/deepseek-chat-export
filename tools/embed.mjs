#!/usr/bin/env node
/**
 * 第一步：把每个对话变成一条向量，缓存到本地。
 *
 *   node tools/embed.mjs --base-url https://api.openai.com/v1 --model text-embedding-3-small
 *   node tools/embed.mjs --base-url … --model … --limit 20     # 先试 20 条
 *
 * 换模型必须加 --force：不同模型的向量空间无法混用。
 */

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import process from 'node:process';

import { parseArgs, usage } from '../lib/args.mjs';
import { createEmbeddingClient, EmbedError, encodeVector, normalize } from '../lib/embed.mjs';
import { atomicWriteJson, loadIndex } from '../lib/store.mjs';
import { buildSnippet, monthOf, sessionMessages } from '../lib/topics.mjs';
import { clip, createGate, oneLine } from '../lib/util.mjs';

const SPEC = {
  'base-url': { type: 'string', desc: 'OpenAI 兼容端点，如 https://api.openai.com/v1' },
  model: { type: 'string', desc: '嵌入模型名，如 text-embedding-3-small / bge-m3' },
  'api-key': { type: 'string', desc: 'API Key（也可用环境变量 DS_API_KEY）' },
  data: { type: 'string', default: 'data', desc: '备份目录（默认 data）' },
  out: { type: 'string', default: 'memory', desc: '输出目录（默认 memory）' },
  limit: { type: 'number', default: 0, desc: '只处理最近 N 个（先验证端点）' },
  chars: { type: 'number', default: 1000, desc: '每个对话送进嵌入模型的正文字符上限' },
  batch: { type: 'number', default: 16, desc: '每批多少条（默认 16）' },
  force: { type: 'boolean', desc: '忽略已有缓存，全部重算（换模型时必须用）' },
  'dry-run': { type: 'boolean', desc: '只打印将要处理的清单' },
  help: { type: 'boolean', alias: 'h', desc: '显示帮助' },
};

const log = (m = '') => console.log(m);

/** 送进嵌入模型的文本：标题 + 正文开头。嵌入的是"这段话讲什么"，不是"每一句"。 */
function embeddingText(title, messages, maxChars) {
  const { text } = buildSnippet(messages, maxChars);
  return `标题：${title || '(无标题)'}\n${text}`;
}

function loadCache(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    log(`! 现有向量缓存损坏（${oneLine(error)}），将重建`);
    return null;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv, SPEC);
  if (options.help) {
    log(usage('把 497 个对话各自嵌入成一条向量', SPEC));
    return 0;
  }

  const apiKey = options['api-key'] ?? process.env.DS_API_KEY ?? process.env.OPENAI_API_KEY ?? null;
  const dataDir = path.resolve(options.data);
  const outDir = path.resolve(options.out);
  const cacheFile = path.join(outDir, 'vectors.json');

  fs.mkdirSync(outDir, { recursive: true });

  const index = loadIndex(dataDir);
  const all = Object.entries(index.sessions)
    .map(([id, entry]) => ({ id, ...entry }))
    .filter((entry) => entry.file)
    .sort((a, b) => (Number(b.updated_at) || 0) - (Number(a.updated_at) || 0));

  if (all.length === 0) {
    log(`! ${dataDir} 里没有备份数据。先跑 node export.mjs。`);
    return 1;
  }

  if (!options['base-url'] || !options.model) {
    log('! 需要 --base-url 和 --model。例如：');
    log('  node tools/embed.mjs --base-url https://api.openai.com/v1 --model text-embedding-3-small');
    return 1;
  }

  const cache = loadCache(cacheFile);
  if (cache && !options.force && (cache.model !== options.model || !cache.dim)) {
    log(`! 现有缓存是「${cache.model}」的（${cache.dim} 维），与 --model ${options.model} 不兼容。`);
    log('  不同模型的向量空间无法混用。要换模型请加 --force 全部重算。');
    return 1;
  }

  const existing = cache && !options.force ? cache.items ?? {} : {};
  const scoped = options.limit > 0 ? all.slice(0, options.limit) : all;
  const missing = scoped.filter((entry) => !existing[entry.id]);

  log(`备份目录：${dataDir}（共 ${all.length} 个对话）`);
  log(`已有向量：${Object.keys(existing).length} 个`);
  log(`本次待处理：${missing.length} 个${options.limit > 0 ? `（--limit ${options.limit}）` : ''}`);

  if (options['dry-run']) {
    for (const entry of missing.slice(0, 20)) log(`  · ${clip(entry.title, 44)}`);
    if (missing.length > 20) log(`  …还有 ${missing.length - 20} 个`);
    log('\n--dry-run：未调用嵌入端点。');
    return 0;
  }
  if (missing.length === 0) {
    log('\n所有对话都已有向量，无需处理。');
    return 0;
  }

  const client = createEmbeddingClient({
    baseUrl: options['base-url'],
    apiKey,
    model: options.model,
    batchSize: options.batch,
    gate: createGate({ gapMs: 200, maxGapMs: 5000 }),
    log,
  });
  log(`\n嵌入端点：${client.describe()}`);

  // 先把文本都准备好，再分批嵌入（请求是瓶颈，磁盘不是）
  const prepared = [];
  for (const entry of missing) {
    const sessionJson = JSON.parse(fs.readFileSync(path.join(dataDir, entry.file), 'utf8'));
    const messages = sessionMessages(sessionJson);
    prepared.push({
      entry,
      text: embeddingText(entry.title, messages, options.chars),
      month: monthOf(Number(entry.updated_at) > 1e11 ? Number(entry.updated_at) : Number(entry.updated_at) * 1000),
    });
  }

  let vectors;
  try {
    vectors = await client.embed(prepared.map((item) => item.text));
  } catch (error) {
    if (error instanceof EmbedError && error.kind === 'no-endpoint') {
      log('\n! 这个端点没有 /embeddings 接口。');
      log('  很多 OpenAI 兼容中转只提供 chat。换一个支持嵌入的端点，或本地跑 Ollama：');
      log('    ollama pull nomic-embed-text');
      log('    node tools/embed.mjs --base-url http://127.0.0.1:11434/v1 --model nomic-embed-text');
      return 2;
    }
    if (error instanceof EmbedError && error.kind === 'auth') {
      log(`\n! ${error.message}`);
      return 2;
    }
    throw error;
  }

  const dim = vectors[0]?.length ?? 0;
  // --force 就是"整体重算"，旧缓存的维度不该再拦人（换模型时维度必然变）
  if (cache && !options.force && cache.dim && dim && cache.dim !== dim) {
    log(`! 端点返回的维度是 ${dim}，与缓存里的 ${cache.dim} 不一致，无法混用。`);
    log('  换模型请加 --force 全部重算。');
    return 1;
  }

  const items = { ...existing };
  vectors.forEach((vector, i) => {
    const { entry, month } = prepared[i];
    items[entry.id] = { v: encodeVector(normalize(vector)), t: entry.title ?? '', m: month };
  });

  atomicWriteJson(cacheFile, {
    schema: 1,
    model: options.model,
    baseUrl: options['base-url'],
    dim,
    normalized: true,
    createdAt: new Date().toISOString(),
    items,
  });

  log(`\n完成：${Object.keys(items).length} 条向量，${dim} 维`);
  log(`缓存：${cacheFile}（${(fs.statSync(cacheFile).size / 1024 / 1024).toFixed(2)} MB）`);
  log('\n下一步：');
  log('  node tools/ask.mjs "那次聊显存不够的事"     # 语义搜索');
  log('  node tools/atlas.mjs                        # 生成星座图');
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
