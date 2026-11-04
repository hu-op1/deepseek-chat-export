#!/usr/bin/env node
/**
 * DeepSeek 网页端对话全量备份。
 *
 *   node export.mjs --self-test        不登录也能跑，先确认接口还在
 *   node export.mjs --limit 3          先抓 3 个试试
 *   node export.mjs                    全量（重复跑只抓新增/有变化的）
 */

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import process from 'node:process';

import { resolveToken, saveToken } from './lib/auth.mjs';
import { ApiError, createCurlClient, createTokenClient, listAllSessions, probeEndpoints } from './lib/api.mjs';
import { extractMessages, summarizeSession } from './lib/extract.mjs';
import { loadIndex, planSync, removeStaleFile, saveIndex, writeSessionFile } from './lib/store.mjs';
import { clip, createGate, formatSize, formatTime, oneLine, pool } from './lib/util.mjs';

const USAGE = `
DeepSeek 网页端对话全量备份

用法：
  node export.mjs [选项]

选项：
  --self-test          只探测接口是否存活（不需要登录）
  --limit <n>          只处理最近 n 个对话
  --dry-run            只列清单，不抓消息内容
  --full               忽略增量状态，全部重抓
  --out <dir>          输出目录（默认 ./data）
  --token <token>      直接指定 token（默认交互粘贴，并缓存到 data/.token）
  --from-curl <文件>   cURL 重放模式；用 - 表示从标准输入读
  --concurrency <n>    并发数（默认 3）
  --delay <ms>         每次请求之间的额外间隔（默认 300）
  --count <n>          每页条数（默认 100）
  --base-url <url>     调试用：改为访问指定服务地址（默认官方域名）
  --no-prompt          无 token 时直接失败，不弹交互（适合脚本调用）
  --no-save-token      不把 token 写进 data/.token
  --debug              把原始响应转储到 data/_debug/
  -h, --help           显示本帮助

退出码：
  0 成功   1 有失败项   2 登录凭证问题   3 列表可能没抓全
`;

export function parseArgs(argv) {
  const options = {
    out: 'data',
    concurrency: 3,
    delay: 300,
    count: 100,
    limit: 0,
    baseUrl: null,
    full: false,
    dryRun: false,
    selfTest: false,
    help: false,
    debug: false,
    noPrompt: false,
    saveToken: true,
    token: null,
    fromCurl: null,
  };

  const needValue = new Set([
    'out',
    'concurrency',
    'delay',
    'count',
    'limit',
    'token',
    'from-curl',
    'base-url',
  ]);

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('-')) continue;

    const [flag, inlineValue] = raw.includes('=') ? [raw.slice(0, raw.indexOf('=')), raw.slice(raw.indexOf('=') + 1)] : [raw, null];
    const value = inlineValue ?? (needValue.has(flag.slice(2)) ? argv[(i += 1)] : null);

    switch (flag) {
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '--self-test':
        options.selfTest = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--full':
        options.full = true;
        break;
      case '--debug':
        options.debug = true;
        break;
      case '--no-prompt':
        options.noPrompt = true;
        break;
      case '--no-save-token':
        options.saveToken = false;
        break;
      case '--out':
        options.out = value;
        break;
      case '--token':
        options.token = value;
        break;
      case '--from-curl':
        options.fromCurl = value;
        break;
      case '--base-url':
        options.baseUrl = value;
        break;
      case '--concurrency':
        options.concurrency = Math.max(1, Number(value) || 1);
        break;
      case '--delay':
        options.delay = Math.max(0, Number(value) || 0);
        break;
      case '--count':
        options.count = Math.max(1, Number(value) || 100);
        break;
      case '--limit':
        options.limit = Math.max(0, Number(value) || 0);
        break;
      default:
        throw new Error(`不认识的选项：${flag}（用 --help 看用法）`);
    }
  }

  return options;
}

const log = (message = '') => console.log(message);

function pad(text, width) {
  const value = String(text ?? '');
  // 中文按 2 列宽度估算，保证表格对齐
  const visual = [...value].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return value + ' '.repeat(Math.max(0, width - visual));
}

