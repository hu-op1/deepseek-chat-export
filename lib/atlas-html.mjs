/**
 * 星座图渲染：把 497 条向量投影到二维，做成一个可以缩放、搜索、点开的页面。
 *
 * 一条必须写进页面的诚实提示：t-SNE 只保留**局部**邻近关系，
 * 簇与簇之间的绝对距离没有意义。不写这句，图一定会被误读成"这两个主题相关"。
 */

const MONTH_RAMP = ['#B0722B', '#A8442E', '#7A3E63', '#4A4A7A', '#33538C', '#2E6F6A', '#5C7233', '#8C7A4E'];

export function monthColor(index, total) {
  if (total <= 1) return MONTH_RAMP[2];
  const t = index / (total - 1);
  return MONTH_RAMP[Math.round(t * (MONTH_RAMP.length - 1))];
}

/** 把 t-SNE 输出缩放到 [0, 1000] 的方格，浏览器端再映射到画布。 */
export function normalizeCoords(coords) {
  const xs = coords.map(([x]) => x);
  const ys = coords.map(([, y]) => y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const span = Math.max(spanX, spanY);

  return coords.map(([x, y]) => [
    Math.round(((x - minX) / span) * 1000 + (span - spanX) / span / 2 * 1000),
    Math.round(((y - minY) / span) * 1000 + (span - spanY) / span / 2 * 1000),
  ]);
}

export function buildAtlasPayload({ items, coords, neighbors, months, meta }) {
  const monthIndex = new Map(months.map((m, i) => [m, i]));

  const points = items.map((item, i) => ({
    i,
    id: item.id,
    x: coords[i][0],
    y: coords[i][1],
    t: item.title || '(无标题)',
    m: item.month || '',
    c: monthColor(monthIndex.get(item.month) ?? 0, months.length),
    s: item.snippet || '',
  }));

  return {
    points,
    months,
    neighbors,
    meta,
  };
}

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function renderAtlasHtml(atlas, { title = '对话星座图', nav = '' } = {}) {
  const dataJson = JSON.stringify(atlas).replace(/</g, '\\u003c');
  const monthChips = atlas.months
    .map(
      (m, i) =>
        `<span class="chip mo" data-month="${escapeHtml(m)}"><i style="background:${monthColor(i, atlas.months.length)}"></i>${escapeHtml(m)}</span>`,
    )
    .join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root{
    --paper:#EBECE7; --panel:#F6F7F3; --ink:#1B1F24; --ink-soft:#5A6470; --ink-faint:#8B939C;
    --rule:#C2C6BE; --rule-soft:#DDE0D9;
    --mono: ui-monospace,"Cascadia Mono","SF Mono",Consolas,"Courier New",monospace;
    --sans: "PingFang SC","Microsoft YaHei","Noto Sans SC",system-ui,sans-serif;
    --serif: "Songti SC","SimSun","Noto Serif SC",serif;
  }
  *{box-sizing:border-box}
  html,body{margin:0;padding:0}
  body{background:var(--paper);color:var(--ink);font-family:var(--sans);font-size:14px;line-height:1.55;
    -webkit-font-smoothing:antialiased;
    background-image:
      repeating-linear-gradient(to right, rgba(27,31,36,.03) 0 1px, transparent 1px 96px),
      repeating-linear-gradient(to bottom, rgba(27,31,36,.03) 0 1px, transparent 1px 96px);}
  .wrap{max-width:1240px;margin:0 auto;padding:26px 22px 44px}

  header.top{display:flex;align-items:flex-end;justify-content:space-between;gap:18px;
    border-bottom:2px solid var(--ink);padding-bottom:11px;margin-bottom:20px;flex-wrap:wrap}
  h1{font-family:var(--serif);font-weight:700;font-size:32px;margin:0;line-height:1.1}
  h1 .thin{font-weight:400;color:var(--ink-soft);font-size:12px;display:block;margin-top:6px;
    font-family:var(--mono)}
  .facts{display:flex;gap:24px;font-family:var(--mono);font-size:11px;color:var(--ink-soft);text-align:right}
  .facts div b{display:block;color:var(--ink);font-weight:700;font-size:18px;line-height:1.3;
    font-variant-numeric:tabular-nums}

  .eyebrow{font-family:var(--mono);font-size:10.5px;letter-spacing:.13em;text-transform:uppercase;
    color:var(--ink-soft);margin:0 0 9px;display:flex;justify-content:space-between;align-items:baseline;gap:12px}
  .eyebrow span:last-child{text-transform:none;letter-spacing:.04em;color:var(--ink-faint)}

  .chart{position:relative;border:1px solid var(--rule);background:var(--panel)}
  #sky{display:block;width:100%;height:auto;cursor:grab;touch-action:none}
  #sky.dragging{cursor:grabbing}
  .pt{cursor:pointer}
  .pt circle{transition:opacity .12s ease,r .12s ease}
  .pt.dim{opacity:.12}
  .pt.hot circle{stroke:var(--ink);stroke-width:2}
  .label{font-family:var(--sans);font-size:10px;fill:var(--ink);pointer-events:none;
    paint-order:stroke;stroke:var(--panel);stroke-width:3px;stroke-linejoin:round}

  .tools{position:absolute;top:10px;right:10px;display:flex;gap:8px;align-items:center}
  .tools input{font-family:var(--mono);font-size:12px;padding:6px 10px;border:1px solid var(--rule);
    background:rgba(246,247,243,.96);color:var(--ink);width:220px;outline:none}
  .tools input:focus{border-color:var(--ink)}
  .tools button{font-family:var(--mono);font-size:11px;padding:6px 10px;border:1px solid var(--rule);
    background:rgba(246,247,243,.96);color:var(--ink-soft);cursor:pointer}
  .tools button:hover{color:var(--ink);border-color:var(--ink)}

  .legend{display:flex;gap:14px;flex-wrap:wrap;margin-top:10px;font-family:var(--mono);font-size:11px;color:var(--ink-soft)}
  .chip{display:inline-flex;align-items:center;gap:5px}
  .chip i{width:9px;height:9px;display:inline-block;border-radius:50%}
  .chip.mo,.chip.all{cursor:pointer;padding:2px 7px;border:1px solid transparent}
  .chip.mo:hover,.chip.all:hover{border-color:var(--rule)}
  .chip.on{border-color:var(--ink);color:var(--ink);font-weight:700}

  .tip{position:absolute;pointer-events:none;opacity:0;transition:opacity .1s ease;
    background:rgba(27,31,36,.94);color:#F2F3EF;padding:5px 9px;font-size:12px;line-height:1.4;
    max-width:320px;z-index:5}
  .tip.on{opacity:1}
  .tip .mo{font-family:var(--mono);font-size:10px;opacity:.72;display:block;margin-top:2px}

  .note{font-family:var(--mono);font-size:11px;color:var(--ink-soft);margin:10px 2px 0;max-width:78ch}
  .note b{color:var(--ink)}

  .lower{display:grid;grid-template-columns:1fr;gap:16px;margin-top:20px}
  #panel{border:1px solid var(--rule);background:var(--panel)}
  .panel-head{padding:11px 14px;border-bottom:1px solid var(--rule-soft);display:flex;
    justify-content:space-between;align-items:baseline;gap:12px}
  .panel-head .name{font-size:16px;font-weight:600}
  .panel-head .meta{font-family:var(--mono);font-size:10.5px;color:var(--ink-soft)}
  .panel-body{padding:12px 14px 14px}
  .snippet{font-size:13px;color:var(--ink-soft);max-width:82ch;margin-bottom:12px}
  .near-title{font-family:var(--mono);font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;
    color:var(--ink-faint);margin-bottom:6px}
  .near{display:flex;flex-direction:column}
  .near .row{display:flex;gap:10px;align-items:baseline;padding:6px 0;cursor:pointer;
    border-bottom:1px solid var(--rule-soft);font-size:13px}
  .near .row:last-child{border-bottom:none}
  .near .row:hover{color:#000}
  .near .sc{font-family:var(--mono);font-size:10.5px;color:var(--ink-faint);width:44px;flex:none;
    font-variant-numeric:tabular-nums}
  .near .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .near .mo{font-family:var(--mono);font-size:10.5px;color:var(--ink-faint);flex:none}
  .empty{font-size:13px;color:var(--ink-soft)}
  @media (prefers-reduced-motion:reduce){ *{transition:none !important;animation:none !important} }
</style>
</head>
<body>
<div class="wrap">
${nav}
  <header class="top">
    <h1>${escapeHtml(title)}<span class="thin">每个点是一段对话 · 距离近 = 说得像</span></h1>
    <div class="facts">
      <div><b>${atlas.points.length}</b>段对话</div>
      <div><b>${atlas.meta.dim ?? '—'}</b>维向量</div>
      <div><b>${atlas.months.length}</b>个月</div>
    </div>
  </header>

  <p class="eyebrow"><span>语义位置 · 滚轮缩放 / 拖动平移 / 悬停看标题</span><span id="filterInfo"></span></p>
  <div class="chart">
    <svg id="sky" role="img" aria-label="对话在语义空间中的位置"></svg>
    <div class="tools">
      <input id="q" type="search" placeholder="按标题过滤…" autocomplete="off">
      <button id="reset" type="button">复位</button>
    </div>
    <div id="tip" class="tip"></div>
  </div>
  <div class="legend">
    <span class="chip all on" data-month="">全部</span>
    ${monthChips}
  </div>

  <p class="note">
    <b>距离只表示"说得像"，不表示"重要"或"相关"。</b>
    这是二维投影，<b>簇与簇之间的绝对距离没有意义</b>——两团挨在一起不代表它们相关，
    能读的只有"谁挨着谁"。颜色是对话所在的月份，点图例会只显示那个月。
    模型：<span style="font-family:var(--mono)">${escapeHtml(atlas.meta.model ?? '未知')}</span>
    · 布局：<span style="font-family:var(--mono)">${atlas.meta.layout === 'tsne' ? 't-SNE' : '力导向（近邻吸引 + 全局排斥）'}</span>
  </p>

  <div class="lower">
    <div id="panel">
      <div class="panel-head">
        <div class="name" id="panelName">点一个点</div>
        <div class="meta" id="panelMeta"></div>
      </div>
      <div class="panel-body" id="panelBody">
        <div class="empty">点任意一个点，看它最近的邻居。</div>
      </div>
    </div>
  </div>
</div>

<script>
(function(){
  var DATA = ${dataJson};
  var NS = "http://www.w3.org/2000/svg";
  var W = 1120, H = 680, PAD = 26;
  var sky = document.getElementById("sky");
  sky.setAttribute("viewBox", "0 0 " + W + " " + H);

  function el(tag, attrs){
    var node = document.createElementNS(NS, tag);
    for (var k in attrs){ if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]); }
    return node;
  }
  function esc(s){
    return String(s == null ? "" : s).replace(/[&<>"]/g, function(c){
      return { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c];
    });
  }

  var innerW = W - PAD * 2, innerH = H - PAD * 2;
  function px(p){ return PAD + p.x / 1000 * innerW; }
  function py(p){ return PAD + p.y / 1000 * innerH; }

  var layer = el("g", {});
  sky.appendChild(layer);

  var edgeLayer = el("g", {});   // 常显：每个点连到它的最近邻
  var linkLayer = el("g", {});   // 选中时：连到全部近邻
  layer.appendChild(edgeLayer);
  layer.appendChild(linkLayer);

  var byId = {};
  DATA.points.forEach(function(p){
    var g = el("g", { class: "pt", "data-id": p.id, tabindex: "0", role: "button",
      "aria-label": p.t + "，" + p.m });
    g.appendChild(el("circle", { cx: px(p), cy: py(p), r: 4.6, fill: p.c, "fill-opacity": ".78",
      stroke: "#F6F7F3", "stroke-width": "1" }));
    g.addEventListener("click", function(){ select(p.id); });
    g.addEventListener("keydown", function(ev){
      if (ev.key === "Enter" || ev.key === " "){ ev.preventDefault(); select(p.id); }
    });
    layer.appendChild(g);
    p.node = g;
    byId[p.id] = p;
  });

  /* 最近邻连线：t-SNE 保的是"局部邻居"，不画出来就只能看到一团云。
     每个点连到它最近的邻居，簇才会显出丝状结构——星座要连成"座"。 */
  var drawn = {};
  DATA.points.forEach(function(p){
    var near = DATA.neighbors[p.id];
    if (!near || !near.length) return;
    var q = byId[near[0].id];
    if (!q) return;
    var key = p.id < q.id ? p.id + "|" + q.id : q.id + "|" + p.id;
    if (drawn[key]) return;
    drawn[key] = true;
    edgeLayer.appendChild(el("line", {
      x1: px(p), y1: py(p), x2: px(q), y2: py(q),
      stroke: "#1B1F24", "stroke-opacity": ".13", "stroke-width": ".8"
    }));
  });

  /* ── 缩放与平移 ── */
  var view = { x: 0, y: 0, w: W, h: H };
  function applyView(){ sky.setAttribute("viewBox", view.x + " " + view.y + " " + view.w + " " + view.h); }

  sky.addEventListener("wheel", function(ev){
    ev.preventDefault();
    var box = sky.getBoundingClientRect();
    var mx = view.x + (ev.clientX - box.left) / box.width * view.w;
    var my = view.y + (ev.clientY - box.top) / box.height * view.h;
    var factor = ev.deltaY > 0 ? 1.18 : 1 / 1.18;
    var nextW = Math.min(W * 2, Math.max(W / 12, view.w * factor));
    var nextH = nextW * (H / W);
    view.x = mx - (mx - view.x) * (nextW / view.w);
    view.y = my - (my - view.y) * (nextH / view.h);
    view.w = nextW; view.h = nextH;
    applyView();
  }, { passive: false });

  var drag = null;
  sky.addEventListener("pointerdown", function(ev){
    // 按在点上时不要启动拖拽：setPointerCapture 会把 click 事件劫持到 SVG 上，
    // 点的 click 监听器就再也不会触发了（这是之前"点了没反应"的根因）。
    if (ev.target.closest && ev.target.closest(".pt")) return;
    drag = { x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y, id: ev.pointerId, moved: false };
  });
  sky.addEventListener("pointermove", function(ev){
    if (!drag) return;
    var dx = ev.clientX - drag.x;
    var dy = ev.clientY - drag.y;
    if (!drag.moved){
      if (Math.sqrt(dx*dx + dy*dy) < 4) return;  // 抖动不算拖动
      drag.moved = true;
      try { sky.setPointerCapture(drag.id); } catch (e) {}
      sky.classList.add("dragging");
    }
    var box = sky.getBoundingClientRect();
    view.x = drag.vx - dx / box.width * view.w;
    view.y = drag.vy - dy / box.height * view.h;
    applyView();
  });
  sky.addEventListener("pointerup", function(ev){
    if (drag && drag.moved){ try { sky.releasePointerCapture(drag.id); } catch (e) {} }
    drag = null;
    sky.classList.remove("dragging");
    hideTip();
    hover(ev);
  });
  sky.addEventListener("pointercancel", function(){
    drag = null; sky.classList.remove("dragging");
  });
  document.getElementById("reset").addEventListener("click", function(){
    view = { x: 0, y: 0, w: W, h: H }; applyView();
  });

  /* ── 悬停提示：没有这个，图就是一堆匿名点 ── */
  var tip = document.getElementById("tip");
  var chartBox = document.querySelector(".chart");

  function hideTip(){ tip.className = "tip"; }

  function hover(ev){
    if (drag && drag.moved){ hideTip(); return; }
    var node = ev.target.closest ? ev.target.closest(".pt") : null;
    if (!node){ hideTip(); return; }

    var point = byId[node.getAttribute("data-id")];
    if (!point){ hideTip(); return; }

    tip.innerHTML = esc(point.t) + '<span class="mo">' + esc(point.m || '') + ' · 点击看近邻</span>';
    tip.className = "tip on";

    var box = chartBox.getBoundingClientRect();
    var left = ev.clientX - box.left + 14;
    var top = ev.clientY - box.top + 12;
    if (left + 330 > box.width) left = Math.max(4, left - 340);
    if (top + 60 > box.height) top = Math.max(4, top - 56);
    tip.style.left = left + "px";
    tip.style.top = top + "px";
  }

  sky.addEventListener("pointermove", hover);
  sky.addEventListener("pointerleave", hideTip);

  /* ── 按月份筛选 ── */
  var monthFilter = "";
  var chips = Array.prototype.slice.call(document.querySelectorAll(".chip[data-month]"));

  function applyFilters(){
    var term = (document.getElementById("q").value || "").trim().toLowerCase();
    var hit = 0;
    DATA.points.forEach(function(p){
      var ok = (!term || p.t.toLowerCase().indexOf(term) !== -1) && (!monthFilter || p.m === monthFilter);
      if (ok) hit += 1;
      p.node.style.display = ok ? "" : "none";
      p.node.setAttribute("class", "pt");
    });
    var bits = [];
    if (term) bits.push("标题匹配 " + hit + " 段");
    if (monthFilter) bits.push(monthFilter + " 共 " + hit + " 段");
    document.getElementById("filterInfo").textContent = bits.join(" · ");
    return hit;
  }

  chips.forEach(function(chip){
    chip.addEventListener("click", function(){
      monthFilter = chip.getAttribute("data-month") || "";
      chips.forEach(function(c){ c.className = "chip" + (c === chip ? " on" : "") + (c.classList.contains("all") ? " all" : " mo"); });
      applyFilters();
    });
  });

  /* ── 过滤 ── */
  var q = document.getElementById("q");
  q.addEventListener("input", applyFilters);

  /* ── 详情 ── */
  var panelName = document.getElementById("panelName");
  var panelMeta = document.getElementById("panelMeta");
  var panelBody = document.getElementById("panelBody");

  function clearHighlights(){
    DATA.points.forEach(function(p){ p.node.setAttribute("class", "pt"); });
    while (linkLayer.firstChild) linkLayer.removeChild(linkLayer.firstChild);
  }

  // 相似度不到 40% 的不算近邻：全库最近邻的 p25 是 41.8%，
  // 低于这个数基本就是"硬凑的第 5、6 名"，看着像关联其实只是噪声。
  var MIN_NEIGHBOR_SCORE = 0.4;

  function select(id){
    var point = byId[id];
    if (!point) return;

    clearHighlights();
    point.node.setAttribute("class", "pt hot");

    var candidates = (DATA.neighbors[id] || []).map(function(item){
      return { p: byId[item.id], score: item.score };
    }).filter(function(item){ return item.p; });
    var neighbors = candidates.filter(function(item){ return item.score >= MIN_NEIGHBOR_SCORE; });

    neighbors.forEach(function(item){
      item.p.node.setAttribute("class", "pt hot");
      linkLayer.appendChild(el("line", {
        x1: px(point), y1: py(point), x2: px(item.p), y2: py(item.p),
        stroke: "#1B1F24", "stroke-opacity": ".62", "stroke-width": "1.6"
      }));
    });

    var bestScore = candidates.length ? candidates[0].score : 0;
    panelName.textContent = point.t;
    panelMeta.textContent =
      (point.m || "") + " · " + (neighbors.length ? neighbors.length + " 个近邻" : "没有明显相近的对话");

    var rows = neighbors.map(function(item){
      return '<div class="row" data-id="' + item.p.id + '">' +
        '<span class="sc">' + (item.score * 100).toFixed(0) + '%</span>' +
        '<span class="nm">' + esc(item.p.t) + '</span>' +
        '<span class="mo">' + esc(item.p.m) + '</span></div>';
    }).join("");

    var emptyNote = candidates.length
      ? '<div class="empty">没有明显相近的对话（最近的也只有 ' + Math.round(bestScore * 100) + '%，属于不同话题）</div>'
      : '<div class="empty">没有邻居（缓存里只有一条）</div>';

    panelBody.innerHTML = (point.s ? '<div class="snippet">' + esc(point.s) + '</div>' : '') +
      '<div class="near-title">语义上最接近的对话</div>' +
      '<div class="near">' + (rows || emptyNote) + '</div>';

    Array.prototype.forEach.call(panelBody.querySelectorAll(".row"), function(row){
      row.addEventListener("click", function(){ select(row.getAttribute("data-id")); });
    });
  }

  applyView();

  // 支持 ?select=<id> 直接定位某段对话（也方便从别处链过来、方便截图验证）
  var preselect = new URLSearchParams(location.search).get("select");
  if (preselect && byId[preselect]) {
    select(preselect);
    var hit = byId[preselect];
    var span = 0.45;
    view.w = W * span;
    view.h = H * span;
    view.x = px(hit) - view.w / 2;
    view.y = py(hit) - view.h / 2;
    applyView();
  }
})();
</script>
</body>
</html>`;
}
