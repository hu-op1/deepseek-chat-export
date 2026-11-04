/**
 * Web 层：把备份、向量、图谱渲染成可浏览的页面。
 *
 * 与静态页面共享同一套视觉语言（制图纸、宋体标题、等宽数字），
 * 但这里有导航和按需渲染——48MB 的 JSON 不能一次性塞进浏览器。
 */

import { escapeHtml, renderMarkdown } from './markdown.mjs';

const SHARED_CSS = `
  :root{
    --paper:#EBECE7; --panel:#F6F7F3; --ink:#1B1F24; --ink-soft:#5A6470; --ink-faint:#8B939C;
    --rule:#C2C6BE; --rule-soft:#DDE0D9; --accent:#B0722B;
    --mono: ui-monospace,"Cascadia Mono","SF Mono",Consolas,"Courier New",monospace;
    --sans: "PingFang SC","Microsoft YaHei","Noto Sans SC",system-ui,sans-serif;
    --serif: "Songti SC","SimSun","Noto Serif SC",serif;
  }
  *{box-sizing:border-box}
  html,body{margin:0;padding:0}
  body{background:var(--paper);color:var(--ink);font-family:var(--sans);font-size:14px;line-height:1.6;
    -webkit-font-smoothing:antialiased;
    background-image:
      repeating-linear-gradient(to right, rgba(27,31,36,.03) 0 1px, transparent 1px 96px),
      repeating-linear-gradient(to bottom, rgba(27,31,36,.03) 0 1px, transparent 1px 96px);}
  a{color:inherit}
  .wrap{max-width:980px;margin:0 auto;padding:0 22px 60px}

  nav.top{border-bottom:2px solid var(--ink);margin:0 -22px 26px;padding:14px 22px 0;
    display:flex;gap:22px;align-items:baseline;flex-wrap:wrap;background:rgba(235,236,231,.9)}
  nav.top .brand{font-family:var(--serif);font-weight:700;font-size:19px;margin-right:8px}
  nav.top a{text-decoration:none;font-family:var(--mono);font-size:12px;color:var(--ink-soft);
    padding:6px 0 10px;border-bottom:2px solid transparent;margin-bottom:-2px}
  nav.top a:hover{color:var(--ink)}
  nav.top a.on{color:var(--ink);border-bottom-color:var(--ink)}

  h1{font-family:var(--serif);font-weight:700;font-size:28px;margin:0 0 6px;line-height:1.2}
  .sub{font-family:var(--mono);font-size:11.5px;color:var(--ink-soft);margin-bottom:26px}

  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-bottom:28px}
  .card{border:1px solid var(--rule);background:var(--panel);padding:14px 16px}
  .card .k{font-family:var(--mono);font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-faint)}
  .card .v{font-family:var(--mono);font-size:26px;font-weight:700;line-height:1.25;font-variant-numeric:tabular-nums}
  .card .n{font-size:12px;color:var(--ink-soft)}

  .searchbox{display:flex;gap:10px;margin-bottom:22px}
  .searchbox input{flex:1;font-family:var(--sans);font-size:15px;padding:11px 14px;border:1px solid var(--rule);
    background:var(--panel);color:var(--ink);outline:none}
  .searchbox input:focus{border-color:var(--ink)}
  .searchbox button{font-family:var(--mono);font-size:12px;padding:0 18px;border:1px solid var(--ink);
    background:var(--ink);color:var(--paper);cursor:pointer}
  .searchbox button:hover{background:#000}

  .hit{display:block;text-decoration:none;padding:11px 0;border-bottom:1px solid var(--rule-soft)}
  .hit:hover .t{text-decoration:underline}
  .hit .t{font-size:15px;margin-bottom:2px}
  .hit .m{font-family:var(--mono);font-size:10.5px;color:var(--ink-faint);font-variant-numeric:tabular-nums}
  .hit .s{font-size:12.5px;color:var(--ink-soft);margin-top:3px;overflow:hidden;text-overflow:ellipsis;
    display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
  .score{float:right;font-family:var(--mono);font-size:11px;color:var(--ink-faint)}

  .msg{margin:0 0 18px;padding-left:14px;border-left:2px solid var(--rule)}
  .msg.user{border-left-color:var(--accent)}
  .msg.ai{border-left-color:var(--ink)}
  .who{font-family:var(--mono);font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;
    color:var(--ink-faint);margin-bottom:5px}
  .msg.user .who{color:var(--accent)}
  .body p{margin:0 0 10px}
  .body p:last-child{margin-bottom:0}
  .body ul,.body ol{margin:0 0 10px;padding-left:22px}
  .body h2,.body h3,.body h4,.body h5{margin:14px 0 8px;font-size:15px;font-family:var(--sans)}
  .body code{font-family:var(--mono);font-size:12.5px;background:rgba(27,31,36,.06);padding:1px 4px}
  pre.code{background:#20242A;color:#E8EAE4;padding:12px 14px;overflow-x:auto;margin:0 0 12px;
    font-family:var(--mono);font-size:12.5px;line-height:1.5}
  pre.code code{background:none;padding:0;color:inherit;font-size:inherit}

  details.think{margin:0 0 10px;border-left:2px solid var(--rule-soft);padding-left:10px}
  details.think summary{cursor:pointer;font-family:var(--mono);font-size:11px;color:var(--ink-faint);
    list-style:none;user-select:none}
  details.think summary::-webkit-details-marker{display:none}
  details.think summary:hover{color:var(--ink-soft)}
  details.think .inner{font-size:13px;color:var(--ink-soft);margin-top:6px;white-space:pre-wrap}

  .tool{font-family:var(--mono);font-size:11px;color:var(--ink-faint);margin:0 0 8px;
    display:flex;gap:8px;align-items:baseline}
  .tool .tag{border:1px solid var(--rule);padding:0 5px;font-size:10px;flex:none}
  .tool .txt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

  .empty{border:1px dashed var(--rule);padding:26px;text-align:center;color:var(--ink-soft);font-size:13px}
  .err{border:1px solid #A8442E;background:#F7EFEC;color:#7A2E1E;padding:12px 14px;margin-bottom:18px;font-size:13px}
  .note{font-family:var(--mono);font-size:11px;color:var(--ink-soft);margin:14px 0 0}
  .back{font-family:var(--mono);font-size:11px;text-decoration:none;color:var(--ink-soft);display:inline-block;margin-bottom:18px}
  .back:hover{color:var(--ink)}
`;

