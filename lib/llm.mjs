/**
 * OpenAI 兼容的模型客户端。
 *
 * 只做一件窄事：发 chat/completions 并拿到结构化 JSON。
 * 适配任何 OpenAI 兼容端点（DeepSeek 官方、OpenRouter、硅基流动、vLLM、Ollama…），
 * 差异全部收敛到 baseUrl / model / apiKey 三个参数。
 */

import { createGate, sleep } from './util.mjs';

export class LlmError extends Error {
  /** kind: auth | rate-limit | http | shape | network */
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'LlmError';
    this.kind = kind;
    this.status = extra.status ?? null;
  }
}

const backoff = (n) => Math.min(30000, 1000 * 2 ** n) + Math.floor(Math.random() * 400);

/** 从文本里抠出第一个能解析成功的 JSON 对象/数组，容忍围栏、前后废话、坏片段。 */
export function extractJson(text) {
  if (typeof text !== 'string') return null;
  let s = text.trim();

  // 去掉 markdown 围栏
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  // 从头逐个尝试每个 { 或 [，跳过解析失败的位置（模型常在 JSON 前写一句话）
  for (let start = 0; start < s.length; start += 1) {
    const openChar = s[start];
    if (openChar !== '{' && openChar !== '[') continue;

    const closeChar = openChar === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < s.length; i += 1) {
      const ch = s[i];

      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === openChar) depth += 1;
      else if (ch === closeChar) {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(s.slice(start, i + 1));
          } catch {
            break; // 这一段不是合法 JSON，从下一个 { 再来
          }
        }
      }
    }
  }
  return null;
}

export function createLlmClient({
  baseUrl,
  apiKey,
  model,
  gate = createGate({ gapMs: 400, maxGapMs: 8000 }),
  retries = 2,
  rateRetries = 5,
  timeoutMs = 120000,
  log,
} = {}) {
  if (!baseUrl) throw new Error('createLlmClient 需要 baseUrl');
  if (!model) throw new Error('createLlmClient 需要 model');

  const endpoint = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

  const post = async (body, label) => {
    let attempt = 0;
    let rateAttempt = 0;
    let budgetEscalations = 0;
    let budget = body.max_tokens ?? 1200;
    let jsonMode = true; // 模型不支持 response_format 时自动降级

    for (;;) {
      await gate?.wait();

      let response;
      let text = '';
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify(jsonMode ? { ...body, response_format: { type: 'json_object' } } : body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        text = await response.text();
      } catch (error) {
        if (attempt < retries) {
          const wait = backoff(attempt);
          log?.(`  ! 网络异常，${Math.round(wait / 1000)}s 后重试：${error?.message ?? error}`);
          await sleep(wait);
          attempt += 1;
          continue;
        }
        throw new LlmError('network', `请求模型失败（${label}）：${error?.message ?? error}`);
      }

      const status = response.status;

      if (status === 401 || status === 403) {
        throw new LlmError('auth', `模型端鉴权失败（HTTP ${status}），检查 --api-key`, { status });
      }

      if (status === 429 || status >= 500) {
        if (rateAttempt < rateRetries) {
          const wait = backoff(rateAttempt);
          gate?.slowDown();
          gate?.coolDown(wait);
          rateAttempt += 1;
          log?.(`  ! 模型端 HTTP ${status}，${Math.round(wait / 1000)}s 后重试`);
          await sleep(wait);
          continue;
        }
        throw new LlmError('rate-limit', `模型端限流/故障（HTTP ${status}），重试后仍失败`, { status });
      }

      if (status === 400 && jsonMode && /response_format|json_object|not support/i.test(text)) {
        // 端点不支持 JSON 模式，降级重试一次
        jsonMode = false;
        log?.('  · 该模型不支持 response_format=json_object，已降级为纯文本解析');
        continue;
      }

      if (!response.ok) {
        throw new LlmError('http', `模型端返回 HTTP ${status}：${text.slice(0, 200).replace(/\s+/g, ' ')}`, { status });
      }

      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new LlmError('shape', `模型端响应不是 JSON：${text.slice(0, 200)}`);
      }

      const choice = payload?.choices?.[0] ?? {};
      const content = choice?.message?.content;
      const finish = choice?.finish_reason;
      const reasoning = choice?.message?.reasoning_content ?? choice?.message?.reasoning ?? '';

      if (typeof content !== 'string' || !content.trim()) {
        // 推理模型会把预算全烧在思考上，正文一字不出（finish_reason=length，
        // 而 reasoning_tokens 等于 completion_tokens）。这种情况自动加预算重试，
        // 不要把它当成"模型不听话"。
        if (finish === 'length' && budgetEscalations < 3 && budget < 16000) {
          budget = Math.min(16000, budget * 2);
          budgetEscalations += 1;
          body = { ...body, max_tokens: budget };
          log?.(`  · 推理吃光了 token 预算（已用 ${reasoning.length} 字思考），自动提到 ${budget} 重试`);
          continue;
        }

        if (finish === 'length') {
          throw new LlmError(
            'shape',
            `模型把 ${budget} token 全用在思考上（${reasoning.length} 字），没有产出正文。` +
              `换一个非推理模型，或在调用处调大 max_tokens。`,
          );
        }
        throw new LlmError('shape', `模型返回了空内容（finish_reason=${finish ?? '未知'}）`);
      }

      const parsed = extractJson(content);
      if (!parsed) {
        throw new LlmError('shape', `模型输出里找不到 JSON：${content.slice(0, 200).replace(/\s+/g, ' ')}`);
      }

      return { data: parsed, usage: payload?.usage ?? null, raw: content };
    }
  };

  return {
    model,
    describe: () => `${model} @ ${endpoint}`,
    /** @returns {Promise<{data: any, usage: any, raw: string}>} */
    json: ({ system, user, maxTokens = 1200, temperature = 0 }) =>
      post(
        {
          model,
          temperature,
          max_tokens: maxTokens,
          messages: [
            ...(system ? [{ role: 'system', content: system }] : []),
            { role: 'user', content: user },
          ],
        },
        'json',
      ),
  };
}

