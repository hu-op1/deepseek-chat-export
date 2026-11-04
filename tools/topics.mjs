#!/usr/bin/env node
/**
 * 第一步：给每个对话打主题标签，再把自由标签归并成规范主题。
 *
 *   node tools/topics.mjs --base-url https://api.deepseek.com/v1 --model deepseek-chat --limit 20
 *   node tools/topics.mjs                       # 全量（已标注的自动跳过）
 *   node tools/topics.mjs --merge-only          # 只重跑归并，不重新标注
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { parseArgs, usage } from '../lib/args.mjs';
import { createLlmClient, LlmError } from '../lib/llm.mjs';
import { atomicWriteJson, loadIndex } from '../lib/store.mjs';
import {
  ANNOTATION_SYSTEM,
  MERGE_SYSTEM,
  annotationPrompt,
  buildSnippet,
  mergePrompt,
  monthOf,
  normalizeAnnotation,
  normalizeMerge,
  sessionMessages,
} from '../lib/topics.mjs';
import { clip, createGate, oneLine, pool } from '../lib/util.mjs';

const SPEC = {
  'base-url': { type: 'string', desc: 'OpenAI 兼容端点，如 https://api.deepseek.com/v1' },
  model: { type: 'string', desc: '模型名，如 deepseek-chat' },
  'api-key': { type: 'string', desc: 'API Key（也可用环境变量 DS_API_KEY）' },
  data: { type: 'string', default: 'data', desc: '备份目录（默认 data）' },
  out: { type: 'string', default: 'memory', desc: '输出目录（默认 memory）' },
  limit: { type: 'number', default: 0, desc: '只标注最近 N 个（先小样本试质量）' },
  force: { type: 'boolean', desc: '忽略已有标注，全部重标' },
  'merge-only': { type: 'boolean', desc: '只重跑归并步骤' },
  'max-chars': { type: 'number', default: 6000, desc: '每个对话送进模型的字符上限' },
  grain: { type: 'number', default: 30, desc: '归并后的主题数量（默认 30）' },
  concurrency: { type: 'number', default: 3, desc: '并发数（默认 3）' },
  delay: { type: 'number', default: 400, desc: '请求最小间隔毫秒（默认 400）' },
  'dry-run': { type: 'boolean', desc: '只打印将要标注的清单，不调用模型' },
  help: { type: 'boolean', alias: 'h', desc: '显示帮助' },
};

const log = (m = '') => console.log(m);

function countLabels(records) {
  const counts = new Map();
  for (const record of records) {
    const seen = new Set();
    for (const topic of record.topics ?? []) {
      if (seen.has(topic.label)) continue;
      seen.add(topic.label);
      counts.set(topic.label, (counts.get(topic.label) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function loadRecords(topicDir) {
  if (!fs.existsSync(topicDir)) return [];
  return fs
    .readdirSync(topicDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(topicDir, name), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function runMerge({ client, records, outDir, grain }) {
  const labelCounts = countLabels(records);
  if (labelCounts.length === 0) {
    log('没有可归并的标签，跳过归并步骤。');
    return null;
  }

  log(`\n正在把 ${labelCounts.length} 个原始标签归并成约 ${grain} 个规范主题…`);
  const { data, usage } = await client.json({
    system: MERGE_SYSTEM,
    user: mergePrompt(labelCounts, grain),
    maxTokens: 4000,
    temperature: 0,
  });

  const { topics, missing } = normalizeMerge(data, labelCounts.map((item) => item.label));
  const canonical = {
    generatedAt: new Date().toISOString(),
    grain,
    topics,
    stats: { rawLabels: labelCounts.length, canonicalTopics: topics.length, missing, usage },
  };

  atomicWriteJson(path.join(outDir, 'canonical.json'), canonical);

  log(`归并完成：${labelCounts.length} 个原始标签 → ${topics.length} 个规范主题`);
  for (const topic of topics.slice(0, 12)) {
    log(`  ${topic.label.padEnd(12)} ← ${topic.aliases.length} 个别名`);
  }
  if (topics.length > 12) log(`  …还有 ${topics.length - 12} 个`);

  if (missing.length) {
    log(`  ! 有 ${missing.length} 个标签没被归并（已收进"其他"）：${missing.slice(0, 8).join('、')}`);
  }
  if (topics.length > grain * 2.5 || topics.length < grain * 0.4) {
    log(`  ! 主题数量 ${topics.length} 与目标 ${grain} 偏差较大，可以用 --merge-only --grain ${grain} 再调一次`);
  }

  return canonical;
}

async function main() {
  const options = parseArgs(process.argv.slice(2), SPEC);
  if (options.help) {
    log(usage('用模型给每个对话打主题标签', SPEC));
    return 0;
  }

  const apiKey = options['api-key'] ?? process.env.DS_API_KEY ?? process.env.OPENAI_API_KEY ?? null;
  const dataDir = path.resolve(options.data);
  const outDir = path.resolve(options.out);
  const topicDir = path.join(outDir, 'topics');

  fs.mkdirSync(topicDir, { recursive: true });
  const index = loadIndex(dataDir);
  const all = Object.entries(index.sessions)
    .map(([id, entry]) => ({ id, ...entry }))
    .filter((entry) => entry.file)
    .sort((a, b) => (Number(b.updated_at) || 0) - (Number(a.updated_at) || 0));

  if (all.length === 0) {
    log(`! ${dataDir} 里没有备份数据。先跑 node export.mjs。`);
    return 1;
  }

  const needsAnnotate = options.force
    ? all
    : all.filter((entry) => !fs.existsSync(path.join(topicDir, `${entry.id}.json`)));
  const scoped = options.limit > 0 ? needsAnnotate.slice(0, options.limit) : needsAnnotate;

  if (!options['merge-only']) {
    log(`备份目录：${dataDir}（共 ${all.length} 个对话）`);
    log(`待标注：${scoped.length} 个${options.limit > 0 ? `（--limit ${options.limit}）` : ''}，已完成：${all.length - needsAnnotate.length} 个`);
  }

  if (options['dry-run']) {
    for (const entry of scoped.slice(0, 20)) log(`  · ${clip(entry.title, 40)}`);
    if (scoped.length > 20) log(`  …还有 ${scoped.length - 20} 个`);
    log('\n--dry-run：未调用模型。');
    return 0;
  }

  let client = null;
  if (!options['merge-only']) {
    if (!options['base-url'] || !options.model) {
      log('! 需要 --base-url 和 --model。例如：');
      log('  node tools/topics.mjs --base-url https://api.deepseek.com/v1 --model deepseek-chat'); 
      return 1;
    }

    client = createLlmClient({
      baseUrl: options['base-url'],
      apiKey,
      model: options.model,
      gate: createGate({ gapMs: options.delay, maxGapMs: 10000 }),
      log,
    });
    if (!apiKey) log('! 没有提供 API Key（--api-key 或 DS_API_KEY），如果端点不需要鉴权可忽略');

    log(`\n模型：${client.describe()}`);
    log('');

    const failures = [];
    let done = 0;
    let usedTokens = 0;

    await pool(scoped, options.concurrency, async (entry) => {
      try {
        const sessionJson = JSON.parse(fs.readFileSync(path.join(dataDir, entry.file), 'utf8'));
        const messages = sessionMessages(sessionJson);
        if (messages.length === 0) throw new Error('对话没有可读内容');

        const { text, truncated, fullChars } = buildSnippet(messages, options['max-chars']);
        // updated_at 可能是秒也可能是毫秒
        const rawUpdated = Number(entry.updated_at);
        const millis = rawUpdated > 1e11 ? rawUpdated : rawUpdated * 1000;
        const month = monthOf(millis);

        const { data, usage } = await client.json({
          system: ANNOTATION_SYSTEM,
          user: annotationPrompt({ title: entry.title, month, snippet: text, truncated }),
          maxTokens: 700,
          temperature: 0,
        });

        const annotation = normalizeAnnotation(data);
        if (annotation.topics.length === 0) throw new Error('模型没给出任何可用主题');

        const record = {
          id: entry.id,
          title: entry.title,
          month,
          at: new Date(millis).toISOString(),
          summary: annotation.summary,
          topics: annotation.topics,
          entities: annotation.entities,
          meta: {
            model: options.model,
            annotatedAt: new Date().toISOString(),
            fullChars,
            truncated,
            tokens: usage?.total_tokens ?? null,
          },
        };

        atomicWriteJson(path.join(topicDir, `${entry.id}.json`), record);
        usedTokens += usage?.total_tokens ?? 0;
        done += 1;
        log(`  [${done}/${scoped.length}] ✓ ${clip(entry.title, 34)}  → ${annotation.topics.map((t) => t.label).join(' / ')}`);
      } catch (error) {
        done += 1;
        failures.push({ entry, error });
        log(`  [${done}/${scoped.length}] ✗ ${clip(entry.title, 30)}  ${oneLine(error)}`);
        if (error instanceof LlmError && error.kind === 'auth') throw error;
      }
    });

    const ok = scoped.length - failures.length;
    log(`\n标注完成：成功 ${ok} 个，失败 ${failures.length} 个${usedTokens ? `，消耗 ${usedTokens} tokens` : ''}`);

    if (failures.length) {
      log('\n失败清单（重跑会自动重试这些）：');
      for (const item of failures.slice(0, 15)) {
        log(`  · ${clip(item.entry.title, 34)}：${oneLine(item.error)}`);
      }
      if (failures.length > 15) log(`  …还有 ${failures.length - 15} 个`);
      if (failures.some((item) => item.error instanceof LlmError && item.error.kind === 'auth')) {
        log('\n! API Key 无效，请检查 --api-key 或 DS_API_KEY');
        return 2;
      }
    }
  }

  const records = loadRecords(topicDir);
  if (options['merge-only'] || records.length > 0) {
    const mergeClient =
      client ??
      createLlmClient({
        baseUrl: options['base-url'],
        apiKey,
        model: options.model,
        gate: createGate({ gapMs: options.delay, maxGapMs: 10000 }),
        log,
      });

    if (!options['base-url'] || !options.model) {
      log('! 归并也需要 --base-url 和 --model');
      return 1;
    }

    await runMerge({ client: mergeClient, records, outDir, grain: options.grain });
    log(`\n下一步：node tools/graph.mjs  （生成图谱与可视化）`);
  }

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
