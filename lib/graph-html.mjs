/**
 * 把聚合结果渲染成一个自包含的 HTML（无 CDN、无服务器、双击即开）。
 *
 * 设计取向："地层" —— 五个月的注意力沉积成层。
 *   纸色是冷灰制图纸，不是奶油色；标题宋体、数字等宽；八条地层色分配给最重要的八个主题。
 * 签名元素：取样尺 —— 鼠标掠过河面时落一根竖线，尺脚读出那个月的构成。
 *
 * 三个为了保证"不误导"而做的决定：
 *   1. 最后一个月如果是残缺月（比如只到 4 号），标出来，别让断崖被读成兴趣消退；
 *   2. 「其他」放在最底层而不是最顶层，让它的灰当成地面，而不是压住数据；
 *   3. 层与层之间留一道纸色细缝，否则 8 个暖色会糊成一团。
 */

const PALETTE = ['#B0722B', '#A8442E', '#2E6F6A', '#33538C', '#5C7233', '#7A3E63', '#3F5566', '#8C7A4E'];
const NEUTRAL = '#9AA0A6';
const REST_FILL = '#C3C7BF';

/** 给浏览器用的紧凑载荷。 */
export function buildPayload(graph) {
  const allMonths = graph.months ?? [];
  const sorted = [...(graph.topics ?? [])].sort((a, b) => b.count - a.count);
  const countsByMonth = graph.countsByMonth ?? {};

  // 最后一个月如果只过了几天，把它排除出趋势线——否则尾巴断崖会被读成"兴趣崩塌"。
  // 数据不隐藏，在标题栏单独交代。
  const partial = partialInfo(graph.lastAt, allMonths);
  // 只有一个月份时不能剔——剔完就没图可画了
  const dropLast = allMonths.length > 1 && Boolean(partial) && partial.ratio < 0.8;
  const months = dropLast ? allMonths.slice(0, -1) : allMonths;
  const droppedMonth = dropLast ? allMonths[allMonths.length - 1] : null;

  const topics = sorted.map((topic, i) => ({
    id: topic.id,
    label: topic.label,
    count: topic.count,
    color: i < PALETTE.length ? PALETTE[i] : NEUTRAL,
    series: months.map((m) => topic.months?.[m] ?? 0),
  }));

  // 峰值必须用"真实每月对话数"，不能用各主题成员数之和（一个对话算两个主题会把峰值算错）
  let peakMonth = null;
  let peak = -1;
  for (const m of months) {
    const n = countsByMonth[m] ?? 0;
    if (n > peak) {
      peak = n;
      peakMonth = m;
    }
  }

  return {
    months,
    topics,
    edges: (graph.edges ?? []).map((e) => ({ a: e.a, b: e.b, w: e.weight })),
    convs: Object.fromEntries(
      Object.entries(graph.conversations ?? {}).map(([id, c]) => [id, { t: c.title, m: c.month, s: c.summary, tp: c.topics }]),
    ),
    totals: {
      conversations: graph.counts?.conversations ?? 0,
      topics: topics.length,
      peakMonth,
      peakCount: peak > 0 ? peak : 0,
    },
    omitted: droppedMonth
      ? { month: droppedMonth, count: countsByMonth[droppedMonth] ?? 0, days: partial.day, daysInMonth: partial.daysInMonth }
      : null,
  };
}

const htmlEscape = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** 最后一个月的覆盖率：只到 4 号的话，那个月的数据不能当整月看。 */
function partialInfo(lastAt, months) {
  if (!lastAt || months.length === 0) return null;
  const date = new Date(lastAt);
  if (Number.isNaN(date.getTime())) return null;

  const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  if (key !== months[months.length - 1]) return null;

  const daysInMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  const covered = date.getDate();
  if (covered >= daysInMonth - 2) return null; // 基本是整月，不用标
  return { month: key, day: covered, daysInMonth, ratio: covered / daysInMonth };
}

