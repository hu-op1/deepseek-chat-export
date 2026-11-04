import test from 'node:test';
import assert from 'node:assert/strict';

import { cursorOf, listAllSessions, MAX_PAGE_SIZE } from '../lib/api.mjs';

/** 造一个假客户端，记录每次请求的 query，并按脚本返回数据。 */
function fakeClient(pages) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async listPage({ query }) {
      calls.push(query);
      const page = pages[Math.min(index, pages.length - 1)];
      index += 1;
      return {
        code: 0,
        data: { biz_code: 0, biz_data: { chat_sessions: page.sessions, has_more: page.hasMore } },
      };
    },
  };
}

const session = (id, updatedAt, pinned = false) => ({ id, title: id, updated_at: updatedAt, pinned });

test('游标：秒保持秒，毫秒自动换算成秒', () => {
  assert.deepEqual(cursorOf({ updated_at: 1700000000.5, pinned: false }), {
    'lte_cursor.updated_at': 1700000000.5,
    'lte_cursor.pinned': false,
  });
  // 毫秒（服务端会 400，必须换算）
  assert.deepEqual(cursorOf({ updated_at: 1700000000500, pinned: true }), {
    'lte_cursor.updated_at': 1700000000.5,
    'lte_cursor.pinned': true,
  });
  // pinned 缺省视为 false，但必须显式带上
  assert.deepEqual(cursorOf({ updated_at: 1700000000 }), {
    'lte_cursor.updated_at': 1700000000,
    'lte_cursor.pinned': false,
  });
});

test('游标：推不出来时返回 null，绝不返回半个游标', () => {
  assert.equal(cursorOf({}), null);
  assert.equal(cursorOf({ updated_at: null }), null);
  assert.equal(cursorOf({ updated_at: '不是时间' }), null);
  assert.equal(cursorOf({ updated_at: 0 }), null);
});

test('每页条数超过 100 会被压回上限并给出说明', async () => {
  const client = fakeClient([{ sessions: [session('a', 100)], hasMore: false }]);
  const result = await listAllSessions(client, { count: 500, delayMs: 0 });

  assert.equal(client.calls[0].count, MAX_PAGE_SIZE);
  assert.ok(result.notes.some((note) => note.includes('最多')));
  assert.equal(result.complete, true);
});

test('一直翻页直到 has_more 为假，游标逐页推进', async () => {
  const client = fakeClient([
    { sessions: [session('a', 300), session('b', 200)], hasMore: true },
    { sessions: [session('b', 200), session('c', 100)], hasMore: false },
  ]);
  const result = await listAllSessions(client, { count: 2, delayMs: 0 });

  assert.deepEqual(result.sessions.map((s) => s.id), ['a', 'b', 'c'], '闭区间重复的 b 要去重');
  assert.equal(result.pages, 2);
  assert.equal(result.complete, true);
  assert.equal(client.calls[1]['lte_cursor.updated_at'], 200);
});

test('游标没有推进时报错停止，而不是死循环', async () => {
  // 服务端不认游标，永远返回同一页
  const client = fakeClient([
    { sessions: [session('a', 300), session('b', 200)], hasMore: true },
    { sessions: [session('a', 300), session('b', 200)], hasMore: true },
  ]);
  const result = await listAllSessions(client, { count: 2, delayMs: 0 });

  assert.equal(result.complete, false);
  assert.equal(result.pages, 2, '发现没有新数据就立刻停');
  assert.ok(result.notes.some((note) => note.includes('没有新数据')));
});

test('has_more 永远为真但返回空页时不会无限循环', async () => {
  const client = fakeClient([{ sessions: [], hasMore: true }]);
  const result = await listAllSessions(client, { count: 2, delayMs: 0 });
  assert.equal(result.complete, false);
  assert.equal(result.pages, 1);
});

test('翻页页数上限生效', async () => {
  const pages = Array.from({ length: 10 }, (_, i) => ({
    sessions: [session(`s${i}`, 1000 - i)],
    hasMore: true,
  }));
  const client = fakeClient(pages);
  const result = await listAllSessions(client, { count: 1, delayMs: 0, maxPages: 3 });

  assert.equal(result.pages, 3);
  assert.equal(result.complete, false);
  assert.ok(result.notes.some((note) => note.includes('上限')));
});
