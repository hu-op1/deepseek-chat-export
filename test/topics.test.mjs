import test from 'node:test';
import assert from 'node:assert/strict';

import { extractJson } from '../lib/llm.mjs';
import {
  aggregate,
  annotationPrompt,
  buildSnippet,
  mergePrompt,
  monthOf,
  normalizeAnnotation,
  normalizeMerge,
  sessionMessages,
} from '../lib/topics.mjs';

/* ───────────────── extractJson ───────────────── */

test('extractJson：容忍围栏、前后废话、嵌套花括号', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('好的，结果如下：\n{"a":1}\n希望有帮助'), { a: 1 });
  assert.deepEqual(extractJson('{"a":{"b":[1,2]}}'), { a: { b: [1, 2] } });
  assert.deepEqual(extractJson('[1,2,3]'), [1, 2, 3]);
});

test('extractJson：字符串里的花括号不会打乱配对', () => {
  assert.deepEqual(extractJson('{"a":"}{"}'), { a: '}{' });
  assert.deepEqual(extractJson('{"a":"他说\\"好\\""}'), { a: '他说"好"' });
});

test('extractJson：前面有坏片段时跳过，找到后面那个合法的', () => {
  assert.deepEqual(extractJson('{这不是json} 但这个是：{"ok":true}'), { ok: true });
});

test('extractJson：压根没有 JSON 时返回 null，不抛错', () => {
  assert.equal(extractJson('我不知道'), null);
  assert.equal(extractJson(''), null);
  assert.equal(extractJson(null), null);
});

/* ───────────────── 会话解析与截断 ───────────────── */

const session = {
  session: { id: 's1', title: '测试对话' },
  messages: [
    { role: 'USER', fragments: [{ type: 'REQUEST', content: '帮我看看这个报错' }] },
    { role: 'ASSISTANT', fragments: [{ type: 'RESPONSE', content: '这是空指针' }, { type: 'THINK', content: '先判断是不是 null' }] },
    { role: 'USER', fragments: [{ type: 'REQUEST', content: '那怎么改' }] },
    { role: 'ASSISTANT', fragments: [{ type: 'RESPONSE', content: '加个判空' }] },
  ],
};

test('sessionMessages：正文从 fragments 里拼出来', () => {
  const messages = sessionMessages(session);
  assert.equal(messages.length, 4);
  assert.equal(messages[1].text, '这是空指针\n先判断是不是 null');
  assert.equal(messages[0].role, 'USER');
});

test('sessionMessages：空对话不产生垃圾条目', () => {
  assert.deepEqual(sessionMessages({ messages: [] }), []);
  assert.deepEqual(sessionMessages({ messages: [{ role: 'USER', fragments: [{ content: '   ' }] }] }), []);
  assert.deepEqual(sessionMessages(null), []);
});

test('buildSnippet：短对话原样返回', () => {
  const { text, truncated, fullChars } = buildSnippet(sessionMessages(session), 6000);
  assert.equal(truncated, false);
  assert.equal(text.length, fullChars);
  assert.match(text, /【我】帮我看看这个报错/);
});

test('buildSnippet：长对话保留开头、中段、结尾，且不超过预算', () => {
  const messages = Array.from({ length: 200 }, (_, i) => ({
    role: i % 2 === 0 ? 'USER' : 'ASSISTANT',
    text: `第${i}段内容，` + '填充'.repeat(20),
  }));
  const { text, truncated } = buildSnippet(messages, 2000);

  assert.equal(truncated, true);
  assert.ok(text.length <= 2100, `实际 ${text.length}`);
  assert.match(text, /第0段内容/, '要保留开头');
  assert.match(text, /第199段内容/, '要保留结尾');
  assert.match(text, /中间省略/);
});

test('buildSnippet：单条超长消息也能截出内容，不会返回空串', () => {
  const { text } = buildSnippet([{ role: 'USER', text: '很长的内容'.repeat(5000) }], 300);
  assert.ok(text.length > 200);
  assert.ok(text.length <= 400);
});

/* ───────────────── 标注结果归一化 ───────────────── */

test('normalizeAnnotation：过滤脏标签、夹紧权重、去重、限制数量', () => {
  const out = normalizeAnnotation({
    topics: [
      { label: '推理部署', weight: 0.9 },
      { label: '  推理部署  ', weight: 0.5 }, // 重复
      { label: '', weight: 0.3 }, // 空
      { label: 'x'.repeat(30) }, // 过长
      { label: 'vLLM调优', weight: 5 }, // 越界 → 夹到 1
      { label: '显存优化', weight: -1 }, // 越界 → 夹到 0.05
      { label: 'a' },
      { label: 'b' },
      { label: 'c' },
      { label: 'd' },
    ],
    entities: [{ name: 'vLLM', type: 'technology' }, { name: 'vLLM' }, { name: '' }],
    summary: '  聊了推理部署的显存问题  '.repeat(3),
  });

  assert.equal(out.topics[0].label, '推理部署');
  assert.equal(out.topics.length, 6, '最多 6 个');
  assert.equal(out.topics.find((t) => t.label === 'vLLM调优').weight, 1);
  assert.equal(out.topics.find((t) => t.label === '显存优化').weight, 0.05);
  assert.equal(out.entities.length, 1, '实体去重');
  assert.ok(out.summary.length <= 120);
});

