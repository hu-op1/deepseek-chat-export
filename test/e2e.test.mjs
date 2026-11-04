/**
 * 端到端测试：起一个本地假服务器，模拟 DeepSeek 的接口形状，
 * 验证「翻页 → 抓消息 → 落盘 → 再跑一次全部跳过」这条主链路。
 *
 * 不需要真 token，也不访问外网。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { ApiError, createTokenClient, listAllSessions } from '../lib/api.mjs';
import { extractMessages } from '../lib/extract.mjs';
import { emptyIndex, loadIndex, planSync, saveIndex, writeSessionFile } from '../lib/store.mjs';
import { createGate } from '../lib/util.mjs';

const SESSIONS = [
  { id: 'aaaaaaaa-1111', title: '关于人生的意义', updated_at: 1700000300, seq_id: 3 },
  { id: 'bbbbbbbb-2222', title: '帮我写个爬虫', updated_at: 1700000200, seq_id: 2 },
  { id: 'cccccccc-3333', title: '今天好难过', updated_at: 1700000100, seq_id: 1 },
];

const MESSAGES = {
  'aaaaaaaa-1111': [
    { message_id: 'm1', role: 'USER', content: '人活着有什么意义？', inserted_at: 1700000290 },
    { message_id: 'm2', role: 'ASSISTANT', content: '这个问题没有标准答案……', thinking_content: '需要共情', inserted_at: 1700000300 },
  ],
  'bbbbbbbb-2222': [{ message_id: 'm3', role: 'USER', content: '帮我写个爬虫' }],
  'cccccccc-3333': [{ message_id: 'm4', role: 'USER', content: '今天好难过' }],
};

/** 起一个行为可控的假 DeepSeek。 */
async function startFakeServer({ authMode = 'ok', rateLimitFirst = 0 } = {}) {
  const state = { requests: [], rateLimited: 0 };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    state.requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization });

    const sendJson = (body) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };

    if (authMode === 'html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><title>DeepSeek</title></html>');
      return;
    }
    if (authMode === 'expired' || req.headers.authorization !== 'Bearer good-token') {
      sendJson({ code: 40003, msg: 'INVALID_TOKEN', data: null });
      return;
    }

    if (url.pathname === '/api/v0/chat_session/fetch_page') {
      // 忠实复刻真实服务端的游标语义：
      //   - count 上限 100
      //   - 必须带 lte_cursor.pinned，否则游标被忽略（永远返回第一页）
      //   - lte_cursor.updated_at 是秒，闭区间
      const count = Math.min(Number(url.searchParams.get('count') ?? 100), 100);
      const cursorRaw = url.searchParams.get('lte_cursor.updated_at');
      const cursorPinned = url.searchParams.get('lte_cursor.pinned');

      let pool = SESSIONS.slice().sort((a, b) => b.updated_at - a.updated_at);
      if (cursorRaw !== null && cursorPinned !== null) {
        const cursor = Number(cursorRaw);
        pool = pool.filter((item) => item.updated_at <= cursor);
      }

      sendJson({
        code: 0,
        msg: '',
        data: {
          biz_code: 0,
          biz_msg: '',
          biz_data: { chat_sessions: pool.slice(0, count), has_more: pool.length > count },
        },
      });
      return;
    }

    if (url.pathname === '/api/v0/chat/history_messages') {
      // 前 N 次回业务层限流：HTTP 200 + code 40029（真实服务端就是这么干的）
      if (state.rateLimited < rateLimitFirst) {
        state.rateLimited += 1;
        sendJson({ code: 40029, msg: 'TOO_MANY_REQUESTS', data: null });
        return;
      }
      const id = url.searchParams.get('chat_session_id');
      sendJson({
        code: 0,
        msg: '',
        data: { biz_code: 0, biz_msg: '', biz_data: { chat_messages: MESSAGES[id] ?? [] } },
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 404, msg: 'NOT_FOUND' }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    baseUrl,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('主链路：翻页 → 抓消息 → 落盘 → 二次运行全部跳过', async (t) => {
  const fake = await startFakeServer();
  t.after(() => fake.close());

  const client = createTokenClient({ token: 'good-token', baseUrl: fake.baseUrl, retries: 0, delayMs: 0 });

  // ---- 1) 列表：三页游标翻页，必须一条不漏
  const listing = await listAllSessions(client, { count: 2, delayMs: 0, log: () => {} });
  assert.equal(listing.sessions.length, 3, '三个对话都要拿到');
  assert.equal(listing.complete, true, '要能判定列表已抓全');
  assert.equal(listing.pages, 2, '每页 2 条，3 个对话应该翻 2 页');

  // 第二页的请求必须真的带上了游标，而不是又请求了一遍第一页
  const pageRequests = fake.state.requests.filter((r) => r.path === '/api/v0/chat_session/fetch_page');
  assert.equal(pageRequests.length, 2);
  assert.equal(pageRequests[1].query['lte_cursor.updated_at'], '1700000200', '游标是秒，且取上一页末条');
  assert.equal(pageRequests[1].query['lte_cursor.pinned'], 'false');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-e2e-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  // ---- 2) 抓消息并落盘
  const index = emptyIndex();
  for (const raw of listing.sessions) {
    const payload = await client.getMessages(raw.id);
    const { messages } = extractMessages(payload);
    assert.ok(messages.length > 0, `${raw.id} 应该有消息`);

    const summary = { id: raw.id, title: raw.title, updated_at: raw.updated_at, updated_ms: raw.updated_at * 1000 };
    index.sessions[raw.id] = writeSessionFile(dataDir, summary, raw, messages);
  }
  saveIndex(dataDir, index);

  assert.equal(fs.readdirSync(path.join(dataDir, 'sessions')).length, 3);

  // 原始字段必须保留（thinking_content 这类以后才用得上的信息不能丢）
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, index.sessions['aaaaaaaa-1111'].file), 'utf8'));
  assert.equal(saved.schema, 1);
  assert.equal(saved.session.title, '关于人生的意义');
  assert.equal(saved.messages[1].thinking_content, '需要共情');
  assert.equal(saved.messages[1].content, '这个问题没有标准答案……');

  // ---- 3) 再跑一次：应全部跳过（增量幂等）
  const reloaded = loadIndex(dataDir);
  const plan = planSync(listing.sessions, reloaded);
  assert.equal(plan.toFetch.length, 0, '第二次运行不应重复请求');
  assert.equal(plan.unchanged.length, 3);
  assert.equal(plan.goneFromRemote.length, 0);

  // ---- 4) 某个对话有了新消息：只重抓那一个
  const mutated = listing.sessions.map((item) =>
    item.id === 'bbbbbbbb-2222' ? { ...item, updated_at: 1700009999 } : item,
  );
  const plan2 = planSync(mutated, reloaded);
  assert.equal(plan2.toFetch.length, 1);
  assert.equal(plan2.toFetch[0].summary.id, 'bbbbbbbb-2222');
});

