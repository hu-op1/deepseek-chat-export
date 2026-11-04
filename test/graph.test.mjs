import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPayload, renderGraphHtml } from '../lib/graph-html.mjs';

const baseGraph = {
  months: ['2026-07', '2026-08', '2026-09', '2026-11'],
  lastAt: '2026-11-04T10:00:00.000Z',
  countsByMonth: { '2026-07': 10, '2026-08': 20, '2026-09': 30, '2026-11': 5 },
  topics: [{ id: 't1', label: '推理部署', count: 60, months: { '2026-07': 5, '2026-08': 10, '2026-09': 15, '2026-11': 2 } }],
  edges: [],
  conversations: { c1: { title: '一段对话', month: '2026-09', summary: '', topics: ['t1'] } },
  counts: { conversations: 65, topics: 1, edges: 0, unmappedLabels: 0 },
};

test('残缺月不进入趋势线，但数据要交代清楚', () => {
  const payload = buildPayload(baseGraph);

  assert.deepEqual(payload.months, ['2026-07', '2026-08', '2026-09'], '11 月只有 4 天，必须排除');
  assert.deepEqual(payload.topics[0].series, [5, 10, 15], 'series 要与保留的月份对齐');
  assert.deepEqual(payload.omitted, { month: '2026-11', count: 5, days: 4, daysInMonth: 30 });
});

test('整月的数据不能被误删', () => {
  const complete = { ...baseGraph, lastAt: '2026-11-29T10:00:00.000Z' };
  const payload = buildPayload(complete);

  assert.equal(payload.months.length, 4, '11 月 29 日已接近整月，应保留');
  assert.equal(payload.omitted, null);
});

test('没有时间信息时不瞎猜，原样保留', () => {
  const payload = buildPayload({ ...baseGraph, lastAt: null });
  assert.equal(payload.months.length, 4);
  assert.equal(payload.omitted, null);
});

test('峰值用真实每月对话数，不能用主题成员数之和', () => {
  // 两个主题都集中在 7 月：按成员数之和会算成 7 月最密（10），但真实对话数 8 月更多（9 > 5）
  const graph = {
    ...baseGraph,
    months: ['2026-07', '2026-08'],
    lastAt: '2026-08-28T00:00:00.000Z',
    countsByMonth: { '2026-07': 5, '2026-08': 9 },
    topics: [
      { id: 't1', label: 'A', count: 5, months: { '2026-07': 5 } },
      { id: 't2', label: 'B', count: 5, months: { '2026-07': 5 } },
    ],
  };
  const payload = buildPayload(graph);
  assert.equal(payload.totals.peakMonth, '2026-08');
  assert.equal(payload.totals.peakCount, 9);
});

test('生成的是能直接打开的完整 HTML，数据已内嵌', () => {
  const html = renderGraphHtml(baseGraph, { title: '我的主题图谱' });

  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<meta charset="utf-8">/i);
  assert.match(html, /我的主题图谱/);
  assert.match(html, /2026-11 只有 4 天/, '残缺月要在页面上说明');
  assert.match(html, /var DATA = \{"months":/, '数据要内联，不能靠外部请求');

  // 模板里不能残留未展开的占位符
  assert.doesNotMatch(html, /\$\{/, '不能有没被替换掉的模板变量');
});

test('数据里的尖括号被转义，不会提前闭合 script', () => {
  const nasty = {
    ...baseGraph,
    conversations: { c1: { title: '</script><img src=x onerror=alert(1)>', month: '2026-09', summary: '', topics: ['t1'] } },
  };
  const html = renderGraphHtml(nasty);
  assert.doesNotMatch(html, /<\/script><img/i);
});

test('没有主题时也能渲染出一个空状态页，而不是崩', () => {
  const empty = { months: [], lastAt: null, countsByMonth: {}, topics: [], edges: [], conversations: {}, counts: {} };
  const html = renderGraphHtml(empty);
  assert.match(html, /<html/i);
  assert.match(html, /var DATA/);
});
