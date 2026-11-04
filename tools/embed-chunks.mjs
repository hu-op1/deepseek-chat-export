/**
 * 分段嵌入：给长对话切成若干段，每段一个向量。
 *
 * 为什么需要：整段嵌入时，27 万字的对话只取头 45% + 中段 + 尾 45%（默认 1000 字），
 * 覆盖率 1.5%。搜索"导师让我转投期刊"能不能命中全靠运气。
 * 切成段之后，每个片段一个向量，查询能精确落到某一段。
 *
 * 输出 memory/chunks.json：
 *   { model, dim, items: { <对话 id>: [ { i, from, to, chars, excerpt, at, v } ] } }
 * 只存片段开头的摘要文本，不存全文——定位到第几条消息就能回原文看。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { parseArgs, usage } from '../lib/args.mjs';
import { createEmbeddingClient, encodeVector, normalize } from '../lib/embed.mjs';
import { atomicWriteJson, loadIndex } from '../lib/store.mjs';
import { buildSnippet, sessionMessages } from '../lib/topics.mjs';
import { clip, createGate, oneLine } from '../lib/util.mjs';

const log = (m = '') => console.log(m);

const SPEC = {
  out: { type: 'string', default: 'memory', desc: '数据目录' },
  chars: { type: 'number', default: 1200, desc: '每段正文的目标字数（默认 1200）' },
  min: { type: 'number', default: 3000, desc: '对话超过多少字才切段（默认 3000，以下的整段一个向量就够）' },
  batch: { type: 'number', default: 16, desc: '每次请求嵌入多少段' },
  force: { type: 'boolean', desc: '忽略缓存，全部重算' },
  'dry-run': { type: 'boolean', desc: '只报告要切多少段，不调用模型' },
  help: { type: 'boolean', alias: 'h', desc: '显示帮助' },
};

/** 把消息按顺序攒成若干段，每段不超过 target 字。单条超长的就地截断。 */
export function chunkMessages(messages, target = 1200) {
  const chunks = [];
  let current = [];
  let size = 0;
  let from = 0;

  const flush = (to) => {
    if (!current.length) return;
    chunks.push({ from, to, text: current.join('\n') });
    current = [];
    size = 0;
  };

  messages.forEach((message, index) => {
    const body = `${message.role === 'USER' ? '我' : 'AI'}：${message.text ?? ''}`;
    const text = body.length > target * 1.6 ? `${body.slice(0, Math.round(target * 1.6))}……` : body;

    if (size > 0 && size + text.length > target) {
      flush(index - 1);
      from = index;
    }
    if (!current.length) from = index;
    current.push(text);
    size += text.length;
  });

  flush(messages.length - 1);
  return chunks;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv, SPEC);
  if (options.help) {
    log(usage('把长对话切成段，每段一个向量（检索长对话用）', SPEC));
    return 0;
  }

  const outDir = path.resolve(options.out);
  const dataDir = path.resolve('data');
  const vectorFile = path.join(outDir, 'vectors.json');
  const target = path.join(outDir, 'chunks.json');

  if (!fs.existsSync(vectorFile)) {
    log(`! 缺少 ${vectorFile}，先跑 node tools/embed.mjs`);
    return 1;
  }

  const vectors = JSON.parse(fs.readFileSync(vectorFile, 'utf8'));
  const index = loadIndex(dataDir);
  const apiKey = options['api-key'] ?? process.env.DS_API_KEY ?? process.env.DS_API_KEY ?? null;

  let cache = { items: {} };
  if (!options.force && fs.existsSync(target)) {
    try {
      const previous = JSON.parse(fs.readFileSync(target, 'utf8'));
      if (previous.model === vectors.model && previous.baseUrl === vectors.baseUrl) cache = previous;
    } catch {
      cache = { items: {} };
    }
  }

  // 1) 找出需要切段的对话，并按内容指纹判断缓存是否还有效
  const plan = [];
  let skippedShort = 0;
  for (const [id, entry] of Object.entries(index.sessions)) {
    if (!entry.file) continue;
    let session;
    try {
      session = JSON.parse(fs.readFileSync(path.join(dataDir, entry.file), 'utf8'));
    } catch {
      continue;
    }
    const messages = sessionMessages(session);
    if (!messages.length) continue;
    const full = buildSnippet(messages, 1e9).fullChars;
    if (full < options.min) {
      skippedShort += 1;
      continue;
    }

    const cached = cache.items[id];
    if (!options.force && cached?.hash === entry.content_hash && Array.isArray(cached?.chunks)) continue;

    const chunks = chunkMessages(messages, options.chars);
    plan.push({ id, title: entry.title, hash: entry.content_hash, chunks });
  }

  const totalChunks = plan.reduce((sum, item) => sum + item.chunks.length, 0);
  log(`对话总数 ${Object.keys(index.sessions).length}，低于 ${options.min} 字的跳过 ${skippedShort} 个`);
  log(`需要切段/更新的对话 ${plan.length} 个，共 ${totalChunks} 段`);

  if (options['dry-run']) {
    for (const item of plan.slice(0, 5)) {
      log(`  · ${clip(item.title, 26)} → ${item.chunks.length} 段（每段约 ${options.chars} 字）`);
    }
    log('\n--dry-run：未调用模型');
    return 0;
  }
  if (!plan.length) {
    log('全都已经是最新的，不需要重算（--force 可强制）');
    return 0;
  }

  const client = createEmbeddingClient({
    baseUrl: vectors.baseUrl,
    apiKey,
    model: vectors.model,
    batchSize: options.batch,
    gate: createGate({ gapMs: 150, maxGapMs: 5000 }),
    log,
  });
  log(`\n嵌入端点：${client.describe()}`);

  // 2) 逐个对话嵌入，每完成一批就落盘一次。
  // 3600 段要跑几十分钟，只在最后写文件的话中途一挂就全丢。
  const next = { ...cache.items };
  const started = Date.now();
  let doneChunks = 0;
  let doneConv = 0;
  let dim = cache.dim ?? 0;

  const flush = () => {
    const payload = {
      schema: 1,
      model: vectors.model,
      baseUrl: vectors.baseUrl,
      dim,
      createdAt: new Date().toISOString(),
      chars: options.chars,
      items: next,
    };
    atomicWriteJson(target, payload);
  };

  for (const item of plan) {
    const texts = item.chunks.map((chunk) => `标题：${item.title || '(无标题)'}\n${chunk.text}`);
    const out = await client.embed(texts);
    if (!dim && out[0]?.length) dim = out[0].length;

    next[item.id] = {
      hash: item.hash,
      chunks: item.chunks.map((chunk, i) => ({
        i,
        from: chunk.from,
        to: chunk.to,
        chars: chunk.text.length,
        excerpt: chunk.text.replace(/\s+/g, ' ').slice(0, 90),
        v: encodeVector(normalize(out[i])),
      })),
    };

    doneChunks += item.chunks.length;
    doneConv += 1;

    if (doneConv % 10 === 0 || doneConv === plan.length) {
      flush();
      const elapsed = (Date.now() - started) / 1000;
      const rate = doneChunks / Math.max(elapsed, 1);
      const left = (totalChunks - doneChunks) / Math.max(rate, 0.01);
      log(
        `  进度 ${doneChunks}/${totalChunks} 段（${doneConv}/${plan.length} 个对话）· ` +
          `已用 ${Math.round(elapsed)}s · 预计还要 ${Math.round(left / 60)} 分钟`,
      );
    }
  }
  flush();

  const chunkCount = Object.values(next).reduce((sum, item) => sum + (item.chunks?.length ?? 0), 0);
  log('');
  log(`文件：${target}`);
  log(`覆盖 ${Object.keys(next).length} 个对话，共 ${chunkCount} 段`);
  log(`大小：${(fs.statSync(target).size / 1024 / 1024).toFixed(1)} MB`);
  log('\n下一步：搜索会自动用上分段（匹配到哪一段会标出来）');
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
