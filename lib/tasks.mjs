/**
 * 任务注册表：把各个 CLI 的能力变成服务端可以调用的动作。
 *
 * 每个工具都改造成 `export async function main(argv)` + isDirectRun 守卫，
 * 所以这里可以直接 import 调用，不需要起子进程、也不需要复制逻辑。
 *
 * 一个约束：同一时间只允许跑一个任务。这些动作都会写 memory/ 下的文件，
 * 并发跑会互相覆盖；而且它们的进度输出是靠临时接管 console.log 采集的。
 */

import { main as runExport } from '../export.mjs';
import { main as runTopics } from '../tools/topics.mjs';
import { main as runEmbed } from '../tools/embed.mjs';
import { main as runCluster } from '../tools/cluster.mjs';
import { main as runGraph } from '../tools/graph.mjs';
import { main as runAtlas } from '../tools/atlas.mjs';

export const TASKS = {
  selftest: {
    title: '接口自检',
    desc: '不带凭证探测 DeepSeek 接口是否还活着。抓不动时先点这个。',
    fields: [],
    build: () => ['--self-test'],
    run: runExport,
  },

  export: {
    title: '导出对话',
    desc: '从 DeepSeek 网页端抓取全部对话到 data/。需要登录凭证。',
    fields: [
      { name: 'token', label: '登录凭证', placeholder: '粘贴 copy(JSON.stringify(localStorage)) 的输出', required: true },
      { name: 'limit', label: '只抓最近 N 个（留空为全量）', placeholder: '例如 20' },
    ],
    build: ({ token, limit }) => {
      const argv = ['--token', String(token ?? ''), '--out', 'data', '--no-prompt'];
      if (limit) argv.push('--limit', String(limit));
      return argv;
    },
    run: runExport,
  },

  embed: {
    title: '建立向量',
    desc: '把每段对话嵌入成向量，搜索和星座图都依赖它。',
    fields: [
      { name: 'model', label: '嵌入模型', placeholder: 'bge-m3 / qwen3-embedding-8b', required: true, prefill: 'embedModel' },
      { name: 'force', label: '强制重算（换模型时必须勾选）', type: 'checkbox' },
    ],
    build: ({ model, force }, { baseUrl, apiKey }) => {
      const argv = ['--base-url', baseUrl, '--model', String(model ?? ''), '--api-key', apiKey ?? '', '--out', 'memory'];
      if (force) argv.push('--force');
      return argv;
    },
    run: runEmbed,
    needsEndpoint: true,
  },

  annotate: {
    title: '标注主题',
    desc: '用对话模型给每段对话打主题标签。断点续跑，已标的会跳过。',
    fields: [
      { name: 'model', label: '对话模型', placeholder: 'glm-5.3-flash / deepseek-chat', required: true, prefill: 'chatModel' },
      { name: 'limit', label: '只标最近 N 个', placeholder: '留空为全部待标注' },
      { name: 'maxTokens', label: '单次输出 token 上限', placeholder: '2500' },
      { name: 'maxChars', label: '每个对话送入的字符上限', placeholder: '1000000（留空=不限，超上下文会自动减半）' },
    ],
    build: ({ model, limit, maxTokens, maxChars }, { baseUrl, apiKey }) => {
      const argv = ['--base-url', baseUrl, '--model', String(model ?? ''), '--api-key', apiKey ?? '', '--out', 'memory'];
      if (limit) argv.push('--limit', String(limit));
      if (maxTokens) argv.push('--max-tokens', String(maxTokens));
      if (maxChars) argv.push('--max-chars', String(maxChars));
      return argv;
    },
    run: runTopics,
    needsEndpoint: true,
  },

  cluster: {
    title: '归并标签',
    desc: '把上百个原始标签聚成 30 类。走向量聚类，不需要 LLM，几十秒完成。',
    fields: [{ name: 'k', label: '聚成多少类', placeholder: '30' }],
    build: ({ k }, { apiKey }) => {
      const argv = ['--out', 'memory', '--api-key', apiKey ?? ''];
      if (k) argv.push('--k', String(k));
      return argv;
    },
    run: runCluster,
    needsEndpoint: true,
  },

  graph: {
    title: '生成主题图谱',
    desc: '聚合标注结果，产出 graph.json 与可视化页面。',
    fields: [],
    build: () => ['--out', 'memory'],
    run: runGraph,
  },

  atlas: {
    title: '生成星座图',
    desc: '把向量投影到二维。页内缩放、过滤、看近邻。',
    fields: [{ name: 'layout', label: '布局算法', placeholder: 'force（默认）或 tsne' }],
    build: ({ layout }) => {
      const argv = ['--out', 'memory'];
      if (layout) argv.push('--layout', String(layout));
      return argv;
    },
    run: runAtlas,
  },
};

/**
 * 跑一个任务，采集它的控制台输出。
 * @returns {Promise<void>}
 */
export async function executeTask(state, name, params, env) {
  const task = TASKS[name];
  if (!task) throw new Error(`没有名为 ${name} 的任务`);

  const argv = task.build(params, env);

  state.running = true;
  state.name = name;
  state.title = task.title;
  state.log = [];
  state.code = null;
  state.startedAt = Date.now();
  state.finishedAt = null;

  const originalLog = console.log;
  const originalError = console.error;
  const push = (prefix, args) => {
    const line = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
    state.log.push(prefix + line);
    if (state.log.length > 800) state.log.shift();
  };

  console.log = (...args) => push('', args);
  console.error = (...args) => push('! ', args);

  try {
    const code = await task.run(argv);
    state.code = code ?? 0;
  } catch (error) {
    state.code = 1;
    state.log.push(`! 出错了：${error?.message ?? error}`);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    state.running = false;
    state.finishedAt = Date.now();
  }
}
