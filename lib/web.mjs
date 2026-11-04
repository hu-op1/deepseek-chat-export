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

  .recent{display:block;padding:10px 0;border-bottom:1px solid var(--rule-soft);color:inherit;text-decoration:none}
  .recent:hover{background:var(--panel)}
  .recent .rt{font-size:14px;font-weight:600}
  .recent .rs{font-size:12.5px;color:var(--ink-soft);line-height:1.6;margin-top:3px}
  .recent .rm{margin-top:5px;display:flex;flex-wrap:wrap;gap:6px;align-items:center}
  .tag{font-family:var(--mono);font-size:10.5px;padding:1px 7px;border:1px solid var(--rule);color:var(--ink-soft)}
  .mono{font-family:var(--mono);font-size:11px;color:var(--ink-faint)}  .legend{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
  .legend .chip{display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border:1px solid var(--rule);
    font-size:12px;color:var(--ink-soft);text-decoration:none;background:var(--panel)}
  .legend .chip:hover{border-color:var(--ink);color:var(--ink)}
  .legend .chip.on{border-color:var(--ink);background:var(--ink);color:var(--paper)}
  .legend .chip.on .mono{color:var(--paper);opacity:.7}  .empty{border:1px dashed var(--rule);padding:26px;text-align:center;color:var(--ink-soft);font-size:13px}
  .err{border:1px solid #A8442E;background:#F7EFEC;color:#7A2E1E;padding:12px 14px;margin-bottom:18px;font-size:13px}
  .note{font-family:var(--mono);font-size:11px;color:var(--ink-soft);margin:14px 0 0}
  .back{font-family:var(--mono);font-size:11px;text-decoration:none;color:var(--ink-soft);display:inline-block;margin-bottom:18px}
  .back:hover{color:var(--ink)}
`;

const NAV = [
  { href: '/', label: '概览', key: 'home' },
  { href: '/chats', label: '全部对话', key: 'chats' },
  { href: '/timeline', label: '时间线', key: 'timeline' },
  { href: '/search', label: '搜索', key: 'search' },
  { href: '/atlas', label: '星座图', key: 'atlas' },
  { href: '/atlas3d', label: '3D 星座', key: 'atlas3d' },
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

export function renderOverview({ stats, months, countsByMonth, artifacts, recent = [], topTopics = [] }) {
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

  // 最近在聊什么：每条给一句模型写的摘要，比只看标题有用得多
  const recentRows = recent
    .map(
      (item) => `<a class="recent" href="/chat/${encodeURIComponent(item.id)}">
        <div class="rt">${escapeHtml(item.title)}</div>
        ${item.summary ? `<div class="rs">${escapeHtml(item.summary)}</div>` : ''}
        <div class="rm">
          <span class="mono">${escapeHtml(dayLabel(item.date ?? item.month) || item.month)}</span>
          ${item.topics.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}
        </div>
      </a>`,
    )
    .join('');

  // 聊得最多的主题：给条形，一眼看出重心在哪
  const peakTopic = Math.max(...topTopics.map((t) => t.count), 1);
  const topicRows = topTopics
    .map(
      (t) => `<div style="display:flex;align-items:center;gap:10px;margin:5px 0">
        <span style="font-size:12.5px;width:190px;flex:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(t.label)}</span>
        <span style="height:12px;background:var(--accent);opacity:.6;width:${Math.max(2, Math.round((t.count / peakTopic) * 100))}%;max-width:55%"></span>
        <span style="font-family:var(--mono);font-size:11px;color:var(--ink-faint)">${t.count}</span>
      </div>`,
    )
    .join('');

  const artifactRows = Object.entries(artifacts)
    .map(
      ([name, info]) =>
        `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--rule-soft)">
          <span style="font-size:12.5px">${escapeHtml(name)}</span>
          <span style="font-family:var(--mono);font-size:11px;color:${info.ok ? 'var(--ink-soft)' : '#A8442E'}">${escapeHtml(info.label)}</span>
        </div>`,
    )
    .join('');

  return `
<h1>对话档案</h1>
<p class="sub">${escapeHtml(stats.span)} · ${stats.conversations} 段对话 · ${stats.messages} 条消息 · ${(stats.chars / 10000).toFixed(0)} 万字</p>

<div class="cards">
  <div class="card"><div class="k">对话</div><div class="v">${stats.conversations}</div><div class="n">段</div></div>
  <div class="card"><div class="k">已标注</div><div class="v">${stats.annotated ?? 0}</div><div class="n">段有摘要</div></div>
  <div class="card"><div class="k">主题</div><div class="v">${stats.topics ?? 0}</div><div class="n">个归类</div></div>
  <div class="card"><div class="k">正文</div><div class="v">${(stats.chars / 10000).toFixed(0)}</div><div class="n">万字</div></div>
</div>

<div class="card" style="margin-bottom:22px">
  <div class="k" style="margin-bottom:10px">最近在聊什么</div>
  ${recentRows || '<div class="empty">还没有数据。</div>'}
</div>

${topTopics.length ? `<div class="card" style="margin-bottom:22px">
  <div class="k" style="margin-bottom:10px">聊得最多的主题</div>
  ${topicRows}
</div>` : ''}

<div class="card" style="margin-bottom:22px">
  <div class="k" style="margin-bottom:10px">每月对话数</div>
  ${bars}
</div>

<div class="card" style="margin-bottom:22px">
  <div class="k" style="margin-bottom:8px">产物状态</div>
  ${artifactRows}
</div>`;
}

/** 时间线：按月看自己在聊什么，这才是"回忆"该有的样子。 */
export function renderTimeline({ months = [] }) {
  if (!months.length) {
    return `<h1>时间线</h1><div class="empty">还没有标注数据。先去「任务」页跑「标注主题」。</div>`;
  }

  const blocks = months
    .map((bucket) => {
      const topicLine = bucket.topics.length
        ? bucket.topics
            .map((t) => `<span class="tag">${escapeHtml(t.label)}<span class="mono" style="margin-left:6px">${t.count}</span></span>`)
            .join('')
        : '<span class="mono">这个月没有主题数据</span>';

      const items = bucket.items
        .map(
          (item) => `<a class="recent" href="/chat/${encodeURIComponent(item.id)}">
            <div class="rt">${escapeHtml(item.title)}<span class="mono" style="margin-left:10px;font-weight:400">${escapeHtml(dayLabel(item.date).slice(5))}</span></div>
            ${item.summary ? `<div class="rs">${escapeHtml(item.summary)}</div>` : ''}
          </a>`,
        )
        .join('');

      return `<div class="card" style="margin-bottom:20px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px">
          <div style="font-size:20px;font-weight:700;letter-spacing:-.01em">${escapeHtml(bucket.month)}</div>
          <div class="mono">${bucket.total} 段对话</div>
        </div>
        <div class="rm" style="margin-bottom:12px">${topicLine}</div>
        ${items}
        <div class="mono" style="margin-top:8px"><a href="/chats?month=${encodeURIComponent(bucket.month)}">看这个月全部 ${bucket.total} 段 →</a></div>
      </div>`;
    })
    .join('');

  return `
<h1>时间线</h1>
<p class="sub">按月倒序 · 每月挑出最近几段对话和主要话题</p>
${blocks}`;
}

/** 全部对话：按日期倒序浏览，可按月筛选、翻页。这是"随便翻翻"的入口。 */
export function renderChatList({ items = [], months = [], activeMonth = '', page = 1, pages = 1, total = 0 }) {
  const chips = [
    `<a class="chip all${activeMonth ? '' : ' on'}" href="/chats">全部<span class="mono" style="margin-left:6px">${total}</span></a>`,
    ...months.map(
      (m) =>
        `<a class="chip mo${activeMonth === m.month ? ' on' : ''}" href="/chats?month=${encodeURIComponent(m.month)}">${escapeHtml(m.month)}<span class="mono" style="margin-left:6px">${m.count}</span></a>`,
    ),
  ].join('');

  const rows = items
    .map(
      (item) => `<a class="recent" href="/chat/${encodeURIComponent(item.id)}">
        <div class="rt">${escapeHtml(item.title)}</div>
        ${item.summary ? `<div class="rs">${escapeHtml(item.summary)}</div>` : ''}
        <div class="rm">
          <span class="mono">${escapeHtml(dayLabel(item.date) || item.month)}</span>
          ${item.topics.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}
          ${item.messageCount ? `<span class="mono">${item.messageCount} 条消息</span>` : ''}
        </div>
      </a>`,
    )
    .join('');

  const q = activeMonth ? `?month=${encodeURIComponent(activeMonth)}&` : '?';
  const pager =
    pages > 1
      ? `<div style="display:flex;gap:10px;align-items:center;justify-content:center;margin:18px 0">
          ${page > 1 ? `<a class="tag" href="${q}page=${page - 1}">← 上一页</a>` : ''}
          <span class="mono">第 ${page} / ${pages} 页</span>
          ${page < pages ? `<a class="tag" href="${q}page=${page + 1}">下一页 →</a>` : ''}
        </div>`
      : '';

  return `
<h1>全部对话</h1>
<p class="sub">按最后发言时间倒序 · ${activeMonth ? escapeHtml(activeMonth) + ' · ' : ''}共 ${total} 段</p>

<div class="legend" style="margin-bottom:14px">${chips}</div>

${rows || '<div class="empty">这个月没有对话。</div>'}
${pager}`;
}

export function renderSearch({ query = '', hits = [], error = '', total = 0, model = '' }) {
  const list = hits.length
    ? hits
        .map(
          (hit) => `<a class="hit" href="/chat/${encodeURIComponent(hit.id)}">
            <span class="score">${(hit.score * 100).toFixed(1)}%</span>
            <div class="t">${escapeHtml(hit.title || '(无标题)')}</div>
            <div class="m">${[dayLabel(hit.date) || hit.month, hit.messageCount ? `${hit.messageCount} 条消息` : ''].filter(Boolean).map(escapeHtml).join(' · ')}</div>
            ${hit.chunk ? `<div class="m">匹配到第 ${hit.chunk.index + 1} 段（第 ${hit.chunk.from + 1}–${hit.chunk.to + 1} 条消息）</div>` : ""}
            ${hit.summary ? `<div class="s">${escapeHtml(hit.summary)}</div>` : hit.snippet ? `<div class="s">${escapeHtml(hit.snippet)}</div>` : ''}
            ${hit.chunk?.excerpt ? `<div class="s" style="opacity:.72">…${escapeHtml(hit.chunk.excerpt)}…</div>` : ""}
            ${(hit.topics ?? []).length ? `<div class="rm">${hit.topics.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
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

/** 只到天：列表里显示 2026-09-26，比光有月份能排序得多。 */
function dayLabel(value) {
  const ms = typeof value === 'number' ? (value > 1e11 ? value : value * 1000) : Date.parse(String(value));
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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

export function renderChat({ entry, session, neighbors = [], summary = '', topics = [] }) {
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
        <div class="note" style="margin-top:8px">只列相似度 40% 以上的；更低的属于不同话题，列出来只会误导。</div>
      </div>`
    : '';

  return `
<a class="back" href="/search">← 返回搜索</a>
<h1>${escapeHtml(entry.title || '(无标题)')}</h1>
<p class="sub">${escapeHtml(timeLabel(entry.updated_at))} · ${session.messages?.length ?? 0} 条消息${entry.file ? ` · ${escapeHtml(entry.file.split(/[\\/]/).pop())}` : ''}</p>
${summary
  ? `<div class="card" style="margin:14px 0;border-left:3px solid var(--accent)">
      <div class="k" style="margin-bottom:6px">这段在聊什么</div>
      <div style="font-size:13.5px;line-height:1.7">${escapeHtml(summary)}</div>
      ${topics.length ? `<div class="rm" style="margin-top:8px">${topics.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
    </div>`
  : ''}
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
export function renderTasks({ tasks, endpoints = {}, config = {} }) {
  const chat = endpoints.chat ?? {};
  const embed = endpoints.embed ?? {};
  const inputStyle =
    'width:100%;padding:7px 10px;border:1px solid var(--rule);background:var(--paper);font-family:var(--mono);font-size:12px;outline:none';
  const labelStyle = 'display:block;margin:8px 0';
  const hintStyle = 'display:block;font-family:var(--mono);font-size:10.5px;color:var(--ink-faint);margin-bottom:3px';

  const cards = Object.entries(tasks)
    .map(([name, task]) => {
      const need = task.endpoint;
      const fields = (task.fields ?? [])
        .map((field) => {
          if (field.type === 'checkbox') {
            return `<label style="display:flex;gap:8px;align-items:center;font-size:12.5px;color:var(--ink-soft);margin:8px 0">
              <input type="checkbox" data-field="${escapeHtml(field.name)}"> ${escapeHtml(field.label)}
            </label>`;
          }
          const preset = field.prefill ? config[field.prefill] ?? '' : '';
          // 对话模型和嵌入模型各有各的候选列表，不能混——用错模型会直接报错
          const list = field.prefill === 'chatModel' ? ' list="chat-models"' : field.prefill === 'embedModel' ? ' list="embed-models"' : '';
          return `<label style="${labelStyle}">
            <span style="${hintStyle}">${escapeHtml(field.label)}</span>
            <input data-field="${escapeHtml(field.name)}" value="${escapeHtml(preset)}"${list} placeholder="${escapeHtml(field.placeholder ?? '')}"
              style="${inputStyle}">
          </label>`;
        })
        .join('');

      const group = need === 'chat' ? chat : need === 'embed' ? embed : null;
      const missing = group && !group.baseUrl;
      const note = missing
        ? `<div class="err" style="margin:8px 0 0;font-size:12px">还没配置${need === 'chat' ? '对话' : '嵌入'}端点，先填上面的设置</div>`
        : '';

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
        ${note}
      </div>`;
    })
    .join('');

  const group = (kind, title, desc, cfgPrefix, stateKey, listId) => {
    const state = kind === 'chat' ? chat : embed;
    return `<div style="border-top:1px solid var(--rule-soft);padding-top:12px;margin-top:12px">
      <div style="font-size:13.5px;font-weight:600">${escapeHtml(title)}</div>
      <div style="font-size:12px;color:var(--ink-soft);margin-top:2px">${escapeHtml(desc)}</div>
      <label style="${labelStyle}">
        <span style="${hintStyle}">端点地址（OpenAI 兼容，到 /v1 为止）</span>
        <input data-config="${cfgPrefix}BaseUrl" value="${escapeHtml(config[`${cfgPrefix}BaseUrl`] ?? '')}" placeholder="${kind === 'chat' ? 'http://127.0.0.1:1234/v1' : 'https://api.example.com/v1'}" style="${inputStyle}">
      </label>
      <label style="${labelStyle}">
        <span style="${hintStyle}">API Key${state.hasKey ? '（已保存，留空则不修改）' : '（本地端点可留空）'}</span>
        <input data-config="${cfgPrefix}ApiKey" type="password" value="" placeholder="${state.hasKey ? '已保存' : '留空表示不需要'}" style="${inputStyle}">
      </label>
      <label style="${labelStyle}">
        <span style="${hintStyle}">模型名</span>
        <input data-config="${cfgPrefix}Model" value="${escapeHtml(config[`${cfgPrefix}Model`] ?? '')}" list="${listId}" placeholder="${kind === 'chat' ? 'qwen3.5-4b' : 'qwen3-embedding-8b'}" style="${inputStyle}">
      </label>
      <div style="display:flex;gap:10px;margin-top:8px">
        <button class="fetch" type="button" data-which="${kind}"
          style="font-family:var(--mono);font-size:11px;padding:6px 12px;border:1px solid var(--rule);background:var(--panel);cursor:pointer">拉取${kind === 'chat' ? '对话' : '嵌入'}模型</button>
      </div>
    </div>`;
  };

  return `
<h1>任务</h1>
<p class="sub">对话端点 ${chat.baseUrl ? escapeHtml(chat.baseUrl) : '未配置'} · 嵌入端点 ${embed.baseUrl ? escapeHtml(embed.baseUrl) : '未配置'} · 一次只能跑一个</p>

<datalist id="chat-models"></datalist>
<datalist id="embed-models"></datalist>

<div class="card" style="margin-bottom:22px;border-color:var(--ink)">
  <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:4px">
    <div>
      <div style="font-size:15px;font-weight:600">端点设置</div>
      <div style="font-size:12.5px;color:var(--ink-soft);margin-top:2px">两套端点可以不同：对话可以跑本地，嵌入用远程。保存到 memory/config.json</div>
    </div>
    <button class="save" type="button"
      style="flex:none;font-family:var(--mono);font-size:11px;padding:7px 14px;border:1px solid var(--rule);background:var(--panel);cursor:pointer">保存</button>
  </div>

  ${group('chat', '对话端点', '用于「标注主题」，产出标签和摘要', 'chat', chat, 'chat-models')}
  ${group('embed', '嵌入端点', '用于「建立向量」「归并标签」和搜索', 'embed', embed, 'embed-models')}

  <div style="display:flex;gap:12px;margin-top:12px">
    <span id="cfgState" style="font-family:var(--mono);font-size:11px;color:var(--ink-faint);align-self:center"></span>
  </div>
</div>

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

  /* ── 端点设置 ── */
  var cfgState = document.getElementById('cfgState');

  function collectConfig(){
    var patch = {};
    Array.prototype.forEach.call(document.querySelectorAll('[data-config]'), function(input){
      patch[input.getAttribute('data-config')] = input.value;
    });
    return patch;
  }

  document.addEventListener('click', function(ev){
    var save = ev.target.closest('button.save');
    if (save){
      cfgState.textContent = '保存中…';
      fetch('/api/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(collectConfig())
      }).then(function(r){ return r.json(); }).then(function(res){
        cfgState.textContent = res.ok ? '已保存' : (res.error || '保存失败');
        if (res.ok){ setTimeout(function(){ location.reload(); }, 600); }
      }).catch(function(err){ cfgState.textContent = String(err); });
      return;
    }

    var fetchBtn = ev.target.closest('button.fetch');
    if (fetchBtn){
      var which = fetchBtn.getAttribute('data-which') || 'embed';
      var list = document.getElementById(which + '-models');
      cfgState.textContent = '拉取中…';
      fetch('/api/models?which=' + which).then(function(r){ return r.json(); }).then(function(res){
        if (res.error){ cfgState.textContent = res.error; return; }
        list.innerHTML = (res.models || []).map(function(id){
          return '<option value="' + id.replace(/"/g, '&quot;') + '"></option>';
        }).join('');
        cfgState.textContent = '拿到 ' + (res.models || []).length + ' 个模型';
      }).catch(function(err){ cfgState.textContent = String(err); });
    }
  });

  poll();
})();
</script>`;
}
