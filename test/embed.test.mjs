import test from 'node:test';
import assert from 'node:assert/strict';

import { cosine, decodeVector, encodeVector, layout2d, nearest, normalize, pca2, tsne } from '../lib/embed.mjs';
import { buildAtlasPayload, monthColor, normalizeCoords, renderAtlasHtml } from '../lib/atlas-html.mjs';

/* ───────────────── 编解码 ───────────────── */

test('向量编解码：二进制往返不丢精度', () => {
  const original = [0.1, -0.25, 0.3333333333, 1, -1, 0, 1e-7];
  const decoded = decodeVector(encodeVector(original));

  assert.equal(decoded.length, original.length);
  original.forEach((value, i) => {
    // float32 只有 7 位有效数字
    assert.ok(Math.abs(decoded[i] - value) < 1e-6, `第 ${i} 位：${decoded[i]} vs ${value}`);
  });
});

test('向量编解码：长度不是 3 的倍数也要正确', () => {
  for (const length of [1, 2, 4, 5, 7, 8, 1024]) {
    const vector = Array.from({ length }, (_, i) => i * 0.01);
    const decoded = decodeVector(encodeVector(vector));
    assert.equal(decoded.length, length, `长度 ${length} 时出错`);
    assert.ok(Math.abs(decoded[length - 1] - vector[length - 1]) < 1e-5);
  }
});

/* ───────────────── 向量运算 ───────────────── */

test('归一化后长度为 1，零向量返回零', () => {
  const unit = normalize(Float32Array.from([3, 4]));
  assert.ok(Math.abs(Math.hypot(unit[0], unit[1]) - 1) < 1e-6);

  const zero = normalize(Float32Array.from([0, 0, 0]));
  assert.deepEqual(Array.from(zero), [0, 0, 0]);
});

test('余弦相似度：同向 1、正交 0、反向 -1', () => {
  assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-6);
  assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-6);
  assert.ok(Math.abs(cosine([1, 0], [-1, 0]) + 1) < 1e-6);
  assert.equal(cosine([0, 0], [1, 0]), 0, '零向量不能产生 NaN');
});

test('余弦相似度：维度不一致要报错而不是给出错误答案', () => {
  assert.throws(() => cosine([1, 2], [1, 2, 3]), /维度不一致/);
});

test('最近邻按相似度降序返回', () => {
  const target = normalize(Float32Array.from([1, 0]));
  const items = [
    { id: 'far', vector: normalize(Float32Array.from([0, 1])) },
    { id: 'near', vector: normalize(Float32Array.from([1, 0.1])) },
    { id: 'mid', vector: normalize(Float32Array.from([1, 1])) },
  ];
  const hits = nearest(target, items, 2);
  assert.deepEqual(hits.map((h) => h.id), ['near', 'mid']);
});

/* ───────────────── 投影 ───────────────── */

function randomVectors(n, dim = 8) {
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };
  return Array.from({ length: n }, () => Float32Array.from({ length: dim }, rand));
}

test('pca2 返回二维坐标，数量与输入一致', () => {
  const vectors = randomVectors(20);
  const coords = pca2(vectors);
  assert.equal(coords.length, 20);
  coords.forEach(([x, y]) => {
    assert.ok(Number.isFinite(x) && Number.isFinite(y));
  });
});

test('t-SNE 不塌缩：点要真的散开，不能全挤在一个位置', () => {
  const coords = tsne(randomVectors(60), { iterations: 200 });
  assert.equal(coords.length, 60);

  // 输出尺度取决于学习率与迭代次数，这里只判断"有没有塌缩"
  const distinct = new Set(coords.map(([x, y]) => `${x.toFixed(6)},${y.toFixed(6)}`)).size;
  assert.ok(distinct > coords.length * 0.9, `只有 ${distinct} 个不同位置，塌缩了`);

  const xs = coords.map(([x]) => x);
  assert.ok(Math.max(...xs) - Math.min(...xs) > 0);
  coords.forEach(([x, y]) => assert.ok(Number.isFinite(x) && Number.isFinite(y)));
});

test('t-SNE 对相同输入可复现（用 PCA 初始化，不用随机数）', () => {
  const vectors = randomVectors(30);
  const a = tsne(vectors, { iterations: 80 });
  const b = tsne(vectors, { iterations: 80 });
  assert.deepEqual(a, b);
});

test('t-SNE 点数太少时退回 PCA，不崩', () => {
  assert.deepEqual(tsne([]), []);
  assert.equal(tsne(randomVectors(3)).length, 3);
});

/* ───────────────── 力导向布局 ───────────────── */

