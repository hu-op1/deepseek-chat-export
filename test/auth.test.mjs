import test from 'node:test';
import assert from 'node:assert/strict';

import { collectTokenCandidates, findToken, isJwtLike, looksLikeToken, maskToken, scanJsonForToken } from '../lib/auth.mjs';

/**
 * 合成夹具，不是凭证。
 * header  {"alg":"HS256"}  payload {"sub":"test"}  签名段是纯字面量占位符。
 * （测试只需要"长得像 JWT"，不需要它是合法签名）
 */
const FAKE_JWT_HEADER = 'eyJhbGciOiJIUzI1NiJ9';
const FAKE_JWT_PAYLOAD = 'eyJzdWIiOiJ0ZXN0In0';
const JWT = `${FAKE_JWT_HEADER}.${FAKE_JWT_PAYLOAD}.FAKE_SIGNATURE_NOT_A_REAL_ONE`;

// 这一段就是 JSON.stringify(localStorage) 的真实形状：值本身是被转义过的 JSON 字符串
const LOCAL_STORAGE_BLOB = `{"userToken":"{\\"value\\":\\"${JWT}\\",\\"__version\\":\\"0\\"}","theme":"dark","lastActive":"1700000000000"}`;

test('从 localStorage 整段导出里嗅出 token', () => {
  assert.equal(findToken(LOCAL_STORAGE_BLOB), JWT);
});

test('直接粘贴 token 本身', () => {
  assert.equal(findToken(JWT), JWT);
  assert.equal(findToken(`"${JWT}"`), JWT);
});

test('粘贴 Authorization 头也能认', () => {
  assert.equal(findToken(`Bearer ${JWT}`), JWT);
  assert.equal(findToken(`authorization: Bearer ${JWT}`), JWT);
});

test('键名不认识时，靠形状识别', () => {
  const blob = JSON.stringify({ someWeirdKey: { nested: [{ value: JWT }] } });
  assert.equal(findToken(blob), JWT);
});

test('非 JWT 的 token 靠键名识别（键名可能改，所以也接受 token/auth 前缀）', () => {
  const token = 'abcdef1234567890abcdef1234567890';
  assert.equal(findToken(JSON.stringify({ token })), token);
  assert.equal(findToken(JSON.stringify({ authToken: token })), token);
});

test('认不出来的内容返回 null，而不是瞎猜', () => {
  assert.equal(findToken(''), null);
  assert.equal(findToken('   '), null);
  assert.equal(findToken('{"theme":"dark","lang":"zh"}'), null);
  assert.equal(findToken('hello world'), null);
  assert.equal(findToken(null), null);
});

/**
 * 回归测试：DeepSeek 的 localStorage 结构（键名/嵌套形状真实，值全部为伪造）。
 * userToken 是不透明的长串（不是 JWT），而 settingsJwt 里躺着一个货真价实的 JWT。
 * 旧实现按形状找 JWT，会错抓 settingsJwt —— 这次就栽在这上面。
 */
test('结构性回归：不透明 userToken 优先于 settingsJwt 里的诱饵 JWT', () => {
  const OPAQUE = 'fake0token0value0for0test0only0not0a0real0credential';
  const DECOY_JWT = 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..decoyDecoyDecoy.decoyDecoyDecoyDecoy';

  const blob = JSON.stringify({
    smidV2: '2020010100000000000fakesmidv2value0000000000000000000000000000',
    hif_dliq_cached: '"fakeCachedValueForTests=.fakeCachedValueForTests"',
    settingsJwt: JSON.stringify({ value: { ownerHash: '0000000000000000', jwt: DECOY_JWT }, __version: '0' }),
    __tea_cache_tokens_1: JSON.stringify({ web_id: '0000000000000000001', user_unique_id: '00000000-0000-0000-0000-000000000001' }),
    userToken: JSON.stringify({ value: OPAQUE, __version: '0' }),
    thinkingEnabled: JSON.stringify({ value: true, __version: '2' }),
  });

  assert.equal(findToken(blob), OPAQUE, '必须拿到 userToken，而不是 settingsJwt 里的 jwt');

  // 排序也要对：userToken 的 rank 必须严格优于诱饵
  const candidates = collectTokenCandidates(blob);
  assert.equal(candidates[0].value, OPAQUE);
  assert.equal(candidates[0].key, 'userToken');
  assert.ok(
    candidates.some((item) => item.value === DECOY_JWT),
    '诱饵本身仍应被收录，只是排在后面',
  );
});

test('UserToken 用驼峰以外的写法也能认（user_token / accessToken）', () => {
  const token = 'abcdef1234567890abcdef1234567890';
  assert.equal(findToken(JSON.stringify({ user_token: JSON.stringify({ value: token }) })), token);
  assert.equal(findToken(JSON.stringify({ accessToken: token })), token);
});

test('scanJsonForToken 对非法 JSON 安全返回 null', () => {
  assert.equal(scanJsonForToken('{not json'), null);
});

test('工具函数行为', () => {
  assert.equal(isJwtLike(JWT), true);
  assert.equal(isJwtLike('abc'), false);
  assert.equal(looksLikeToken('short'), false);
  assert.equal(looksLikeToken('a'.repeat(40)), true);
  assert.match(maskToken(JWT), /^eyJhbGci…/);
  assert.doesNotMatch(maskToken(JWT), new RegExp(JWT));
});
