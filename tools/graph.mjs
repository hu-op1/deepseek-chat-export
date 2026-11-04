#!/usr/bin/env node
/**
 * 第二步：把标注结果聚合成图谱，并生成可视化页面。
 *
 *   node tools/graph.mjs                 # 读 memory/topics → 写 memory/graph.json + graph.html
 *   node tools/graph.mjs --open          # 顺便在浏览器里打开
 */

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';

import { parseArgs, usage } from '../lib/args.mjs';
import { aggregate } from '../lib/topics.mjs';
import { renderGraphHtml } from '../lib/graph-html.mjs';
import { atomicWriteJson } from '../lib/store.mjs';
import { oneLine } from '../lib/util.mjs';

const SPEC = {
  out: { type: 'string', default: 'memory', desc: '标注所在目录（默认 memory）' },
  'max-edges': { type: 'number', default: 240, desc: '网络里最多画多少条边（默认 240）' },
  'min-edge': { type: 'number', default: 1, desc: '边的共现次数下限（默认 1）' },
  title: { type: 'string', default: '主题图谱', desc: '页面标题' },
  open: { type: 'boolean', desc: '生成后用默认浏览器打开' },
  help: { type: 'boolean', alias: 'h', desc: '显示帮助' },
};

const log = (m = '') => console.log(m);

function loadJsonl(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      } catch (error) {
        log(`  ! 跳过损坏文件 ${name}：${oneLine(error)}`);
        return null;
      }
    })
    .filter(Boolean);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv, SPEC);
  if (options.help) {
    log(usage('把标注聚合成主题图谱并渲染页面', SPEC));
    return 0;
  }

  const outDir = path.resolve(options.out);
  const topicDir = path.join(outDir, 'topics');
  const canonicalPath = path.join(outDir, 'canonical.json');

  const records = loadJsonl(topicDir);
  if (records.length === 0) {
    log(`! ${topicDir} 里没有标注结果。先跑：node tools/topics.mjs --base-url … --model …`);
    return 1;
  }
  if (!fs.existsSync(canonicalPath)) {
    log(`! 缺少 ${canonicalPath}（主题归并结果）。先跑：node tools/topics.mjs --merge-only --base-url … --model …`);
    return 1;
  }

  const canonical = JSON.parse(fs.readFileSync(canonicalPath, 'utf8'));
  const graph = aggregate({
    records,
    canonical,
    maxEdges: options['max-edges'],
    minEdgeWeight: options['min-edge'],
  });

  atomicWriteJson(path.join(outDir, 'graph.json'), graph);
  fs.writeFileSync(path.join(outDir, 'graph.html'), renderGraphHtml(graph, { title: options.title }), 'utf8');

  log(`已标注对话：${records.length} 个`);
  log(`主题：${graph.counts.topics} 个，共现边：${graph.counts.edges} 条`);
  log(`时间跨度：${graph.months[0] ?? '?'} → ${graph.months.at(-1) ?? '?'}`);

  if (graph.unmapped.length) {
    log(`\n! 有 ${graph.unmapped.length} 种标签没归进任何主题（这些对话不会出现在图里）：`);
    for (const item of graph.unmapped.slice(0, 8)) log(`  · ${item.label}（${item.count} 次）`);
    log('  解决：node tools/topics.mjs --merge-only --grain 40');
  }

  const top = graph.topics.slice(0, 5);
  if (top.length) {
    log('\n最大的几个主题：');
    for (const topic of top) log(`  ${String(topic.count).padStart(4)} 段  ${topic.label}`);
  }

  const dominance = top[0] ? top[0].count / graph.counts.conversations : 0;
  if (dominance > 0.6) {
    log(`\n! 「${top[0].label}」占了 ${Math.round(dominance * 100)}% 的对话，标签可能太泛。`);
    log('  可以加大 --grain 重新归并，或检查标注提示词。');
  }

  log(`\n图谱：${path.join(outDir, 'graph.json')}`);
  log(`页面：${path.join(outDir, 'graph.html')}`);

  if (options.open) {
    execFile('cmd', ['/c', 'start', '', path.join(outDir, 'graph.html')], () => {});
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