/** 造 3 个明显分离的团。 */
function clusteredVectors(perCluster = 15, dim = 12) {
  let seed = 99;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };
  const centers = [
    Array.from({ length: dim }, () => 2 + rand() * 0.1),
    Array.from({ length: dim }, () => -2 + rand() * 0.1),
    Array.from({ length: dim }, (_, i) => (i % 2 ? 2 : -2)),
  ];

  const vectors = [];
  const label = [];
  centers.forEach((center, ci) => {
    for (let i = 0; i < perCluster; i += 1) {
      vectors.push(Float32Array.from(center.map((value) => value + rand() * 0.4)));
      label.push(ci);
    }
  });
  return { vectors, label };
}

test('力导向布局：同一团内的点要明显比跨团近', () => {
  const { vectors, label } = clusteredVectors();
  const coords = layout2d(vectors, { iterations: 400 });

  assert.equal(coords.length, vectors.length);
  coords.forEach(([x, y]) => assert.ok(Number.isFinite(x) && Number.isFinite(y)));

  let intra = 0;
  let intraN = 0;
  let inter = 0;
  let interN = 0;
  for (let i = 0; i < coords.length; i += 1) {
    for (let j = i + 1; j < coords.length; j += 1) {
      const d = Math.hypot(coords[i][0] - coords[j][0], coords[i][1] - coords[j][1]);
      if (label[i] === label[j]) {
        intra += d;
        intraN += 1;
      } else {
        inter += d;
        interN += 1;
      }
    }
  }

  const ratio = intra / intraN / (inter / interN);
  assert.ok(ratio < 0.5, `同团距离应明显更小，实际比值 ${ratio.toFixed(2)}`);
});

test('力导向布局：确定性可复现', () => {
  const { vectors } = clusteredVectors(8);
  assert.deepEqual(layout2d(vectors, { iterations: 60 }), layout2d(vectors, { iterations: 60 }));
});

test('力导向布局：点数太少时退回 PCA', () => {
  assert.deepEqual(layout2d([]), []);
  assert.equal(layout2d(randomVectors(3)).length, 3);
});

test('normalizeCoords 把坐标压进 0-1000', () => {
  const coords = normalizeCoords([
    [-5, 2],
    [0, 0],
    [10, 8],
  ]);
  coords.forEach(([x, y]) => {
    assert.ok(x >= -1 && x <= 1001 && y >= -1 && y <= 1001, `越界：${x},${y}`);
  });
});

/* ───────────────── 页面 ───────────────── */

const sampleAtlas = {
  points: [
    { i: 0, id: 'a', x: 100, y: 200, t: '关于显存', m: '2026-07', c: '#B0722B', s: '聊了显存不足' },
    { i: 1, id: 'b', x: 300, y: 400, t: '摩托车', m: '2026-08', c: '#2E6F6A', s: '上牌流程' },
  ],
  months: ['2026-07', '2026-08'],
  neighbors: { a: [{ id: 'b', score: 0.81 }], b: [] },
  meta: { model: 'test-embed', dim: 8 },
};

test('星座图载荷保留字段与邻居', () => {
  const atlas = buildAtlasPayload({
    items: [
      { id: 'a', title: '关于显存', month: '2026-07', snippet: '聊了显存不足' },
      { id: 'b', title: '摩托车', month: '2026-08', snippet: '' },
    ],
    coords: [
      [10, 20],
      [30, 40],
    ],
    neighbors: { a: [{ id: 'b', score: 0.81 }] },
    months: ['2026-07', '2026-08'],
    meta: { model: 'x', dim: 8 },
  });

  assert.equal(atlas.points.length, 2);
  assert.equal(atlas.points[0].t, '关于显存');
  assert.equal(atlas.points[0].c.length, 7, '每个点都要有颜色');
  assert.deepEqual(atlas.neighbors.a, [{ id: 'b', score: 0.81 }]);
});

test('月份颜色随时间变化', () => {
  const early = monthColor(0, 5);
  const late = monthColor(4, 5);
  assert.notEqual(early, late);
  assert.equal(monthColor(0, 1), monthColor(0, 1), '只有一个月时也要稳定');
});

test('星座图页面：数据内嵌、提示到位、无残留占位符', () => {
  const html = renderAtlasHtml(sampleAtlas, { title: '我的星座图' });

  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /我的星座图/);
  assert.match(html, /var DATA = /);
  assert.match(html, /簇与簇之间的绝对距离没有意义/, '必须写上二维投影的误读警告');
  assert.doesNotMatch(html, /\$\{/);
});

test('星座图页面：标题里的尖括号不能提前闭合 script', () => {
  const nasty = {
    ...sampleAtlas,
    points: [{ ...sampleAtlas.points[0], t: '</script><img src=x onerror=alert(1)>' }],
  };
  const html = renderAtlasHtml(nasty);
  assert.doesNotMatch(html, /<\/script><img/i);
});
