import test from 'node:test';
import assert from 'node:assert/strict';

import {
  authErrorOf,
  extractMessages,
  extractSessions,
  findArray,
  isSuccess,
  looksLikeMessage,
  looksLikeSession,
  readHasMore,
  summarizeSession,
  toMillis,
} from '../lib/extract.mjs';

const listPayload = {
  code: 0,
  msg: '',
  data: {
    biz_code: 0,
    biz_msg: '',
    biz_data: {
      chat_sessions: [
        { id: 's1', title: '第一个对话', updated_at: 1700000000, seq_id: 7 },
        { id: 's2', title: '第二个对话', updated_at: 1700000100, seq_id: 6 },
      ],
      has_more: true,
    },
  },
};

const messagePayload = {
  code: 0,
  msg: '',
  data: {
    biz_code: 0,
    biz_data: {
      chat_messages: [
        { message_id: 'm1', role: 'USER', content: '你好' },
        { message_id: 'm2', role: 'ASSISTANT', content: '你好呀' },
      ],
    },
  },
};

test('识别成功/鉴权失败', () => {
  assert.equal(isSuccess(listPayload), true);
  assert.equal(isSuccess({ code: 40003, data: null }), false);
  assert.deepEqual(authErrorOf({ code: 40003, msg: 'INVALID_TOKEN' }), { code: 40003, message: 'INVALID_TOKEN' });
  assert.equal(authErrorOf({ code: 0 }), null);
  assert.equal(authErrorOf({ code: 12345 }), null);
});

test('已知路径优先：会话列表', () => {
  const { sessions, hasMore, path } = extractSessions(listPayload);
  assert.equal(sessions.length, 2);
  assert.equal(hasMore, true);
  assert.match(path, /已知路径/);
});

test('结构改版时靠形状识别仍能找到会话数组', () => {
  const mutated = { code: 0, data: { payload: { rows: [{ id: 'x1', title: '改版后的对话' }] } } };
  const { sessions, path } = extractSessions(mutated);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 'x1');
  assert.match(path, /形状识别/);
});

test('找不到会话时返回空数组而不是抛错', () => {
  const { sessions, hasMore } = extractSessions({ code: 0, data: {} });
  assert.deepEqual(sessions, []);
  assert.equal(hasMore, false);
  assert.deepEqual(extractSessions(null).sessions, []);
});

test('消息提取：已知路径与形状识别', () => {
  assert.equal(extractMessages(messagePayload).messages.length, 2);
  const mutated = { data: { whatever: [{ role: 'USER', content: 'hi' }, { role: 'ASSISTANT', content: 'yo' }] } };
  const { messages, path } = extractMessages(mutated);
  assert.equal(messages.length, 2);
  assert.match(path, /形状识别/);
  assert.deepEqual(extractMessages({ code: 0 }).messages, []);
});

test('会话与消息的形状判据不会互相误判', () => {
  assert.equal(looksLikeSession({ id: 'a', title: 't' }), true);
  assert.equal(looksLikeSession({ id: 'a', role: 'USER' }), false, '带 role 的是消息');
  assert.equal(looksLikeSession({ title: '没有 id' }), false);
  assert.equal(looksLikeMessage({ role: 'USER' }), true);
  assert.equal(looksLikeMessage({ message_id: 'm' }), true);
  assert.equal(looksLikeMessage({ title: 't' }), false);
});

test('has_more 在多层结构里都能读到', () => {
  assert.equal(readHasMore({ data: { biz_data: { has_more: true } } }), true);
  assert.equal(readHasMore({ data: { has_more: 0 } }), false);
  assert.equal(readHasMore({}), false);
});

test('时间戳兼容秒/毫秒/ISO 字符串', () => {
  assert.equal(toMillis(1700000000), 1700000000000);
  assert.equal(toMillis(1700000000000), 1700000000000);
  assert.equal(toMillis('1700000000'), 1700000000000);
  assert.equal(toMillis('2024-01-01T00:00:00Z'), Date.parse('2024-01-01T00:00:00Z'));
  assert.equal(toMillis(null), null);
  assert.equal(toMillis(''), null);
  assert.equal(toMillis('不是时间'), null);
});

test('会话字段归一化', () => {
  const summary = summarizeSession(listPayload.data.biz_data.chat_sessions[0]);
  assert.equal(summary.id, 's1');
  assert.equal(summary.title, '第一个对话');
  assert.equal(summary.updated_at, 1700000000);
  assert.equal(summary.updated_ms, 1700000000000);
  assert.equal(summary.message_count, null);

  const withCount = summarizeSession({ id: 42, title: '数字 id', message_count: 5 });
  assert.equal(withCount.id, '42');
  assert.equal(withCount.message_count, 5);
});

test('findArray 不会因为循环引用而死循环', () => {
  const cyclic = { a: {} };
  cyclic.a.self = cyclic;
  assert.equal(findArray(cyclic, () => true), null);
});