export function renderGraphHtml(graph, { title = '主题图谱', nav = '' } = {}) {
  const payload = buildPayload(graph);
  const omitted = payload.omitted;
  const dataJson = JSON.stringify(payload).replace(/</g, '\\u003c');

  const span = payload.months.length > 0 ? `${payload.months.at(0)} → ${payload.months.at(-1)}` : '无时间数据';
  const omittedNote = omitted ? `　${omitted.month} 只有 ${omitted.days} 天，未计入趋势` : '';

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${htmlEscape(title)}</title>
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
  body{
    background:var(--paper); color:var(--ink); font-family:var(--sans);
    font-size:14px; line-height:1.55; -webkit-font-smoothing:antialiased;
    background-image:
      repeating-linear-gradient(to right, rgba(27,31,36,.03) 0 1px, transparent 1px 96px),
      repeating-linear-gradient(to bottom, rgba(27,31,36,.03) 0 1px, transparent 1px 96px);
  }
  .wrap{max-width:1200px;margin:0 auto;padding:26px 22px 44px}

  header.top{display:flex;align-items:flex-end;justify-content:space-between;gap:18px;
    border-bottom:2px solid var(--ink);padding-bottom:11px;margin-bottom:22px;flex-wrap:wrap}
  h1{font-family:var(--serif);font-weight:700;font-size:32px;margin:0;line-height:1.1;letter-spacing:.01em}
  h1 .thin{font-weight:400;color:var(--ink-soft);font-size:13px;display:block;margin-top:6px;
    font-family:var(--mono);letter-spacing:.02em}
  .facts{display:flex;gap:26px;font-family:var(--mono);font-size:11px;color:var(--ink-soft);text-align:right}
  .facts div b{display:block;color:var(--ink);font-weight:700;font-size:19px;line-height:1.3;
    font-variant-numeric:tabular-nums}

  section{margin-bottom:26px}
  .eyebrow{font-family:var(--mono);font-size:10.5px;letter-spacing:.13em;text-transform:uppercase;
    color:var(--ink-soft);margin:0 0 9px;display:flex;justify-content:space-between;align-items:baseline;gap:12px}
  .eyebrow span:last-child{text-transform:none;letter-spacing:.04em;color:var(--ink-faint)}

  .chartcard{position:relative;border:1px solid var(--rule);background:var(--panel);padding:10px 6px 2px}
  #stream{display:block;width:100%;height:auto}
  .band{cursor:pointer;transition:opacity .18s ease,filter .18s ease}
  .band:hover{filter:brightness(1.06)}
  .band.dim{opacity:.14}
  .band.hot{opacity:1}
  .ruler{stroke:var(--ink);stroke-width:1;opacity:0;pointer-events:none}
  .ruler.on{opacity:.5}
  .readout{position:absolute;top:8px;left:10px;font-family:var(--mono);font-size:11.5px;
    color:var(--ink);background:rgba(246,247,243,.95);border:1px solid var(--rule);
    padding:6px 10px;pointer-events:none;opacity:0;transition:opacity .15s ease;max-width:62%}
  .readout.on{opacity:1}
  .readout .m{font-weight:700;margin-right:10px}
  .readout .dot{display:inline-block;width:7px;height:7px;margin-right:4px;vertical-align:baseline}
  .readout .sep{color:var(--ink-faint);margin:0 7px}

  .note{font-family:var(--mono);font-size:11px;color:var(--ink-soft);margin:9px 2px 0}

  .lower{display:grid;grid-template-columns:1.02fr .98fr;gap:18px;align-items:start}
  @media (max-width:880px){ .lower{grid-template-columns:1fr} }

  #net{display:block;width:100%;height:auto;border:1px solid var(--rule);background:var(--panel)}
  .node{cursor:pointer;outline:none}
  .node circle{transition:opacity .18s ease}
  .node text{font-family:var(--sans);font-size:10px;fill:var(--ink);pointer-events:none;
    paint-order:stroke;stroke:var(--panel);stroke-width:3px;stroke-linejoin:round}
  .node.dim{opacity:.18}
  .node:focus-visible circle{stroke:var(--ink);stroke-width:2.5;stroke-opacity:1}
  .link{stroke:#7E8790;stroke-opacity:.24;transition:stroke-opacity .18s ease,stroke .18s ease}
  .link.hot{stroke-opacity:.8;stroke:var(--ink)}

  #panel{border:1px solid var(--rule);background:var(--panel);display:flex;flex-direction:column}
  .panel-head{padding:11px 14px;border-bottom:1px solid var(--rule-soft)}
  .panel-head .name{font-size:16px;font-weight:600;display:flex;align-items:center;gap:8px;line-height:1.3}
  .panel-head .sw{width:10px;height:10px;display:inline-block;flex:none}
  .panel-head .meta{font-family:var(--mono);font-size:10.5px;color:var(--ink-soft);margin-top:3px}
  .panel-body{overflow:auto;max-height:430px}
  .row{display:flex;align-items:center;gap:9px;padding:7px 14px;cursor:pointer;
    border-bottom:1px solid var(--rule-soft);transition:background .12s ease}
  .row:last-child{border-bottom:none}
  .row:hover{background:rgba(27,31,36,.045)}
  .row .dot{width:8px;height:8px;flex:none}
  .row .nm{flex:1;font-size:13px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .row .ct{font-family:var(--mono);font-size:11px;color:var(--ink-soft);font-variant-numeric:tabular-nums}
  .conv{padding:8px 14px;border-bottom:1px solid var(--rule-soft)}
  .conv:last-child{border-bottom:none}
  .conv .t{font-size:13px;margin-bottom:2px}
  .conv .m{font-family:var(--mono);font-size:10.5px;color:var(--ink-soft);
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .empty{padding:20px 14px;color:var(--ink-soft);font-size:12.5px}
  @media (prefers-reduced-motion:reduce){ *{transition:none !important;animation:none !important} }
</style>
</head>
<body>
<div class="wrap">
${nav}

  <header class="top">
    <h1>${htmlEscape(title)}<span class="thin">${htmlEscape(span)}${htmlEscape(omittedNote)}</span></h1>
    <div class="facts">
      <div><b>${payload.totals.conversations}</b>段对话</div>
      <div><b>${payload.totals.topics}</b>个主题</div>
      <div><b>${payload.totals.peakMonth ?? '—'}</b>对话最多</div>
    </div>
  </header>

  <section>
    <p class="eyebrow"><span>主题流向 · 每月各主题的对话数</span><span>悬停取样 · 点击选层</span></p>
    <div class="chartcard">
      <svg id="stream" role="img" aria-label="各主题在每个月里的对话数"></svg>
      <div class="readout"></div>
    </div>
    <p class="note">前 8 个主题单独成层，其余合并成底部的浅灰「其他」。${
      omitted
        ? `${omitted.month} 只过了 ${omitted.days} 天（共 ${omitted.count} 段），天数不足，不画进趋势线——否则尾巴会被读成骤降。`
        : ''
    }</p>
  </section>

  <div class="lower">
    <section style="margin:0">
      <p class="eyebrow"><span>主题网络 · 同一段对话里共同出现</span><span>线越粗越常一起出现</span></p>
      <svg id="net" role="img" aria-label="主题之间的关联强度"></svg>
    </section>

    <section style="margin:0">
      <p class="eyebrow"><span>全部主题</span><span id="panelHint">按对话数排序 · 点击查看</span></p>
      <div id="panel">
        <div class="panel-head">
          <div class="name" id="panelName">全部主题</div>
          <div class="meta" id="panelMeta"></div>
        </div>
        <div class="panel-body" id="panelBody"></div>
      </div>
    </section>
  </div>
</div>

<script>
(function(){
  var DATA = ${dataJson};
  var NS = "http://www.w3.org/2000/svg";
  var months = DATA.months, topics = DATA.topics, edges = DATA.edges, convs = DATA.convs;
  var TOP_N = 8;

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
  function topicById(id){ for (var i=0;i<topics.length;i++){ if (topics[i].id===id) return topics[i]; } return null; }

  /* ───────── 层：顶部 8 个，其他压在最底层当地面 ───────── */
  var topBands = topics.slice(0, TOP_N).map(function(t){
    return { id: t.id, label: t.label, color: t.color, series: t.series.slice() };
  });
  var restCount = topics.slice(TOP_N).reduce(function(a,t){ return a + t.count; }, 0);
  var bands = [];
  if (restCount > 0){
    var restSeries = months.map(function(_, mi){
      var sum = 0;
      for (var ti = TOP_N; ti < topics.length; ti++) sum += topics[ti].series[mi] || 0;
      return sum;
    });
    bands.push({ id: "__rest__", label: "其他 " + (topics.length - TOP_N) + " 个主题",
      color: "${REST_FILL}", series: restSeries, faded: true });
  }
  bands = bands.concat(topBands);

  var svgStream = document.getElementById("stream");
  var W = 1120, H = 420, PAD = { l: 44, r: 34, t: 16, b: 38 };
  svgStream.setAttribute("viewBox", "0 0 " + W + " " + H);
  var innerW = W - PAD.l - PAD.r, innerH = H - PAD.t - PAD.b;

  var maxTotal = 0;
  months.forEach(function(_, mi){
    var total = 0;
    bands.forEach(function(b){ total += b.series[mi] || 0; });
    if (total > maxTotal) maxTotal = total;
  });
  maxTotal = maxTotal || 1;

  function xAt(t){ return PAD.l + innerW * t; }
  function yAt(v){ return PAD.t + innerH * (1 - v / maxTotal); }

  var SAMPLES = 140;
  function sampleSeries(series){
    var out = [];
    if (months.length === 1){ for (var s=0;s<SAMPLES;s++) out.push(series[0] || 0); return out; }
    for (var s2 = 0; s2 < SAMPLES; s2++){
      var t = s2 / (SAMPLES - 1) * (months.length - 1);
      var i0 = Math.min(Math.floor(t), months.length - 2);
      var frac = t - i0;
      var a = series[i0] || 0, b = series[i0 + 1] || 0;
      var w = (1 - Math.cos(Math.PI * frac)) / 2;
      out.push(a + (b - a) * w);
    }
    return out;
  }

  var sampled = bands.map(function(b){ return sampleSeries(b.series); });
  var stackBottom = new Array(SAMPLES).fill(0);
  var bandPaths = [];

  bands.forEach(function(band, bi){
    var top = [], bottom = [];
    for (var s = 0; s < SAMPLES; s++){
      bottom.push(stackBottom[s]);
      stackBottom[s] += sampled[bi][s];
      top.push(stackBottom[s]);
    }
    var d = "";
    for (var i = 0; i < SAMPLES; i++){
      d += (i === 0 ? "M" : "L") + xAt(i/(SAMPLES-1)).toFixed(1) + " " + yAt(top[i]).toFixed(1);
    }
    for (var j = SAMPLES - 1; j >= 0; j--){
      d += "L" + xAt(j/(SAMPLES-1)).toFixed(1) + " " + yAt(bottom[j]).toFixed(1);
    }
    d += "Z";

    // 层与层之间留一道纸色细缝，否则暖色会糊在一起
    var path = el("path", { d: d, fill: band.color, class: "band", "data-id": band.id,
      opacity: band.faded ? ".5" : ".88", stroke: "#F6F7F3", "stroke-width": ".9" });
    svgStream.appendChild(path);
    bandPaths.push({ id: band.id, node: path });
  });

  /* 网格与刻度 */
  [0, 0.25, 0.5, 0.75, 1].forEach(function(p){
    var v = Math.round(maxTotal * p);
    var y = yAt(v);
    svgStream.appendChild(el("line", { x1: PAD.l, y1: y, x2: W - PAD.r, y2: y,
      stroke: "#1B1F24", "stroke-opacity": p === 0 ? ".42" : ".07", "stroke-width": 1 }));
    if (p > 0){
      var t = el("text", { x: PAD.l - 9, y: y + 3.5, "text-anchor": "end",
        style: "font-family:var(--mono);font-size:10px;fill:var(--ink-faint)" });
      t.textContent = v;
      svgStream.appendChild(t);
    }
  });

  months.forEach(function(m, mi){
    var x = xAt(months.length === 1 ? 0.5 : mi / (months.length - 1));
    svgStream.appendChild(el("line", { x1: x, y1: PAD.t, x2: x, y2: PAD.t + innerH,
      stroke: "#1B1F24", "stroke-opacity": ".06", "stroke-width": 1 }));
    var label = el("text", { x: x, y: H - 14, "text-anchor": "middle",
      style: "font-family:var(--mono);font-size:11px;fill:var(--ink-soft)" });
    label.textContent = m;
    svgStream.appendChild(label);
  });

  /* 取样尺 */
  var ruler = el("line", { class: "ruler", x1: 0, y1: PAD.t, x2: 0, y2: PAD.t + innerH });
  svgStream.appendChild(ruler);
  var readout = document.querySelector(".readout");

  svgStream.addEventListener("mousemove", function(ev){
    var box = svgStream.getBoundingClientRect();
    var px = (ev.clientX - box.left) / box.width * W;
    if (px < PAD.l - 10 || px > W - PAD.r + 10 || months.length === 0) return;

    var t = (px - PAD.l) / innerW;
    var mi = Math.max(0, Math.min(months.length - 1, Math.round(t * (months.length - 1))));
    var x = xAt(months.length === 1 ? 0.5 : mi / (months.length - 1));
    ruler.setAttribute("x1", x); ruler.setAttribute("x2", x);
    ruler.setAttribute("class", "ruler on");

    var rows = [];
    for (var bi = 0; bi < topBands.length && rows.length < 3; bi++){
      var v = topBands[bi].series[mi] || 0;
      if (v > 0) rows.push('<span class="dot" style="background:' + topBands[bi].color + '"></span>' + esc(topBands[bi].label) + " " + v);
    }
    var total = 0;
    for (var s = 0; s < bands.length; s++) total += bands[s].series[mi] || 0;

    readout.innerHTML = '<span class="m">' + months[mi] + '</span>' + rows.join('<span class="sep">/</span>') +
      '<span class="sep">·</span>共 ' + total + ' 段';
    readout.className = "readout on";
  });
  svgStream.addEventListener("mouseleave", function(){
    ruler.setAttribute("class", "ruler");
    readout.className = "readout";
  });

  // 只有一个月时画不出趋势，别留个空框装作有数据
  if (months.length < 2){
    svgStream.innerHTML = "";
    var msg = el("text", { x: W/2, y: H/2, "text-anchor": "middle",
      style: "font-family:var(--mono);font-size:13px;fill:var(--ink-soft)" });
    msg.textContent = months.length === 1
      ? "只有 " + months[0] + " 一个月的数据，趋势图需要至少两个月"
      : "没有任何月份数据";
    svgStream.appendChild(msg);
  }

  /* ───────── 网络 ───────── */
  var svgNet = document.getElementById("net");
  var NW = 660, NH = 440;
  svgNet.setAttribute("viewBox", "0 0 " + NW + " " + NH);

  var maxCount = topics.reduce(function(a,t){ return Math.max(a, t.count); }, 1);
  var radius = function(c){ return 6 + 16 * Math.sqrt(c / maxCount); };

  var nodes = topics.map(function(t, i){
    var angle = i / Math.max(1, topics.length) * Math.PI * 2;
    var rr = 90 + Math.random() * 70;
    return { id: t.id, label: t.label, count: t.count, color: t.color,
      x: NW/2 + Math.cos(angle) * rr, y: NH/2 + Math.sin(angle) * rr,
      vx: 0, vy: 0, r: radius(t.count) };
  });
  var nodeById = {};
  nodes.forEach(function(n){ nodeById[n.id] = n; });
  var links = edges.filter(function(e){ return nodeById[e.a] && nodeById[e.b]; })
                   .map(function(e){ return { a: nodeById[e.a], b: nodeById[e.b], w: e.w }; });

  var maxW = links.reduce(function(a,l){ return Math.max(a, l.w); }, 1);
  for (var iter = 0; iter < 340; iter++){
    for (var i2 = 0; i2 < nodes.length; i2++){
      for (var j = i2 + 1; j < nodes.length; j++){
        var na = nodes[i2], nb = nodes[j];
        var dx = nb.x - na.x, dy = nb.y - na.y;
        var dist2 = dx*dx + dy*dy || 0.01;
        var dist = Math.sqrt(dist2);
        var force = 3400 / dist2;
        var fx = dx / dist * force, fy = dy / dist * force;
        na.vx -= fx; na.vy -= fy; nb.vx += fx; nb.vy += fy;
      }
    }
    links.forEach(function(l){
      var dx2 = l.b.x - l.a.x, dy2 = l.b.y - l.a.y;
      var d = Math.sqrt(dx2*dx2 + dy2*dy2) || 0.01;
      var target = 104 + 40 * (1 - l.w / maxW);
      var k = (d - target) * 0.014;
      l.a.vx += dx2 / d * k; l.a.vy += dy2 / d * k;
      l.b.vx -= dx2 / d * k; l.b.vy -= dy2 / d * k;
    });
    nodes.forEach(function(n){
      n.vx += (NW/2 - n.x) * 0.003; n.vy += (NH/2 - n.y) * 0.003;
      n.vx *= 0.8; n.vy *= 0.8;
      n.x += n.vx; n.y += n.vy;
    });
  }

  // 去重叠：圆和标签都不许压在一起
  for (var pass = 0; pass < 90; pass++){
    for (var a1 = 0; a1 < nodes.length; a1++){
      for (var b1 = a1 + 1; b1 < nodes.length; b1++){
        var p = nodes[a1], q = nodes[b1];
        var ddx = q.x - p.x, ddy = q.y - p.y;
        var dd = Math.sqrt(ddx*ddx + ddy*ddy) || 0.01;
        var min = p.r + q.r + 34;
        if (dd < min){
          var push = (min - dd) / dd * 0.5;
          p.x -= ddx * push; p.y -= ddy * push;
          q.x += ddx * push; q.y += ddy * push;
        }
      }
    }
    nodes.forEach(function(n){
      n.x = Math.max(n.r + 32, Math.min(NW - n.r - 32, n.x));
      n.y = Math.max(n.r + 22, Math.min(NH - n.r - 22, n.y));
    });
  }

  var linkLayer = el("g", {});
  links.forEach(function(l){
    var line = el("line", { class: "link", x1: l.a.x, y1: l.a.y, x2: l.b.x, y2: l.b.y,
      "stroke-width": (0.8 + 2.2 * (l.w / maxW)).toFixed(2) });
    linkLayer.appendChild(line);
    l.node = line;
  });
  svgNet.appendChild(linkLayer);

  var nodeLayer = el("g", {});
  nodes.forEach(function(n){
    var g = el("g", { class: "node", "data-id": n.id, tabindex: "0", role: "button",
      "aria-label": n.label + "，" + n.count + " 段对话" });
    g.appendChild(el("circle", { cx: n.x, cy: n.y, r: n.r, fill: n.color, "fill-opacity": ".85",
      stroke: "#1B1F24", "stroke-opacity": ".22" }));
    var label = el("text", { x: n.x, y: n.y + n.r + 12, "text-anchor": "middle" });
    label.textContent = n.label;
    g.appendChild(label);
    nodeLayer.appendChild(g);
    n.node = g;
  });
  svgNet.appendChild(nodeLayer);

  /* ───────── 面板 ───────── */
  var panelName = document.getElementById("panelName");
  var panelMeta = document.getElementById("panelMeta");
  var panelBody = document.getElementById("panelBody");
  var panelHint = document.getElementById("panelHint");

  function conversationsOf(topicId){
    var out = [];
    for (var id in convs){
      var c = convs[id];
      if (c.tp && c.tp.indexOf(topicId) !== -1) out.push({ id: id, title: c.t, month: c.m, summary: c.s });
    }
    return out.sort(function(x,y){ return String(x.month||"").localeCompare(String(y.month||"")); });
  }

  /* 高亮是"绘"不是"选"：悬停和选中共用同一套着色，鼠标移开后回到当前选中态 */
  var currentSel = null;

  function paintHighlights(id){
    bandPaths.forEach(function(bp){
      bp.node.setAttribute("class", "band" + (id ? (bp.id === id ? " hot" : " dim") : ""));
    });
    var neighbors = {};
    links.forEach(function(l){
      var hit = Boolean(id) && (l.a.id === id || l.b.id === id);
      l.node.setAttribute("class", "link" + (hit ? " hot" : ""));
      if (hit){ neighbors[l.a.id] = true; neighbors[l.b.id] = true; }
    });
    nodes.forEach(function(n){
      var on = !id || n.id === id || neighbors[n.id];
      n.node.setAttribute("class", "node" + (on ? "" : " dim"));
      n.node.firstChild.setAttribute("fill-opacity", id && n.id === id ? "1" : ".85");
    });
  }

  function bindRows(){
    Array.prototype.forEach.call(panelBody.querySelectorAll(".row"), function(row){
      var id = row.getAttribute("data-id");
      row.addEventListener("click", function(){ select(id); });
      row.addEventListener("mouseenter", function(){ paintHighlights(id); });
      row.addEventListener("mouseleave", function(){ paintHighlights(currentSel); });
    });
  }

  function renderTopicList(){
    panelName.textContent = "全部主题";
    panelMeta.textContent = topics.length + " 个主题 · 共 " + DATA.totals.conversations + " 段对话";
    panelHint.textContent = "按对话数排序 · 点击查看";
    panelBody.innerHTML = topics.map(function(t){
      return '<div class="row" data-id="' + t.id + '">' +
        '<span class="dot" style="background:' + t.color + '"></span>' +
        '<span class="nm">' + esc(t.label) + '</span>' +
        '<span class="ct">' + t.count + '</span></div>';
    }).join("");
    bindRows();
  }

  function clearSelection(){
    currentSel = null;
    paintHighlights(null);
    renderTopicList();
  }

  function select(topicId){
    if (topicId === "__rest__"){
      currentSel = null;
      paintHighlights(null);
      var rest = topics.slice(TOP_N);
      panelName.textContent = "其他 · " + rest.length + " 个主题";
      panelMeta.textContent = "合计 " + restCount + " 段对话";
      panelHint.textContent = "点任一主题查看";
      panelBody.innerHTML = rest.map(function(t){
        return '<div class="row" data-id="' + t.id + '">' +
          '<span class="dot" style="background:' + t.color + '"></span>' +
          '<span class="nm">' + esc(t.label) + '</span>' +
          '<span class="ct">' + t.count + '</span></div>';
      }).join("");
      bindRows();
      return;
    }

    var topic = topicById(topicId);
    if (!topic) return;

    currentSel = topicId;
    paintHighlights(topicId);

    var list = conversationsOf(topicId);
    var partner = links.filter(function(l){ return l.a.id === topicId || l.b.id === topicId; })
      .sort(function(x,y){ return y.w - x.w; })
      .slice(0, 3)
      .map(function(l){ return (l.a.id === topicId ? l.b.label : l.a.label); });

    panelName.innerHTML = '<span class="sw" style="background:' + topic.color + '"></span>' + esc(topic.label);
    panelMeta.textContent = list.length + " 段对话" + (partner.length ? " · 常与「" + partner.join("」「") + "」同现" : "");
    panelHint.textContent = "按时间排序";
    panelBody.innerHTML = list.map(function(item){
      return '<div class="conv"><div class="t">' + esc(item.title || "(无标题)") + '</div>' +
        '<div class="m">' + (item.month || "") + (item.summary ? " · " + esc(item.summary) : "") + '</div></div>';
    }).join("") || '<div class="empty">这个主题下没有对话。</div>';
  }

  Array.prototype.forEach.call(document.querySelectorAll(".band"), function(node){
    node.addEventListener("click", function(){ select(node.getAttribute("data-id")); });
  });
  nodes.forEach(function(n){
    n.node.addEventListener("click", function(){ select(n.id); });
    n.node.addEventListener("keydown", function(ev){
      if (ev.key === "Enter" || ev.key === " "){ ev.preventDefault(); select(n.id); }
    });
  });
  svgNet.addEventListener("click", function(ev){
    if (ev.target === svgNet) clearSelection();
  });

  clearSelection();
})();
</script>
</body>
</html>`;
}