test('token 失效时抛 auth 错误，而不是静默返回空列表', async (t) => {
  const fake = await startFakeServer({ authMode: 'expired' });
  t.after(() => fake.close());

  const client = createTokenClient({ token: 'bad-token', baseUrl: fake.baseUrl, retries: 0 });
  await assert.rejects(() => client.listPage({ query: { count: 1 } }), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.kind, 'auth');
    assert.match(error.message, /40003|凭证无效/);
    return true;
  });
});

test('接口返回网页时判定为 gone，并给出切换 cURL 模式的建议', async (t) => {
  const fake = await startFakeServer({ authMode: 'html' });
  t.after(() => fake.close());

  const client = createTokenClient({ token: 'good-token', baseUrl: fake.baseUrl, retries: 0 });
  await assert.rejects(() => client.listPage({ query: { count: 1 } }), (error) => {
    assert.equal(error.kind, 'gone');
    assert.match(error.hint, /from-curl/);
    return true;
  });
});

test('业务层限流 40029 会退避重试并最终成功，而不是判死', async (t) => {
  const fake = await startFakeServer({ rateLimitFirst: 1 });
  t.after(() => fake.close());

  const gate = createGate({ gapMs: 50, maxGapMs: 5000 });
  const client = createTokenClient({ token: 'good-token', baseUrl: fake.baseUrl, retries: 0, rateRetries: 3, gate });

  const payload = await client.getMessages('aaaaaaaa-1111');
  assert.equal(extractMessages(payload).messages.length, 2, '重试之后应该拿到正常数据');
  assert.equal(fake.state.rateLimited, 1, '确认这次限流真的发生并被重试吞掉了');
  // 成功一次后会缓慢恢复，所以此刻 gap 只是"高于基准"，还没回到 50
  assert.ok(gate.gap > 50, `被限流后节奏应自动放慢，实际 gap=${gate.gap}`);
});

test('空会话不会返回假数据', async (t) => {
  const fake = await startFakeServer();
  t.after(() => fake.close());

  const client = createTokenClient({ token: 'good-token', baseUrl: fake.baseUrl, retries: 0 });
  const payload = await client.getMessages('不存在的会话');
  assert.deepEqual(extractMessages(payload).messages, []);
});
