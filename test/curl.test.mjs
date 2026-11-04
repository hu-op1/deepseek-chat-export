import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveMessagesRequest, describeCurl, getHeader, parseCurl } from '../lib/curl.mjs';

const BASH_CURL = `curl 'https://chat.deepseek.com/api/v0/chat_session/fetch_page?count=100' \\
  -H 'accept: */*' \\
  -H 'authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123def456' \\
  -H 'cookie: intercom=abc; ds_session=xyz' \\
  -H 'referer: https://chat.deepseek.com/' \\
  --compressed`;

test('解析 bash 风格的 Copy as cURL', () => {
  const parsed = parseCurl(BASH_CURL);

  assert.equal(parsed.url, 'https://chat.deepseek.com/api/v0/chat_session/fetch_page?count=100');
  assert.equal(parsed.method, 'GET');
  assert.equal(parsed.body, null);
  assert.equal(getHeader(parsed.headers, 'authorization'), 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123def456');
  assert.equal(getHeader(parsed.headers, 'cookie'), 'intercom=abc; ds_session=xyz');
  // 没有值的开关（--compressed）不能把后面的参数吃掉
  assert.equal(parsed.headers.length, 4);
});

test('解析 cmd 风格（双引号 + 转义）', () => {
  const parsed = parseCurl(
    'curl "https://chat.deepseek.com/api/v0/chat_session/fetch_page" -H "content-type: application/json" --data-raw "{\\"count\\":100}"',
  );

  assert.equal(parsed.body, '{"count":100}');
  assert.equal(parsed.method, 'POST'); // 有 body 时默认 POST
  assert.equal(getHeader(parsed.headers, 'Content-Type'), 'application/json');
});

test('解析 powershell 风格（curl.exe）', () => {
  const parsed = parseCurl("curl.exe 'https://chat.deepseek.com/api/v0/users/current' -H 'x-client-version: 2.0.0'");
  assert.equal(parsed.url, 'https://chat.deepseek.com/api/v0/users/current');
  assert.equal(parsed.method, 'GET');
  assert.equal(getHeader(parsed.headers, 'x-client-version'), '2.0.0');
});

test('显式 -X 优先于默认推导', () => {
  const parsed = parseCurl("curl -X POST 'https://chat.deepseek.com/x' -H 'a: b'");
  assert.equal(parsed.method, 'POST');
});

test("bash 的 '\\'' 转义（请求体里带单引号）", () => {
  const parsed = parseCurl(`curl 'https://chat.deepseek.com/x' -d '{"q":"it'\\''s"}'`);
  assert.equal(parsed.body, `{"q":"it's"}`);
});

test('重复的 header 只保留最后一个', () => {
  const parsed = parseCurl("curl 'https://a.b/c' -H 'x: 1' -H 'x: 2'");
  assert.equal(getHeader(parsed.headers, 'x'), '2');
  assert.equal(parsed.headers.length, 1);
});

test('没有 URL 时抛出可理解的错误', () => {
  assert.throws(() => parseCurl("curl -H 'a: b'"), /没能从 cURL 里找到 URL/);
  assert.throws(() => parseCurl(''), /cURL 内容为空/);
});

test('从列表请求推导出取消息请求：换 path 与 query，其余头保留', () => {
  const parsed = parseCurl(BASH_CURL);
  const messages = deriveMessagesRequest(parsed, 'abc-123');

  assert.equal(messages.method, 'GET');
  assert.match(messages.url, /\/api\/v0\/chat\/history_messages\?chat_session_id=abc-123$/);
  assert.equal(getHeader(messages.headers, 'authorization'), getHeader(parsed.headers, 'authorization'));
  assert.equal(getHeader(messages.headers, 'cookie'), getHeader(parsed.headers, 'cookie'));
  assert.equal(messages.body, null);
});

test('describeCurl 用于日志', () => {
  const parsed = parseCurl(BASH_CURL);
  assert.equal(describeCurl(parsed), 'GET https://chat.deepseek.com/api/v0/chat_session/fetch_page?count=100');
});