async function runSelfTest() {
  log('\n正在探测 DeepSeek 接口（不带任何登录凭证）…\n');
  const results = await probeEndpoints();

  log(`${pad('接口', 12)}${pad('状态', 10)}${pad('code', 8)}说明`);
  log('─'.repeat(72));
  for (const item of results) {
    log(
      `${pad(item.name, 12)}${pad(item.alive ? '✓ 存活' : '✗ 异常', 10)}${pad(item.code ?? '-', 8)}` +
        `${item.alive ? item.note : `${item.note}${item.msg ? ` · ${item.msg}` : ''}`}`,
    );
  }
  log('─'.repeat(72));

  const critical = results.filter((item) => item.required !== false);
  const dead = critical.filter((item) => !item.alive);

  if (dead.length === 0) {
    log('\n结论：列表与消息接口都在线，可以开始导出。');
    log('下一步：node export.mjs --limit 3   （先抓 3 个看看效果）\n');
    return 0;
  }

  log('\n结论：有接口不可用。');
  log('这通常意味着接口改版，可以改用 cURL 重放模式继续导出：');
  log('  1) 浏览器打开 chat.deepseek.com，F12 → Network');
  log('  2) 刷新页面，找到 chat_session/fetch_page 那条请求');
  log('  3) 右键 → Copy → Copy as cURL，粘贴到一个文本文件 request.txt');
  log('  4) node export.mjs --from-curl request.txt\n');
  return 1;
}

async function readCurlSource(source) {
  if (source === '-') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  }
  const absolute = path.resolve(source);
  if (!fs.existsSync(absolute)) throw new Error(`找不到 cURL 文件：${absolute}`);
  return fs.readFileSync(absolute, 'utf8');
}

function explainAuthFailure() {
  log('\n登录凭证失效了。请重新获取一次：');
  log('  1) 浏览器打开 https://chat.deepseek.com 并确认已登录');
  log('  2) F12 → Console，粘贴执行： copy(JSON.stringify(localStorage))');
  log('  3) 回到这里重跑，并按提示粘贴');
  log('已经抓下来的对话不会被删除，重新跑会自动接着抓。');
  log('\n如果反复提示失效（可能是登录方式变了），改用 cURL 重放模式绕开 token：');
  log('  F12 → Network → 刷新 → 右键 chat_session/fetch_page → Copy as cURL');
  log('  存成 request.txt，然后： node export.mjs --from-curl request.txt\n');
}

async function buildClient(options, dataDir, gate) {
  const clientOptions = {
    delayMs: options.delay,
    gate,
    timeoutMs: 30000,
    debugDir: options.debug ? path.join(dataDir, '_debug') : null,
    log,
  };

  if (options.fromCurl) {
    const text = await readCurlSource(options.fromCurl);
    const client = createCurlClient(text, clientOptions);
    log(`客户端：${client.describe()}`);
    return client;
  }

  const tokenFile = path.join(dataDir, '.token');
  const resolved = await resolveToken({
    flagToken: options.token,
    tokenFile,
    allowPrompt: !options.noPrompt,
    log,
  });

  if (!resolved) throw new ApiError('auth', '没有可用的 token（已指定 --no-prompt）', {});

  log(`客户端：token 模式（来源：${resolved.source}）`);

  if (options.saveToken && resolved.source === '手工粘贴') {
    try {
      saveToken(tokenFile, resolved.token);
      log(`token 已缓存到 ${tokenFile}（下次不用再粘贴；删掉这个文件即可作废）`);
    } catch (error) {
      log(`! token 缓存失败：${oneLine(error)}`);
    }
  }

  return createTokenClient({ token: resolved.token, baseUrl: options.baseUrl ?? undefined, ...clientOptions });
}

/** 先用一页最小请求验证 token 是否可用。 */
async function validateClient(client) {
  await client.listPage({ query: { count: 1 } });
}