const NAV = [
  { href: '/', label: '概览', key: 'home' },
  { href: '/search', label: '搜索', key: 'search' },
  { href: '/atlas', label: '星座图', key: 'atlas' },
  { href: '/topics', label: '主题图谱', key: 'topics' },
  { href: '/tasks', label: '任务', key: 'tasks' },
];

/** 共享外壳。active 用于高亮导航项。 */
export function layout({ title, active = '', body, head = '' }) {
  const nav = NAV.map(
    (item) => `<a href="${item.href}" class="${item.key === active ? 'on' : ''}">${escapeHtml(item.label)}</a>`,
  ).join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${SHARED_CSS}</style>
${head}
</head>
<body>
<div class="wrap">
<nav class="top"><span class="brand">对话档案</span>${nav}</nav>
${body}
</div>
</body>
</html>`;
}

export function renderOverview({ stats, months, countsByMonth, artifacts }) {
  const bars = months
    .map((m) => {
      const count = countsByMonth[m] ?? 0;
      const peak = Math.max(...months.map((x) => countsByMonth[x] ?? 0), 1);
      const width = Math.max(2, Math.round((count / peak) * 100));
      return `<div style="display:flex;align-items:center;gap:10px;margin:4px 0">
        <span style="font-family:var(--mono);font-size:11px;color:var(--ink-soft);width:64px;flex:none">${escapeHtml(m)}</span>
        <span style="height:14px;background:var(--accent);opacity:.75;width:${width}%"></span>
        <span style="font-family:var(--mono);font-size:11px;color:var(--ink-faint)">${count}</span>
      </div>`;
    })
    .join('');

  const artifactRows = Object.entries(artifacts)
    .map(
      ([name, info]) =>
        `<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--rule-soft)">
          <span>${escapeHtml(name)}</span>
          <span style="font-family:var(--mono);font-size:11px;color:${info.ok ? 'var(--ink-soft)' : '#A8442E'}">${escapeHtml(info.label)}</span>
        </div>`,
    )
    .join('');

  return `
