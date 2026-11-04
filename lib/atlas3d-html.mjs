/**
 * 三维星座图页面。
 *
 * 纯 canvas 手写投影，不引 three.js：497 个点画圆就够，引一个 600KB 的库不划算。
 * 交互：拖动旋转（带惯性）、滚轮缩放、悬停看标题、点击选中并连到最近邻。
 */

const MONTH_COLORS = [
  '#E0A458', '#D9614C', '#4FA3A0', '#6E8FD6', '#93B44B', '#B37BB0', '#7A9AA8', '#C4A46A',
];

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export function renderAtlas3dHtml({ title = '对话星座图 3D', nav = '', atlas }) {
  const months = [...new Set((atlas.points ?? []).map((p) => p.m).filter(Boolean))].sort();

  const chips = [
    `<span class="chip all on" data-month="">全部</span>`,
    ...months.map(
      (m, i) =>
        `<span class="chip mo" data-month="${escapeHtml(m)}"><i style="background:${MONTH_COLORS[i % MONTH_COLORS.length]}"></i>${escapeHtml(m)}</span>`,
    ),
  ].join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root{--paper:#F6F7F3;--ink:#1B1F24;--ink-soft:#4A525B;--ink-faint:#7E8791;
    --rule:#D8DBD2;--panel:#EEEFE9;--mono:ui-monospace,SFMono-Regular,"Cascadia Mono",Consolas,monospace}
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);
    font-family:-apple-system,"Segoe UI","Noto Sans SC",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
  .wrap{max-width:1180px;margin:0 auto;padding:26px 22px 60px}
  nav.top{border-bottom:2px solid var(--ink);margin:0 -22px 26px;padding:14px 22px 0;
    display:flex;gap:22px;align-items:baseline}
  nav.top .brand{font-family:var(--mono);font-weight:700;font-size:15px;margin-right:8px}
  nav.top a{text-decoration:none;font-family:var(--mono);font-size:12px;color:var(--ink-soft);
    padding-bottom:12px;border-bottom:2px solid transparent}
  nav.top a:hover{color:var(--ink)}
  nav.top a.on{color:var(--ink);border-bottom-color:var(--ink)}
  header.top{display:flex;justify-content:space-between;align-items:flex-end;gap:20px;
    border-bottom:1px solid var(--rule);padding-bottom:16px;margin-bottom:18px}
  h1{font-size:30px;margin:0;letter-spacing:-.02em}
  h1 .thin{font-weight:400;color:var(--ink-soft);font-size:13px;display:block;margin-top:6px}
  .facts{display:flex;gap:26px;font-family:var(--mono);font-size:11px;color:var(--ink-soft);text-align:right}
  .facts b{display:block;color:var(--ink);font-size:19px}

  .stage{position:relative;background:#10151A;border:1px solid #232A32;overflow:hidden}
  canvas{display:block;width:100%;height:620px;cursor:grab;touch-action:none}
  canvas.dragging{cursor:grabbing}
  .hud{position:absolute;left:14px;top:12px;font-family:var(--mono);font-size:10.5px;
    color:#7C8A99;letter-spacing:.04em;pointer-events:none;line-height:1.7}
  .tools{position:absolute;right:12px;top:10px;display:flex;gap:8px}
  .tools button{font-family:var(--mono);font-size:11px;padding:5px 10px;cursor:pointer;
    background:#1B222B;color:#AEBAC7;border:1px solid #2C3540}
  .tools button.on{background:#2E6F6A;color:#EAF4F2;border-color:#3E8F89}
  .tip{position:absolute;pointer-events:none;opacity:0;transition:opacity .1s;
    background:rgba(9,12,15,.94);color:#EDF1F5;padding:6px 10px;font-size:12px;max-width:340px;
    border:1px solid #2C3540;line-height:1.5}
  .tip.on{opacity:1}
  .tip .mo{display:block;font-family:var(--mono);font-size:10px;color:#8FA0B0;margin-top:3px}

  .legend{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0}
  .chip{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border:1px solid var(--rule);
    font-size:12px;color:var(--ink-soft);cursor:pointer;background:var(--panel)}
  .chip i{width:9px;height:9px;border-radius:50%;display:inline-block}
  .chip.on{border-color:var(--ink);background:var(--ink);color:var(--paper)}

  .lower{display:grid;grid-template-columns:1fr;gap:16px;margin-top:18px}
  #panel{border:1px solid var(--rule);background:#fff}
  .panel-head{padding:12px 16px;border-bottom:1px solid var(--rule)}
  .panel-head .name{font-size:16px;font-weight:700}
  .panel-head .meta{font-family:var(--mono);font-size:11px;color:var(--ink-faint);margin-top:4px}
  .panel-body{padding:14px 16px;font-size:13px;line-height:1.7;color:var(--ink-soft)}
  .panel-body .empty{color:var(--ink-faint)}
  .nb{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px solid #EEEFE9;
    text-decoration:none;color:inherit}
  .nb:hover{background:#F5F6F2}
  .nb .s{font-family:var(--mono);font-size:11px;color:var(--ink-faint);flex:none}
  .note{font-size:12.5px;color:var(--ink-soft);line-height:1.75;margin:16px 0 0}
  a{color:inherit}
</style>
</head>
<body>
<div class="wrap">
${nav}
<header class="top">
  <h1>${escapeHtml(title)}<span class="thin">拖动旋转 · 滚轮缩放 · 点击看近邻</span></h1>
  <div class="facts">
    <div><b>${(atlas.points ?? []).length}</b>段对话</div>
    <div><b>${months.length}</b>个月份</div>
    <div><b>${escapeHtml(atlas.layout === 'pca3' ? 'PCA' : 't-SNE')}</b>三维投影</div>
  </div>
</header>

<div class="stage">
  <canvas id="sky"></canvas>
  <div class="hud" id="hud">拖动旋转 · 滚轮缩放</div>
  <div class="tools">
    <button id="spin" type="button" class="on">自动旋转</button>
    <button id="reset" type="button">复位视角</button>
  </div>
  <div class="tip" id="tip"></div>
</div>

<div class="legend">${chips}</div>

<div class="lower">
  <div id="panel">
    <div class="panel-head">
      <div class="name" id="panelName">点一个点</div>
      <div class="meta" id="panelMeta"></div>
    </div>
    <div class="panel-body" id="panelBody">
      <div class="empty">点任意一个点，看它最近邻的几个对话。</div>
    </div>
  </div>
</div>

<p class="note">
  <b>距离只表示"说得像"，不表示"重要"。</b>三维投影是有损的，转一圈能看出大致的疏密和分层，
  但别把三维里的绝对距离当真。颜色是对话所在的月份，点图例会只看那个月。
  模型：<span style="font-family:var(--mono)">${escapeHtml(atlas.model ?? '未知')}</span>
</p>
</div>

<script>
(function(){
  var DATA = ${JSON.stringify({ points: atlas.points ?? [] })};
  var MONTH_COLORS = ${JSON.stringify(MONTH_COLORS)};

  var canvas = document.getElementById("sky");
  var ctx = canvas.getContext("2d");
  var tip = document.getElementById("tip");
  var hud = document.getElementById("hud");
  var panelName = document.getElementById("panelName");
  var panelMeta = document.getElementById("panelMeta");
  var panelBody = document.getElementById("panelBody");

  var months = [];
  DATA.points.forEach(function(p){ if (p.m && months.indexOf(p.m) === -1) months.push(p.m); });
  months.sort();
  var colorOf = {};
  months.forEach(function(m, i){ colorOf[m] = MONTH_COLORS[i % MONTH_COLORS.length]; });

  DATA.points.forEach(function(p){ p.color = colorOf[p.m] || "#8FA0B0"; });
  var byId = {};
  DATA.points.forEach(function(p){ byId[p.id] = p; });

  var view = { yaw: 0.6, pitch: 0.28, dist: 2.6 };
  var spin = true;
  var monthFilter = "";
  var selected = null;
  var hovered = null;
  var dragging = false;
  var last = null;
  var vel = { yaw: 0, pitch: 0 };
  var size = { w: 0, h: 0, dpr: 1 };

  function resize(){
    var rect = canvas.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    size.w = rect.width; size.h = rect.height; size.dpr = dpr;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  // 旋转 + 透视投影，返回屏幕坐标和深度
  function project(p){
    var cy = Math.cos(view.yaw), sy = Math.sin(view.yaw);
    var cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);

    var x1 = p.x * cy - p.z * sy;
    var z1 = p.x * sy + p.z * cy;
    var y2 = p.y * cp - z1 * sp;
    var z2 = p.y * sp + z1 * cp;

    var depth = z2 + view.dist;
    if (depth < 0.35) depth = 0.35;
    var f = Math.min(size.w, size.h) * 1.15;
    var scale = f / depth;

    return {
      sx: size.w / 2 + x1 * scale,
      sy: size.h / 2 - y2 * scale,
      depth: depth,
      scale: scale,
    };
  }

  function visible(p){
    return !monthFilter || p.m === monthFilter;
  }

  function draw(){
    ctx.clearRect(0, 0, size.w, size.h);

    // 背景渐变，让"星空"有点纵深
    var bg = ctx.createRadialGradient(size.w/2, size.h/2, 40, size.w/2, size.h/2, Math.max(size.w, size.h)*0.75);
    bg.addColorStop(0, "#151C23");
    bg.addColorStop(1, "#0B0F13");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, size.w, size.h);

    // 先算投影，按深度从远到近画
    var drawn = [];
    for (var i = 0; i < DATA.points.length; i++){
      var p = DATA.points[i];
      if (!visible(p)) continue;
      var s = project(p);
      if (s.sx < -60 || s.sx > size.w + 60 || s.sy < -60 || s.sy > size.h + 60) continue;
      drawn.push({ p: p, s: s });
    }
    drawn.sort(function(a, b){ return b.s.depth - a.s.depth; });

    // 选中点的近邻连线
    if (selected){
      var origin = selected;
      var os = project(origin);
      var linked = {};
      (origin.n || []).forEach(function(n){ linked[n.id] = n.score; });

      drawn.forEach(function(d){
        if (!linked[d.p.id]) return;
        ctx.beginPath();
        ctx.moveTo(os.sx, os.sy);
        ctx.lineTo(d.s.sx, d.s.sy);
        ctx.strokeStyle = "rgba(126,200,178," + (0.18 + 0.5 * linked[d.p.id]).toFixed(3) + ")";
        ctx.lineWidth = 1.1;
        ctx.stroke();
      });
    }

    drawn.forEach(function(d){
      var p = d.p, s = d.s;
      var depth01 = Math.max(0, Math.min(1, (4.2 - s.depth) / 3.2));
      var r = 2.2 + 4.2 * depth01;
      var alpha = 0.35 + 0.6 * depth01;

      var isSel = selected && selected.id === p.id;
      var isHover = hovered && hovered.id === p.id;
      var isNb = selected && (selected.n || []).some(function(n){ return n.id === p.id; });

      if (isSel || isHover){
        ctx.beginPath();
        ctx.arc(s.sx, s.sy, r + 5.5, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(126,200,178,.22)";
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(s.sx, s.sy, isSel ? r + 1.6 : r, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = isSel || isHover ? 1 : (isNb ? 0.95 : alpha);
      ctx.fill();
      ctx.globalAlpha = 1;

      if (isSel || isHover){
        ctx.strokeStyle = "#EAF4F2";
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }
    });

    hud.textContent = "拖动旋转 · 滚轮缩放 · 转了 " + Math.round(view.yaw * 57.3 % 360) + "°";
  }

  function frame(){
    if (!dragging){
      if (spin) view.yaw += 0.0035;
      // 惯性
      view.yaw += vel.yaw;
      view.pitch += vel.pitch;
      vel.yaw *= 0.94;
      vel.pitch *= 0.94;
      if (Math.abs(vel.yaw) > 1e-5 || Math.abs(vel.pitch) > 1e-5 || spin) draw();
    }
    requestAnimationFrame(frame);
  }

  /* ── 交互 ── */
  function hitTest(ev){
    var rect = canvas.getBoundingClientRect();
    var mx = ev.clientX - rect.left;
    var my = ev.clientY - rect.top;
    var best = null;
    var bestDist = 14;

    for (var i = 0; i < DATA.points.length; i++){
      var p = DATA.points[i];
      if (!visible(p)) continue;
      var s = project(p);
      var dx = s.sx - mx, dy = s.sy - my;
      var d = Math.sqrt(dx*dx + dy*dy);
      if (d < bestDist){ bestDist = d; best = p; }
    }
    return best;
  }

  canvas.addEventListener("pointerdown", function(ev){
    dragging = true;
    last = { x: ev.clientX, y: ev.clientY };
    vel.yaw = 0; vel.pitch = 0;
    canvas.setPointerCapture(ev.pointerId);
    canvas.className = "dragging";
  });

  canvas.addEventListener("pointermove", function(ev){
    if (dragging && last){
      var dx = ev.clientX - last.x;
      var dy = ev.clientY - last.y;
      view.yaw += dx * 0.006;
      view.pitch = Math.max(-1.45, Math.min(1.45, view.pitch - dy * 0.006));
      vel.yaw = dx * 0.0016;
      vel.pitch = -dy * 0.0016;
      last = { x: ev.clientX, y: ev.clientY };
      draw();
      return;
    }

    var found = hitTest(ev);
    if (found !== hovered){
      hovered = found;
      draw();
    }
    if (found){
      var rect = canvas.getBoundingClientRect();
      tip.innerHTML = esc(found.t) + '<span class="mo">' + esc(found.m) + (found.s ? " · " + esc(found.s) : "") + '</span>';
      tip.className = "tip on";
      var left = ev.clientX - rect.left + 16;
      var top = ev.clientY - rect.top + 14;
      if (left + 340 > rect.width) left = Math.max(6, left - 356);
      if (top + 70 > rect.height) top = Math.max(6, top - 76);
      tip.style.left = left + "px";
      tip.style.top = top + "px";
    } else {
      tip.className = "tip";
    }
  });

  canvas.addEventListener("pointerup", function(ev){
    dragging = false;
    canvas.className = "";
    try { canvas.releasePointerCapture(ev.pointerId); } catch (e) {}
    var found = hitTest(ev);
    if (found) select(found);
  });

  canvas.addEventListener("wheel", function(ev){
    ev.preventDefault();
    view.dist = Math.max(1.1, Math.min(9, view.dist * (ev.deltaY > 0 ? 1.1 : 0.9)));
    draw();
  }, { passive: false });

  canvas.addEventListener("pointerleave", function(){
    if (hovered){ hovered = null; draw(); }
    tip.className = "tip";
  });

  document.getElementById("spin").addEventListener("click", function(ev){
    spin = !spin;
    ev.target.className = spin ? "on" : "";
  });

  document.getElementById("reset").addEventListener("click", function(){
    view.yaw = 0.6; view.pitch = 0.28; view.dist = 2.6;
    vel.yaw = 0; vel.pitch = 0;
    selected = null;
    paintPanel(null);
    draw();
  });

  document.querySelectorAll(".chip").forEach(function(chip){
    chip.addEventListener("click", function(){
      monthFilter = chip.getAttribute("data-month") || "";
      document.querySelectorAll(".chip").forEach(function(c){ c.className = "chip" + (c === chip ? " on" : ""); });
      draw();
    });
  });

  function select(p){
    selected = p;
    draw();
    paintPanel(p);
  }

  function paintPanel(p){
    if (!p){
      panelName.textContent = "点一个点";
      panelMeta.textContent = "";
      panelBody.innerHTML = '<div class="empty">点任意一个点，看它最近邻的几个对话。</div>';
      return;
    }
    panelName.innerHTML = '<a href="/chat/' + encodeURIComponent(p.id) + '">' + esc(p.t) + '</a>';
    panelMeta.textContent = p.m || "";
    var rows = (p.n || []).map(function(n){
      var target = byId[n.id];
      if (!target) return "";
      return '<a class="nb" href="/chat/' + encodeURIComponent(target.id) + '">' +
        '<span>' + esc(target.t) + '</span>' +
        '<span class="s">' + Math.round(n.score * 100) + '%</span></a>';
    }).join("");
    panelBody.innerHTML = (p.s ? '<div style="margin-bottom:10px">' + esc(p.s) + '</div>' : '') +
      '<div style="font-family:var(--mono);font-size:10.5px;color:var(--ink-faint);margin-bottom:6px">语义上最接近</div>' +
      (rows || '<div class="empty">没有近邻数据</div>');
  }

  function esc(value){
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  window.addEventListener("resize", resize);
  resize();
  requestAnimationFrame(frame);
})();
</script>
</body>
</html>`;
}
