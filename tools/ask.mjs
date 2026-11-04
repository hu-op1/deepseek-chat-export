#!/usr/bin/env node
/**
 * 语义搜索：用一句模糊描述找对话。
 *
 *   node tools/ask.mjs "那次聊显存不够的事"
 *   node tools/ask.mjs "摩托车怎么上牌" --top 5
 *   node tools/ask.mjs --similar <对话id>        # 找与某个已有对话最像的
 *
 * 之所以要嵌入而不是关键词：你想不起来自己当时用的是哪个词。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { parseArgs, usage } from '../lib/args.mjs';
import { createEmbeddingClient, decodeVector, nearest, normalize } from '../lib/embed.mjs';
import { loadIndex } from '../lib/store.mjs';
import { firstUserText, sessionMessages } from '../lib/topics.mjs';
import { clip, oneLine } from '../lib/util.mjs';

const SPEC = {
  top: { type: 'number', default: 10, desc: '返回多少条（默认 10）' },
  similar: { type: 'string', desc: '给定对话 id，找与它最像的（不用再嵌入查询）' },
  'api-key': { type: 'string', desc: 'API Key（也可用环境变量 DS_API_KEY）' },
  data: { type: 'string', default: 'data', desc: '备份目录（默认 data）' },
  out: { type: 'string', default: 'memory', desc: '向量缓存所在目录（默认 memory）' },
  json: { type: 'boolean', desc: '输出 JSON，方便管道处理' },
  help: { type: 'boolean', alias: 'h', desc: '显示帮助' },
};

const log = (m = '') => console.log(m);

function loadVectors(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function snippetOf(dataDir, entry, maxLen = 110) {
  try {
    const json = JSON.parse(fs.readFileSync(path.join(dataDir, entry.file), 'utf8'));
    return firstUserText(sessionMessages(json), maxLen);
  } catch {
    return '';
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const options = parseArgs(argv, SPEC);
  if (options.help) {
    log(usage('语义搜索：用一句模糊描述找对话', SPEC, '例：node tools/ask.mjs "那次聊显存不够的事"'));
    return 0;
  }

  // 第一个非选项参数就是查询
  const query = options._[0] ?? null;
  const vectorFile = path.join(path.resolve(options.out), 'vectors.json');
  const cache = loadVectors(vectorFile);

  if (!cache) {
    log(`! 找不到 ${vectorFile}。先跑：node tools/embed.mjs --base-url … --model …`);
    return 1;
  }

  const dataDir = path.resolve(options.data);
  const index = loadIndex(dataDir);
  const items = Object.entries(cache.items ?? {})
    .map(([id, item]) => ({ id, vector: decodeVector(item.v), title: item.t, month: item.m }))
    .filter((item) => item.vector.length > 0);

  if (items.length === 0) {
    log('! 向量缓存是空的，先跑 node tools/embed.mjs');
    return 1;
  }

  let target = null;
  let label = '';

  if (options.similar) {
    const hit = items.find((item) => item.id === options.similar);
    if (!hit) {
      log(`! 缓存里没有 id 为 ${options.similar} 的对话`);
      return 1;
    }
    target = hit.vector;
    label = `与「${clip(hit.title, 30)}」最像的`;
  } else {
    if (!query) {
      log('! 用法：node tools/ask.mjs "你想找的内容"');
      return 1;
    }

    const apiKey = options['api-key'] ?? process.env.DS_API_KEY ?? process.env.OPENAI_API_KEY ?? null;
    if (!cache.baseUrl || !cache.model) {
      log('! 缓存里没有记录端点信息，无法把查询也嵌入成同一个空间的向量。');
      return 1;
    }

    const client = createEmbeddingClient({ baseUrl: cache.baseUrl, apiKey, model: cache.model });
    const [vector] = await client.embed([query]);
    if (!vector) {
      log('! 嵌入查询失败');
      return 1;
    }
    target = normalize(vector);
    label = `与「${query}」最像的`;
  }

  const hits = nearest(target, items, options.top);

  if (options.json) {
    const out = hits.map((hit) => ({
      id: hit.id,
      score: Number(hit.score.toFixed(4)),
      title: hit.item.title,
      month: hit.item.month,
      snippet: index.sessions[hit.id] ? snippetOf(dataDir, index.sessions[hit.id]) : '',
    }));
    console.log(JSON.stringify(out, null, 2));
    return 0;
  }

  log(`\n${label}（共 ${items.length} 条向量，模型 ${cache.model}，${cache.dim} 维）\n`);
  hits.forEach((hit, i) => {
    const entry = index.sessions[hit.id];
    const snippet = entry ? snippetOf(dataDir, entry) : '';
    log(`${String(i + 1).padStart(2)}. ${(hit.score * 100).toFixed(1)}%  ${hit.item.month ?? '????-??'}  ${clip(hit.item.title, 46)}`);
    if (snippet) log(`    ${snippet}`);
  });
  log('');
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((error) => {
    console.error(`\n出错了：${oneLine(error)}`);
    process.exitCode = 1;
  });