/** 是不是"输入太长 / 超出上下文"这类错误。 */
export function isContextError(error) {
  if (!(error instanceof LlmError)) return false;
  // 413 本身就叫"Payload Too Large"，不用再看报文
  if (error.status === 413) return true;
  if (error.status !== 400) return false;
  return /context|too long|maximum|length|token/i.test(error.message);
}

/**
 * 输入超长时自动减半重试。
 *
 * 背景：把 --max-chars 调到很大（等于不截断）之后，长对话会带来两个麻烦：
 *   1. 超出模型上下文 → 接口 400/413；
 *   2. 没超但太长 → 模型开始胡来，甚至直接回"我无法给到相关内容"，输出里没有 JSON。
 * 两种都按"这段输入它消化不了"处理，减半重试。实测 48 万字的那段对话，
 * 一次成功、一次被拒，说明这个长度已经超出它的稳定工作区。
 *
 * @param {(userText: string) => Promise<any>} request 真正发请求的函数
 * @param {(chars: number) => string} makeUser 按预算生成输入文本
 */
export async function withShrinkingInput(request, makeUser, { maxChars, floor = 4000, log } = {}) {
  let chars = maxChars;
  let lastLength = 0;

  for (;;) {
    const userText = makeUser(chars);
    lastLength = userText.length;

    try {
      // chars 报告的是**实际送出的长度**，不是预算——否则调用方没法判断到底截没截断
      return { ...(await request(userText)), chars: lastLength };
    } catch (error) {
      const tooLong = isContextError(error);
      // 输入本身就很大时，模型跑题/拒答也当作"消化不了"处理
      const overwhelmed = error instanceof LlmError && error.kind === 'shape' && lastLength > 60000;

      if ((tooLong || overwhelmed) && chars > floor) {
        const next = Math.max(floor, Math.floor(Math.min(chars, lastLength) / 2));
        log?.(
          `  · ${tooLong ? '超出模型上下文' : '模型没能消化这段输入'}（${lastLength} 字），减到 ${next} 字重试`,
        );
        chars = next;
        continue;
      }
      throw error;
    }
  }
}