<h1>对话档案</h1>
<p class="sub">${escapeHtml(stats.span)} · 本地备份</p>

<div class="cards">
  <div class="card"><div class="k">对话</div><div class="v">${stats.conversations}</div><div class="n">段</div></div>
  <div class="card"><div class="k">消息</div><div class="v">${stats.messages}</div><div class="n">条</div></div>
  <div class="card"><div class="k">正文</div><div class="v">${(stats.chars / 10000).toFixed(0)}</div><div class="n">万字</div></div>
  <div class="card"><div class="k">向量</div><div class="v">${stats.vectors}</div><div class="n">${stats.vectorLabel}</div></div>
</div>

<div class="card" style="margin-bottom:28px">
  <div class="k" style="margin-bottom:10px">每月对话数</div>
  ${bars}
</div>

<div class="card" style="margin-bottom:28px">
  <div class="k" style="margin-bottom:8px">产物状态</div>
  ${artifactRows}
</div>

<div class="note">
  用 <code style="font-family:var(--mono)">node tools/serve.mjs</code> 启动本页面。
  搜索会调用你配置的嵌入端点，API Key 只存在于服务端进程里。
</div>`;
}

export function renderSearch({ query = '', hits = [], error = '', total = 0, model = '' }) {
  const list = hits.length
    ? hits
        .map(
          (hit) => `<a class="hit" href="/chat/${encodeURIComponent(hit.id)}">
            <span class="score">${(hit.score * 100).toFixed(1)}%</span>
            <div class="t">${escapeHtml(hit.title || '(无标题)')}</div>
            <div class="m">${[hit.month, hit.messageCount ? `${hit.messageCount} 条消息` : ''].filter(Boolean).map(escapeHtml).join(' · ')}</div>
            ${hit.snippet ? `<div class="s">${escapeHtml(hit.snippet)}</div>` : ''}
          </a>`,
        )
        .join('')
    : query && !error
      ? '<div class="empty">没有找到相近的对话。</div>'
      : '';

  return `
<h1>语义搜索</h1>
<p class="sub">${model ? `向量模型 ${escapeHtml(model)} · 共 ${total} 段对话` : '还没做嵌入，先跑 tools/embed.mjs'}</p>

<form class="searchbox" method="get" action="/search">
  <input name="q" value="${escapeHtml(query)}" placeholder="用一句话描述你记得的内容，比如：显卡不够用了跑不动大模型" autofocus>
  <button type="submit">搜索</button>
</form>