function sortSummaries(rawSessions) {
  return rawSessions
    .map((raw) => ({ raw, summary: summarizeSession(raw) }))
    .filter((item) => item.summary.id)
    .sort((a, b) => (b.summary.updated_ms ?? 0) - (a.summary.updated_ms ?? 0));
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);

  if (options.help) {
    log(USAGE);
    return 0;
  }
  if (options.selfTest) {
    return runSelfTest();
  }

  const dataDir = path.resolve(options.out);
  fs.mkdirSync(path.join(dataDir, 'sessions'), { recursive: true });

  log(`\n输出目录：${dataDir}`);
  log(`模式：${options.dryRun ? '只看清单（--dry-run）' : options.full ? '全量重抓（--full）' : '增量同步'}`);

  const client = await buildClient(options, dataDir, createGate({ gapMs: options.delay, maxGapMs: 4000 }));

  // 1) 先确认能读到数据，避免翻页翻到一半才发现 token 不对
  try {
    await validateClient(client);
  } catch (error) {
    if (error instanceof ApiError && error.kind === 'auth') {
      explainAuthFailure();
      return 2;
    }
    throw error;
  }

  // 2) 拉会话列表
  log('\n正在获取对话列表…');
  let listing;
  try {
    listing = await listAllSessions(client, {
      count: options.count,
      delayMs: options.delay,
      log: (message) => log(message),
    });
  } catch (error) {
    if (error instanceof ApiError && error.kind === 'auth') {
      explainAuthFailure();
      return 2;
    }
    if (error instanceof ApiError && error.kind === 'gone') {
      log(`\n! ${error.message}`);
      log(`  ${error.hint ?? ''}\n`);
      return 1;
    }
    throw error;
  }

  const index = loadIndex(dataDir);
  index.pagination = { pages: listing.pages };
  index.complete = listing.complete;

  const ordered = sortSummaries(listing.sessions);
  const totalOnServer = ordered.length;
  const scoped = options.limit > 0 ? ordered.slice(0, options.limit) : ordered;

  log(`\n共发现 ${totalOnServer} 个对话${options.limit > 0 ? `，本次只处理最近 ${scoped.length} 个` : ''}`);
  if (listing.notes.length) {
    for (const note of listing.notes) log(`  · ${note}`);
  }
  if (!listing.complete) {
    log('  ! 列表可能没抓全（分页参数未被接受）。已抓到的部分仍然有效。');
  }

  const rawById = new Map(scoped.map((item) => [item.summary.id, item.raw]));

  // 差异要按"服务端全量列表"算，否则 --limit 会把没处理的对话误判成"已从网页端消失"
  const plan = planSync(
    ordered.map((item) => item.raw),
    index,
    { full: options.full },
  );
  const scopedIds = new Set(scoped.map((item) => item.summary.id));
  const toFetch = plan.toFetch.filter((item) => scopedIds.has(item.summary.id));
  const unchanged = plan.unchanged.filter((item) => scopedIds.has(item.summary.id));
  const goneFromRemote = plan.goneFromRemote;

  log(`待抓取 ${toFetch.length} 个，跳过 ${unchanged.length} 个（本地已是最新）`);
  if (goneFromRemote.length) {
    log(`提示：本地有 ${goneFromRemote.length} 个对话已不在网页端列表中（本地文件保留不动）`);
  }

  if (options.dryRun) {
    log('\n清单：');
    for (const item of toFetch) {
      log(`  [${item.reason}] ${formatTime(item.summary.updated_ms)}  ${clip(item.summary.title, 38)}  (${item.summary.id})`);
    }
    if (!toFetch.length) log('  （没有需要抓的）');
    saveIndex(dataDir, index);
    log('\n--dry-run：未下载任何消息内容。');
    return 0;
  }

  if (!toFetch.length) {
    saveIndex(dataDir, index);
    log('\n本地已是最新，没有需要抓取的内容。');
    return listing.complete ? 0 : 3;
  }

  // 3) 逐个抓消息
  log('');
  const failures = [];
  const countMismatch = [];
  let done = 0;
  let savedBytes = 0;

  await pool(toFetch, options.concurrency, async ({ summary, reason }) => {
    try {
      const payload = await client.getMessages(summary.id);
      const { messages } = extractMessages(payload);
      const previous = index.sessions[summary.id];

      // 完整性提示：服务端声称的消息数与实际拿到的对不上，说明可能被分页截断了
      if (summary.message_count != null && messages.length !== summary.message_count) {
        countMismatch.push({ title: summary.title, expected: summary.message_count, got: messages.length });
      }

      // 安全闸：空消息不许覆盖已有备份
      if (messages.length === 0) {
        if (previous && previous.message_count > 0) {
          throw new Error(`接口返回 0 条消息，与已有备份（${previous.message_count} 条）冲突，已跳过以免覆盖`);
        }
        log(`  ! ${clip(summary.title, 30)}：这个对话没有消息内容`);
      }

      const entry = writeSessionFile(dataDir, summary, rawById.get(summary.id) ?? summary, messages);
      const oldFile = previous?.file;
      index.sessions[summary.id] = entry;
      saveIndex(dataDir, index);

      // 标题/日期变了会生成新文件名，顺手删掉旧文件
      if (oldFile && path.normalize(oldFile) !== path.normalize(entry.file)) {
        removeStaleFile(dataDir, oldFile);
      }

      done += 1;
      const size = fs.statSync(path.join(dataDir, entry.file)).size;
      savedBytes += size;
      log(
        `  [${done}/${toFetch.length}] ✓ ${clip(summary.title, 34)}  ${messages.length} 条 · ${formatSize(size)}（${reason}）`,
      );
    } catch (error) {
      done += 1;
      failures.push({ summary, error });
      log(`  [${done}/${toFetch.length}] ✗ ${clip(summary.title, 30)}  ${oneLine(error)}`);

      if (error instanceof ApiError && error.kind === 'auth') {
        // 凭证失效，剩下的请求注定失败，直接抛出让任务池尽快收敛
        throw error;
      }
    }
  });

  saveIndex(dataDir, index);

  // 4) 汇总
  const authFailed = failures.some((item) => item.error instanceof ApiError && item.error.kind === 'auth');
  log('\n──────── 汇总 ────────');
  log(`新增/更新：${toFetch.length - failures.length} 个，跳过：${unchanged.length} 个，失败：${failures.length} 个`);
  log(`本次写入：${formatSize(savedBytes)}`);
  log(`备份目录：${path.join(dataDir, 'sessions')}`);

  if (!listing.complete) {
    log('\n! 警告：会话列表可能不完整（翻页提前停止了）。');
    log('  已抓到的不受影响，但可能漏掉更早的对话。');
    log('  可以重跑一次，或用 --from-curl 重放浏览器里那条 fetch_page 请求。');
  }

  if (countMismatch.length) {
    log(`\n提示：${countMismatch.length} 个对话拿到的消息条数与网页端声称的数量不一致（可能被服务端分页截断了）：`);
    for (const item of countMismatch.slice(0, 5)) {
      log(`  · ${clip(item.title, 30)}：应有 ${item.expected} 条，实际 ${item.got} 条`);
    }
    if (countMismatch.length > 5) log(`  …还有 ${countMismatch.length - 5} 个`);
  }

  if (failures.length) {
    const rateLimited = failures.filter(
      (item) => item.error instanceof ApiError && item.error.kind === 'rate-limit',
    ).length;

    log('\n失败清单（重跑会自动重试这些）：');
    for (const item of failures.slice(0, 20)) {
      log(`  · ${clip(item.summary.title, 34)}（${item.summary.id}）：${oneLine(item.error)}`);
    }
    if (failures.length > 20) log(`  …还有 ${failures.length - 20} 个`);

    if (rateLimited) {
      log(`\n其中 ${rateLimited} 个是被服务端限流（TOO_MANY_REQUESTS），不是数据问题。`);
      log('  放慢一点重跑就能补上： node export.mjs --delay 800 --concurrency 2');
    }
  }

  if (authFailed) {
    explainAuthFailure();
    return 2;
  }

  log('');
  return failures.length ? 1 : listing.complete ? 0 : 3;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main()
    .then((code) => {
      process.exitCode = code ?? 0;
    })
    .catch((error) => {
      console.error(`\n出错了：${oneLine(error)}`);
      if (error instanceof ApiError && error.hint) console.error(`提示：${error.hint}`);
      process.exitCode = 1;
    });
}
