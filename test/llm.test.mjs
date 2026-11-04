import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createLlmClient, isContextError, LlmError, withShrinkingInput } from '../lib/llm.mjs';

/**
 * 造一个假端点。
 * @param {(call: {index: number, body: any}) => object} respond 返回 chat/completions 的响应体
 */
async function startServer(respond) {
  const state = { calls: [], budgets: [] };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      state.calls.push(body);
      state.budgets.push(body.max_tokens);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(respond({ index: state.calls.length - 1, body })));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const truncated = (reasoning = '我在想…'.repeat(50)) => ({
  choices: [
    {
      finish_reason: 'length',
      message: { role: 'assistant', content: '', reasoning_content: reasoning },
    },
  ],
  usage: { completion_tokens: 100, completion_tokens_details: { reasoning_tokens: 100 } },
});

const ok = (payload) => ({
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(payload) } }],
  usage: { total_tokens: 10 },
});

test('推理模型把预算烧光时，自动加大 max_tokens 重试', async (t) => {
  const server = await startServer(({ index }) => (index === 0 ? truncated() : ok({ topics: [] })));
  t.after(() => server.close());

  const client = createLlmClient({ baseUrl: server.baseUrl, model: 'mock', apiKey: 'k' });
  const { data } = await client.json({ system: 's', user: 'u', maxTokens: 1000 });

  assert.deepEqual(data, { topics: [] });
  assert.deepEqual(server.state.budgets, [1000, 2000], '第二次请求应把预算翻倍');
});

test('一直烧光预算时，报错要说明是推理吃掉了，而不是"模型不听话"', async (t) => {
  const server = await startServer(() => truncated());
  t.after(() => server.close());

  const client = createLlmClient({ baseUrl: server.baseUrl, model: 'mock', apiKey: 'k' });

  await assert.rejects(
    () => client.json({ system: 's', user: 'u', maxTokens: 4000 }),
    (error) => {
      assert.ok(error instanceof LlmError);
      assert.equal(error.kind, 'shape');
      assert.match(error.message, /思考/);
      return true;
    },
  );

  // 4000 → 8000 → 16000 后放弃
  assert.deepEqual(server.state.budgets, [4000, 8000, 16000]);
});

test('空内容但不是 length 截断时，直接报错不重试', async (t) => {
  const server = await startServer(() => ({
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '   ' } }],
  }));
  t.after(() => server.close());

  const client = createLlmClient({ baseUrl: server.baseUrl, model: 'mock', apiKey: 'k' });
  await assert.rejects(
    () => client.json({ system: 's', user: 'u' }),
    (error) => {
      assert.match(error.message, /空内容/);
      assert.match(error.message, /finish_reason=stop/);
      return true;
    },
  );
  assert.equal(server.state.calls.length, 1, '不该无意义重试');
});

test('端点不支持 response_format 时自动降级重试', async (t) => {
  const server = await startServer(({ index }) => (index === 0 ? {} : ok({ ok: true })));
  // 第一次返回 400 需要在 handler 里做，这里换个简单办法：用自定义服务器
  await server.close();

  const bad = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      if (body.response_format) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'response_format is not supported' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(ok({ degraded: true })));
    });
  });
  await new Promise((resolve) => bad.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => bad.close(resolve)));

  const client = createLlmClient({ baseUrl: `http://127.0.0.1:${bad.address().port}/v1`, model: 'mock' });
  const { data } = await client.json({ system: 's', user: 'u' });
  assert.deepEqual(data, { degraded: true });
});

test('鉴权失败不重试，直接抛 auth', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'bad key' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const client = createLlmClient({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'mock' });
  await assert.rejects(
    () => client.json({ system: 's', user: 'u' }),
    (error) => {
      assert.equal(error.kind, 'auth');
      return true;
    },
  );
});

test('isContextError 只认"输入太长"这一种 400', () => {
  const make = (status, message) => {
    const error = new LlmError('http', message, { status });
    return error;
  };

  assert.equal(isContextError(make(400, '模型端返回 HTTP 400：maximum context length exceeded')), true);
  assert.equal(isContextError(make(400, 'This model\'s maximum context length is 128000 tokens')), true);
  assert.equal(isContextError(make(413, 'request entity too large')), true);
  assert.equal(isContextError(make(400, 'invalid response_format')), false, '别的 400 不该被当成超长');
  assert.equal(isContextError(make(401, 'context')), false, '鉴权错误不该重试');
  assert.equal(isContextError(new Error('context length')), false, '非 LlmError 不认');
});

test('输入超长时自动减半重试，直到装得下', async (t) => {
  const LIMIT = 600;
  const attempts = [];

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const user = (body.messages || []).find((m) => m.role === 'user')?.content ?? '';
      attempts.push(user.length);

      if (user.length > LIMIT) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'maximum context length exceeded' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(ok({ chars: user.length })));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const client = createLlmClient({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'mock' });
  const result = await withShrinkingInput(
    (userText) => client.json({ system: 's', user: userText }),
    (chars) => 'x'.repeat(chars),
    { maxChars: 9600, floor: 100 },
  );

  assert.equal(result.chars <= LIMIT, true, '最终输入必须装得下');
  assert.equal(result.data.chars, result.chars, 'chars 应该是实际长度而不是预算');
  assert.ok(attempts.length >= 2, '应该重试过');
  assert.deepEqual(attempts, [9600, 4800, 2400, 1200, 600], '每失败一次就减半');
});

test('非超长的错误不会触发缩减', async (t) => {
  const server = await startServer(() => ({}));
  await server.close();

  const bad = http.createServer((req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid model' } }));
  });
  await new Promise((resolve) => bad.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => bad.close(resolve)));

  const client = createLlmClient({ baseUrl: `http://127.0.0.1:${bad.address().port}/v1`, model: 'mock' });
  await assert.rejects(() =>
    withShrinkingInput((userText) => client.json({ system: 's', user: userText }), (chars) => 'x'.repeat(chars), {
      maxChars: 1000,
      floor: 100,
    }),
  );
});