${error ? `<div class="err">${escapeHtml(error)}</div>` : ''}
${list}
${query && hits.length ? `<p class="note">按语义相似度排序，不是关键词匹配。点进去看全文。</p>` : ''}`;
}

function timeLabel(value) {
  const ms = typeof value === 'number' ? (value > 1e11 ? value : value * 1000) : Date.parse(String(value));
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 把一条消息里的 fragments 渲染成可读内容。 */
function renderMessage(message) {
  const fragments = Array.isArray(message.fragments) ? message.fragments : [];
  const parts = [];
  let pendingTools = [];
  let thinkBuffer = [];

  const flushTools = () => {
    if (pendingTools.length === 0) return;
    const searches = pendingTools.filter((f) => f.type === 'TOOL_SEARCH');
    const opens = pendingTools.filter((f) => f.type === 'TOOL_OPEN');
    const finds = pendingTools.filter((f) => f.type === 'TOOL_FIND');

    if (searches.length) {
      const queries = searches.map((f) => String(f.content ?? '').trim()).filter(Boolean).join(' / ');
      parts.push(
        `<div class="tool"><span class="tag">搜索</span><span class="txt">${escapeHtml(queries || searches.length + ' 次')}</span></div>`,
      );
    }
    if (opens.length) {
      parts.push(`<div class="tool"><span class="tag">打开</span><span class="txt">${opens.length} 个网页</span></div>`);
    }
    if (finds.length) {
      parts.push(`<div class="tool"><span class="tag">检索</span><span class="txt">${finds.length} 次</span></div>`);
    }
    pendingTools = [];
  };

  const flushThink = () => {
    if (thinkBuffer.length === 0) return;
    const seconds = thinkBuffer
      .map((f) => Number(f.elapsed_secs))
      .filter((n) => Number.isFinite(n) && n > 0)
      .reduce((a, b) => a + b, 0);
    const text = thinkBuffer.map((f) => String(f.content ?? '')).filter(Boolean).join('\n\n');
    if (text.trim()) {
      parts.push(
        `<details class="think"><summary>思考过程${seconds ? ` · ${seconds.toFixed(0)}s` : ''} · ${text.length} 字</summary>` +
          `<div class="inner">${escapeHtml(text)}</div></details>`,
      );
    }
    thinkBuffer = [];
  };

  for (const fragment of fragments) {
    const type = fragment?.type ?? '';
    if (type.startsWith('TOOL_')) {
      flushThink();
      pendingTools.push(fragment);
      continue;
    }
    flushTools();

    if (type === 'THINK') {
      thinkBuffer.push(fragment);
      continue;
    }
    flushThink();

    const content = String(fragment?.content ?? '');
    if (!content.trim()) continue;

    if (type === 'REQUEST' || type === 'RESPONSE' || type === 'TEMPLATE_RESPONSE') {
      parts.push(`<div class="body">${renderMarkdown(content)}</div>`);
    } else if (type === 'TIP') {
      parts.push(`<div class="tool"><span class="tag">提示</span><span class="txt">${escapeHtml(content)}</span></div>`);
    } else if (type === 'FILE') {
      parts.push(`<div class="tool"><span class="tag">附件</span><span class="txt">${escapeHtml(content)}</span></div>`);
    } else {
      parts.push(`<div class="body">${renderMarkdown(content)}</div>`);
    }
  }

  flushTools();
  flushThink();
  return parts.join('\n');
}

export function renderChat({ entry, session, neighbors = [] }) {
  const messages = (session.messages ?? [])
    .map((message) => {
      const isUser = message.role === 'USER';
      const inner = renderMessage(message);
      if (!inner.trim()) return '';
      return `<div class="msg ${isUser ? 'user' : 'ai'}">
        <div class="who">${isUser ? '我' : 'DeepSeek'}${message.inserted_at ? ` · ${esc_tip(message.inserted_at)}` : ''}</div>
        ${inner}
      </div>`;
    })
    .filter(Boolean)
    .join('\n');

  const near = neighbors.length
    ? `<div class="card" style="margin-top:30px">
        <div class="k" style="margin-bottom:8px">语义上最接近的对话</div>
        ${neighbors
          .map(
            (n) => `<a class="hit" href="/chat/${encodeURIComponent(n.id)}">
              <span class="score">${(n.score * 100).toFixed(0)}%</span>
              <div class="t">${escapeHtml(n.title || '(无标题)')}</div>
            </a>`,
          )
          .join('')}
      </div>`
    : '';

  return `
<a class="back" href="/search">← 返回搜索</a>
<h1>${escapeHtml(entry.title || '(无标题)')}</h1>
<p class="sub">${escapeHtml(timeLabel(entry.updated_at))} · ${session.messages?.length ?? 0} 条消息${entry.file ? ` · ${escapeHtml(entry.file.split(/[\\/]/).pop())}` : ''}</p>
${messages || '<div class="empty">这段对话没有可读内容。</div>'}
${near}`;
}

function esc_tip(value) {
  return escapeHtml(timeLabel(value));
}

export function renderError({ title = '出错了', message, hint = '' }) {
  return `<h1>${escapeHtml(title)}</h1>