test('normalizeAnnotation：模型胡来时返回空结构而不是崩', () => {
  assert.deepEqual(normalizeAnnotation(null), { topics: [], entities: [], summary: '' });
  assert.deepEqual(normalizeAnnotation({ topics: '不是数组' }), { topics: [], entities: [], summary: '' });
  assert.deepEqual(normalizeAnnotation({ topics: [null, 42] }).topics, []);
});

/* ───────────────── 归并 ───────────────── */

test('normalizeMerge：只保留已知标签，漏掉的归"其他"', () => {
  const known = ['代码', '编程', '写程序', '摩托车上牌', '显卡'];
  const { topics, missing } = normalizeMerge(
    {
      topics: [
        { id: 't1', label: '编程开发', aliases: ['代码', '编程', '写程序', '不存在的标签'] },
        { id: 't2', label: '汽车摩托', aliases: ['摩托车上牌'] },
      ],
    },
    known,
  );

  assert.equal(topics.length, 3);
  assert.deepEqual(topics[0].aliases, ['代码', '编程', '写程序'], '虚构标签要被丢掉');
  const other = topics.find((t) => t.label === '其他');
  assert.deepEqual(other.aliases, ['显卡'], '没被覆盖的标签必须收进"其他"，不能丢');
  assert.deepEqual(missing, ['显卡']);
});

test('normalizeMerge：规范名本身是原始标签时也能对上', () => {
  const { topics } = normalizeMerge({ topics: [{ id: 't1', label: '显卡', aliases: [] }] }, ['显卡']);
  assert.deepEqual(topics[0].aliases, ['显卡']);
});

/* ───────────────── 聚合 ───────────────── */

const canonical = {
  topics: [
    { id: 't1', label: '推理部署', aliases: ['vLLM', '显存优化'] },
    { id: 't2', label: '汽车摩托', aliases: ['摩托车上牌'] },
    { id: 't3', label: '编程开发', aliases: ['Git'] },
  ],
};

const record = (id, month, labels, summary = '') => ({
  id,
  title: `对话${id}`,
  month,
  summary,
  topics: labels.map((label) => ({ label, weight: 1 })),
});

test('aggregate：主题计数、月份分布、共现边', () => {
  const graph = aggregate({
    canonical,
    records: [
      record('a', '2026-07', ['vLLM', 'Git']),
      record('b', '2026-08', ['vLLM', '显存优化']), // 与 a 同一主题
      record('c', '2026-08', ['摩托车上牌']),
    ],
  });

  const byLabel = Object.fromEntries(graph.topics.map((t) => [t.label, t]));
  assert.equal(byLabel['推理部署'].count, 2, 'vLLM 与 显存优化 应合并到同一主题');
  assert.deepEqual(byLabel['推理部署'].months, { '2026-07': 1, '2026-08': 1 });
  assert.equal(byLabel['推理部署'].first, '2026-07');
  assert.equal(byLabel['推理部署'].last, '2026-08');

  assert.equal(graph.counts.conversations, 3);
  assert.deepEqual(graph.months, ['2026-07', '2026-08']);

  const edge = graph.edges.find((e) => (e.a === 't1' && e.b === 't3') || (e.a === 't3' && e.b === 't1'));
  assert.equal(edge.weight, 1, '同一对话里的两个主题产生一条共现边');

  assert.deepEqual(graph.byMonth['2026-08'], { t1: 1, t2: 1 });
  assert.equal(graph.conversations.a.topics.length, 2);
});

test('aggregate：未知标签被记录而不是静默吞掉', () => {
  const graph = aggregate({
    canonical,
    records: [record('a', '2026-07', ['vLLM']), record('b', '2026-07', ['模型没见过的标签'])],
  });

  assert.equal(graph.counts.unmappedLabels, 1, '统计的是未知标签的"种数"，不是出现次数');
  assert.deepEqual(graph.unmapped[0], { label: '模型没见过的标签', count: 1 });
  assert.equal(graph.counts.conversations, 1, '全是未知标签的对话进不了图');
});

test('aggregate：共现边按权重截断，避免蜘蛛网', () => {
  const records = [];
  for (let i = 0; i < 10; i += 1) records.push(record(`x${i}`, '2026-07', ['vLLM', 'Git', '摩托车上牌']));

  const graph = aggregate({ canonical, records, maxEdges: 2 });
  assert.equal(graph.edges.length, 2);
  assert.equal(graph.edges[0].weight, 10, '最强的边要保留');
});

test('monthOf：毫秒转 YYYY-MM，非法值返回 null', () => {
  assert.equal(monthOf(Date.UTC(2026, 6, 20)), '2026-07');
  assert.equal(monthOf(null), null);
  assert.equal(monthOf(0), null);
});

/* ───────────────── 提示词 ───────────────── */

test('提示词包含关键约束（防止模型自由发挥）', () => {
  const annotate = annotationPrompt({ title: '标题', month: '2026-07', snippet: '内容', truncated: true });
  assert.match(annotate, /topics/);
  assert.match(annotate, /截断/);
  assert.match(annotate, /不要编造/);

  const merge = mergePrompt([{ label: '代码', count: 12 }], 30);
  assert.match(merge, /代码\t12/);
  assert.match(merge, /30/);
  assert.match(merge, /一个都不能丢/);
});
