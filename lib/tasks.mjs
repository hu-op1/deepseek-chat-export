/**
 * 任务注册表 + 执行器。
 *
 * 任务跑在**独立子进程**里，而不是 import 进来直接调。原因：
 * atlas 的二维投影、cluster 的 k-means 都是纯同步计算（几秒），
 * 在主进程里跑会把 Node 的事件循环占死——HTTP 响应发不出去、
 * 页面轮询拿不到进度、并发保护也形同虚设。
 *
 * 子进程还有个附带好处：日志天然是流式的，能边跑边看。
 *
 * 约束：同一时间只允许跑一个任务。它们都写 memory/ 下的同一批文件。
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export const TASKS = {
  selftest: {
    title: '接口自检',
    desc: '不带凭证探测 DeepSeek 接口是否还活着。抓不动时先点这个。',
    script: 'export.mjs',
    fields: [],
    build: () => ['--self-test'],
  },

  export: {
    title: '导出对话',
    desc: '从 DeepSeek 网页端抓取全部对话到 data/。需要登录凭证。',
    script: 'export.mjs',
    fields: [
      { name: 'token', label: '登录凭证', placeholder: '粘贴 copy(JSON.stringify(localStorage)) 的输出', required: true },
      { name: 'limit', label: '只抓最近 N 个（留空为全量）', placeholder: '例如 20' },
    ],
    build: ({ token, limit }) => {
      const argv = ['--token', String(token ?? ''), '--out', 'data', '--no-prompt'];
      if (limit) argv.push('--limit', String(limit));
      return argv;
    },
  },

  embed: {
    title: '建立向量',
    desc: '把每段对话嵌入成向量，搜索和星座图都依赖它。',
    script: 'tools/embed.mjs',
    endpoint: 'embed',
    fields: [
      { name: 'model', label: '嵌入模型', placeholder: 'bge-m3 / qwen3-embedding-8b', required: true, prefill: 'embedModel' },
      { name: 'force', label: '强制重算（换模型时必须勾选）', type: 'checkbox' },
    ],
    build: ({ model, force }, { baseUrl }) => {
      const argv = ['--base-url', baseUrl ?? '', '--model', String(model ?? ''), '--out', 'memory'];
      if (force) argv.push('--force');
      return argv;
    },
  },

  annotate: {
    title: '标注主题',
    desc: '用对话模型给每段对话打主题标签。断点续跑，已标的会跳过。',
    script: 'tools/topics.mjs',
    endpoint: 'chat',
    fields: [
      { name: 'model', label: '对话模型', placeholder: 'glm-5.3-flash / deepseek-chat', required: true, prefill: 'chatModel' },
      { name: 'limit', label: '只标最近 N 个', placeholder: '留空为全部待标注' },
      { name: 'maxTokens', label: '单次输出 token 上限', placeholder: '8000（小模型想得多，给宽一点）' },
      { name: 'maxChars', label: '每个对话送入的字符上限', placeholder: '1000000（留空=不限，超上下文会自动减半）' },
      { name: 'redoStale', label: '重标上次用了更小上限的对话（改大上限后勾选）', type: 'checkbox' },
    ],
    build: ({ model, limit, maxTokens, maxChars, redoStale }, { baseUrl }) => {
      const argv = ['--base-url', baseUrl ?? '', '--model', String(model ?? ''), '--out', 'memory'];
      if (limit) argv.push('--limit', String(limit));
      if (maxTokens) argv.push('--max-tokens', String(maxTokens));
      if (maxChars) argv.push('--max-chars', String(maxChars));
      if (redoStale) argv.push('--redo-stale');
      return argv;
    },
  },

  cluster: {
    title: '归并标签',
    desc: '把上百个原始标签聚成主题。走向量聚类，不需要 LLM；类数按标签数自适应。',
    script: 'tools/cluster.mjs',
    endpoint: 'embed',
    fields: [{ name: 'k', label: '聚成多少类（留空=自适应）', placeholder: '留空则按标签数自动，约每 12 个一类' }],
    build: ({ k }) => {
      const argv = ['--out', 'memory'];
      if (k) argv.push('--k', String(k));
      return argv;
    },
  },

  graph: {
    title: '生成主题图谱',
    desc: '聚合标注结果，产出 graph.json 与可视化页面。',
    script: 'tools/graph.mjs',
    fields: [],
    build: () => ['--out', 'memory'],
  },

  atlas: {
    title: '生成星座图',
    desc: '把向量投影到二维。页内缩放、过滤、看近邻。',
    script: 'tools/atlas.mjs',
    fields: [{ name: 'layout', label: '布局算法', placeholder: 'force（默认）或 tsne' }],
    build: ({ layout }) => {
      const argv = ['--out', 'memory'];
      if (layout) argv.push('--layout', String(layout));
      return argv;
    },
  },
};

/**
 * 跑一个任务：起子进程，把输出按行塞进 state。
 * 调用方应该先同步把 state.running 置 true（占位），再调用它——否则存在竞态。
 * @returns {Promise<void>} 任务结束时 resolve
 */
export function executeTask(state, name, params, env) {
  const task = TASKS[name];
  if (!task) return Promise.reject(new Error(`没有名为 ${name} 的任务`));

  // env 现在有两组端点；任务自己声明用哪一组（chat / embed / 不声明）
  const group = task.endpoint ? env?.[task.endpoint] : null;
  const argv = task.build(params, { baseUrl: group?.baseUrl ?? '', model: group?.model ?? '' });
  const script = path.join(ROOT, task.script);

  state.running = true;
  state.name = name;
  state.title = task.title;
  state.log = [];
  state.code = null;
  state.startedAt = Date.now();
  state.finishedAt = null;

  const push = (prefix, line) => {
    state.log.push(prefix + line);
    if (state.log.length > 800) state.log.shift();
  };

  return new Promise((resolve) => {
    let partial = '';
    const onChunk = (prefix) => (chunk) => {
      partial += chunk.toString('utf8');
      const lines = partial.split(/\r?\n/);
      partial = lines.pop() ?? '';
      for (const line of lines) push(prefix, line);
    };

    const child = spawn(process.execPath, [script, ...argv], {
      cwd: ROOT,
      env: {
        ...process.env,
        DS_API_KEY: group?.apiKey ?? '',
        DS_BASE_URL: group?.baseUrl ?? '',
      },
    });

    child.stdout.on('data', onChunk(''));
    child.stderr.on('data', onChunk('! '));

    child.on('error', (error) => {
      push('! ', `启动失败：${error.message}`);
      state.running = false;
      state.code = 1;
      state.finishedAt = Date.now();
      resolve();
    });

    child.on('close', (code) => {
      if (partial.trim()) push('', partial);
      state.code = code ?? 0;
      state.running = false;
      state.finishedAt = Date.now();
      resolve();
    });
  });
}
