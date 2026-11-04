/**
 * 给聚类结果重新起名。
 *
 * 原来的类名是"离质心最近的那个标签"——机械，而且经常歪得离谱
 * （一个装了 51 段对话的类可能被叫成「Mamba模型架构」，只因为那个标签恰好离中心最近）。
 *
 * 这里让对话模型看每一类的成员标签，重新起一个概括性的名字。
 * 只改名字，不动 aliases 和 id，所以图谱、页面、已有引用都不用动。
 */

import fs from 'node:fs';
import path from 'node:path';

import { createLlmClient } from '../lib/llm.mjs';
import { atomicWriteJson } from '../lib/store.mjs';

const log = (m = '') => console.log(m);
import { parseArgs, usage } from '../lib/args.mjs';
import { oneLine } from '../lib/util.mjs';

const SPEC = {
  out: { type: 'string', default: 'memory', desc: '数据目录' },
  'base-url': { type: 'string', default: '', desc: '对话模型端点（默认读 memory/config.json）' },
  'api-key': { type: 'string', default: '', desc: 'API Key（默认读 DS_API_KEY 或配置）' },
  model: { type: 'string', default: '', desc: '对话模型（默认读配置）' },
  'per-call': { type: 'number', default: 8, desc: '一次请求处理多少个类的命名（默认 8）' },
  force: { type: 'boolean', desc: '连已经起过名的也重起（默认跳过 nameSource=llm 的）' },
  'dry-run': { type: 'boolean', desc: '只打印，不调用模型' },
  help: { type: 'boolean', alias: 'h', desc: '显示帮助' },
};

const SYSTEM = `你给对话归档里的主题聚类起名字。
输入是若干组标签，每组来自一次聚类，标签之间语义相近。
为每组起一个中文名字：4-12 个字，具体、能区分、不要用"其他""综合""杂项"这类空话。
输出严格 JSON：{"names":[{"id":"c1","name":"..."}]}`;

function promptOf(clusters) {
  return [
    '下面每组是一簇标签，请为每组起一个概括性的中文主题名：',
    '',
    ...clusters.map((c, i) => `第 ${i + 1} 组（id=${c.id}）：${c.aliases.slice(0, 14).join('、')}`),
    '',
    '只输出 JSON，不要解释。',
  ].join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv, SPEC);
  if (options.help) {
    log(usage('给聚类主题重新起名（用对话模型看成员标签）', SPEC));
    return 0;
  }

  const outDir = path.resolve(options.out);
  const file = path.join(outDir, 'canonical.json');
  if (!fs.existsSync(file)) {
    log(`! 没找到 ${file}，先跑 node tools/cluster.mjs`);
    return 1;
  }

  const canonical = JSON.parse(fs.readFileSync(file, 'utf8'));

  // 端点：命令行 > 配置 > 环境变量
  let config = {};
  const configFile = path.join(outDir, 'config.json');
  if (fs.existsSync(configFile)) {
    try {
      config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    } catch {
      config = {};
    }
  }

  const baseUrl = options['base-url'] || process.env.DS_CHAT_BASE_URL || config.chatBaseUrl || '';
  const apiKey = options['api-key'] || process.env.DS_CHAT_API_KEY || process.env.DS_API_KEY || config.chatApiKey || '';
  const model = options.model || config.chatModel || '';

  if (!baseUrl || !model) {
    log('! 缺少对话端点或模型名（--base-url / --model，或在网页端点设置里填）');
    return 1;
  }

  const targets = canonical.topics.filter((t) => options.force || t.nameSource !== 'llm');
  log(`主题 ${canonical.topics.length} 个，需要起名 ${targets.length} 个`);
  log(`模型：${model} @ ${baseUrl}`);

  if (options['dry-run']) {
    for (const t of targets.slice(0, 5)) log(`  · ${t.id} ${t.label} ← ${t.aliases.slice(0, 5).join('、')}`);
    log('\n--dry-run：未调用模型');
    return 0;
  }
  if (!targets.length) {
    log('都已经起过名了，用 --force 重来');
    return 0;
  }

  const client = createLlmClient({ baseUrl, apiKey, model });
  const byId = new Map(canonical.topics.map((t) => [t.id, t]));
  const size = Math.max(1, options['per-call']);
  const started = Date.now();
  let renamed = 0;

  for (let i = 0; i < targets.length; i += size) {
    const batch = targets.slice(i, i + size);
    try {
      const { data } = await client.json({ system: SYSTEM, user: promptOf(batch), maxTokens: 4000 });
      const names = Array.isArray(data?.names) ? data.names : [];

      for (const item of names) {
        const topic = byId.get(item?.id);
        const name = String(item?.name ?? '').trim();
        if (!topic || !name) continue;
        topic.label = name.slice(0, 24);
        topic.nameSource = 'llm';
        renamed += 1;
      }
    } catch (error) {
      log(`  ! 第 ${i / size + 1} 批失败：${oneLine(error)}`);
    }
    log(`  · ${Math.min(i + size, targets.length)}/${targets.length}`);
  }

  canonical.nameSource = 'llm';
  canonical.namedAt = new Date().toISOString();
  atomicWriteJson(file, canonical);

  log(`\n完成：${renamed} 个主题起了新名字，用时 ${((Date.now() - started) / 1000).toFixed(0)}s`);
  log('下一步：node tools/graph.mjs');
  return 0;
}

if (import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