<div class="err">${escapeHtml(message)}</div>
${hint ? `<p class="note">${escapeHtml(hint)}</p>` : ''}`;
}

/** 任务页：所有动作都在这里点，不用记命令。 */
export function renderTasks({ tasks, endpoint, hasKey }) {
  const cards = Object.entries(tasks)
    .map(([name, task]) => {
      const fields = (task.fields ?? [])
        .map((field) => {
          if (field.type === 'checkbox') {
            return `<label style="display:flex;gap:8px;align-items:center;font-size:12.5px;color:var(--ink-soft);margin:8px 0">
              <input type="checkbox" data-field="${escapeHtml(field.name)}"> ${escapeHtml(field.label)}
            </label>`;
          }
          return `<label style="display:block;margin:8px 0">
            <span style="display:block;font-family:var(--mono);font-size:10.5px;color:var(--ink-faint);margin-bottom:3px">${escapeHtml(field.label)}</span>
            <input data-field="${escapeHtml(field.name)}" placeholder="${escapeHtml(field.placeholder ?? '')}"
              style="width:100%;padding:7px 10px;border:1px solid var(--rule);background:var(--paper);font-family:var(--mono);font-size:12px;outline:none">
          </label>`;
        })
        .join('');

      const endpointNote = task.needsEndpoint && !endpoint ? '<div class="err" style="margin:8px 0 0;font-size:12px">服务端没有配置模型端点，这个任务跑不了</div>' : '';

      return `<div class="card" data-task="${name}" style="margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px">
          <div>
            <div style="font-size:15px;font-weight:600">${escapeHtml(task.title)}</div>
            <div style="font-size:12.5px;color:var(--ink-soft);margin-top:2px">${escapeHtml(task.desc)}</div>
          </div>
          <button class="run" type="button" data-name="${name}"
            style="flex:none;font-family:var(--mono);font-size:11px;padding:7px 14px;border:1px solid var(--ink);background:var(--ink);color:var(--paper);cursor:pointer">运行</button>
        </div>
        ${fields}
        ${endpointNote}
      </div>`;
    })
    .join('');

  return `
<h1>任务</h1>
<p class="sub">${endpoint ? `端点 ${escapeHtml(endpoint)}${hasKey ? ' · Key 已加载' : ' · 缺少 Key'}` : '未配置模型端点'} · 一次只能跑一个</p>

${cards}

<div class="card">
  <div class="k" style="margin-bottom:8px"><span id="taskState">空闲</span></div>
  <pre id="log" style="font-family:var(--mono);font-size:11.5px;line-height:1.55;margin:0;max-height:340px;overflow:auto;white-space:pre-wrap;color:var(--ink-soft)">（还没有运行过任务）</pre>
</div>

<script>
(function(){
  var running = false;
  var logEl = document.getElementById('log');
  var stateEl = document.getElementById('taskState');
  var buttons = Array.prototype.slice.call(document.querySelectorAll('button.run'));

  function setDisabled(value){
    running = value;
    buttons.forEach(function(b){ b.disabled = value; b.style.opacity = value ? '.4' : '1'; });
  }

  function render(status){
    stateEl.textContent = status.running
      ? ('运行中：' + (status.title || status.name))
      : (status.code === null || status.code === undefined
          ? '空闲'
          : (status.code === 0 ? '上次完成' : '上次失败（退出码 ' + status.code + '）'));
    if (status.log && status.log.length){
      logEl.textContent = status.log.join('\\n');
      logEl.scrollTop = logEl.scrollHeight;
    }
    setDisabled(Boolean(status.running));
  }

  function poll(){
    fetch('/api/task').then(function(r){ return r.json(); }).then(function(status){
      render(status);
      setTimeout(poll, status.running ? 900 : 2500);
    }).catch(function(){ setTimeout(poll, 3000); });
  }

  document.addEventListener('click', function(ev){
    var button = ev.target.closest('button.run');
    if (!button || running) return;

    var card = button.closest('.card');
    var params = {};
    Array.prototype.forEach.call(card.querySelectorAll('[data-field]'), function(input){
      params[input.getAttribute('data-field')] = input.type === 'checkbox' ? input.checked : input.value;
    });

    setDisabled(true);
    logEl.textContent = '启动中…';
    fetch('/api/task', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: button.getAttribute('data-name'), params: params })
    }).then(function(r){ return r.json(); }).then(function(res){
      if (res.error){ logEl.textContent = res.error; setDisabled(false); }
    }).catch(function(err){ logEl.textContent = String(err); setDisabled(false); });
  });

  poll();
})();
</script>`;
}
