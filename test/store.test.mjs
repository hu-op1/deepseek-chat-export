import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  atomicWriteJson,
  datePart,
  emptyIndex,
  hashJson,
  loadIndex,
  planSync,
  readJsonFile,
  removeStaleFile,
  sanitizeFilePart,
  saveIndex,
  sessionFileName,
  writeSessionFile,
} from '../lib/store.mjs';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ds-export-test-'));

test('文件名清洗：非法字符、结尾点号、保留设备名', () => {
  assert.equal(sanitizeFilePart('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j');
  assert.equal(sanitizeFilePart('标题...'), '标题');
  assert.equal(sanitizeFilePart('  前后空格  '), '前后空格');
  assert.equal(sanitizeFilePart('CON'), '_CON');
  assert.equal(sanitizeFilePart(''), '');
  assert.equal(sanitizeFilePart(null), '');
  assert.equal(sanitizeFilePart('换\n行'), '换 行');
  assert.ok(sanitizeFilePart('长'.repeat(200)).length <= 48);
});

test('日期与文件名', () => {
  assert.equal(datePart(Date.UTC(2024, 0, 2, 12)), '2024-01-02');
  assert.equal(datePart(null), '0000-00-00');

  const name = sessionFileName({ id: '0123456789abcdef', title: '你好/世界', updated_ms: Date.UTC(2024, 0, 2, 12) });
  assert.match(name, /^2024-01-02_你好 世界__[0-9a-f]{8}\.json$/);
  // 同一个 id 永远得到同一个文件名
  assert.equal(name, sessionFileName({ id: '0123456789abcdef', title: '你好/世界', updated_ms: Date.UTC(2024, 0, 2, 12) }));
  // 不同 id（哪怕后 8 位相同）不会撞名
  assert.notEqual(
    sessionFileName({ id: '0123456789abcdef', title: 'x', updated_ms: 0 }),
    sessionFileName({ id: 'fedcba9876543210', title: 'x', updated_ms: 0 }),
  );

  const noTitle = sessionFileName({ id: 'xyz', title: '', updated_ms: null });
  assert.match(noTitle, /^0000-00-00_未命名__[0-9a-f]{8}\.json$/);
});

test('内容哈希稳定且能区分变化', () => {
  const a = [{ role: 'USER', content: '你好' }];
  const b = [{ role: 'USER', content: '你好！' }];
  assert.equal(hashJson(a), hashJson([{ role: 'USER', content: '你好' }]));
  assert.notEqual(hashJson(a), hashJson(b));
  assert.match(hashJson(a), /^sha256:[0-9a-f]{64}$/);
});

test('增量计划：新增 / 未变 / 有更新 / 强制全量', () => {
  const remote = [
    { id: 'a', title: 'A', updated_at: 100 },
    { id: 'b', title: 'B', updated_at: 200 },
  ];

  const fresh = planSync(remote, emptyIndex());
  assert.deepEqual(fresh.toFetch.map((item) => item.summary.id).sort(), ['a', 'b']);
  assert.ok(fresh.toFetch.every((item) => item.reason === '新增'));
  assert.equal(fresh.unchanged.length, 0);
  assert.deepEqual(fresh.goneFromRemote, []);

  const index = { sessions: { a: { updated_at: 100, message_count: 2 }, b: { updated_at: 200, message_count: 3 } } };
  const noChange = planSync(remote, index);
  assert.equal(noChange.toFetch.length, 0);
  assert.equal(noChange.unchanged.length, 2);

  const changed = planSync([{ id: 'a', title: 'A', updated_at: 300 }], index);
  assert.equal(changed.toFetch.length, 1);
  assert.equal(changed.toFetch[0].reason, '有更新');
  assert.deepEqual(changed.goneFromRemote, ['b'], '本地有但远端没有的会话要报告出来');

  const forced = planSync(remote, index, { full: true });
  assert.equal(forced.toFetch.length, 2);
  assert.ok(forced.toFetch.every((item) => item.reason === '强制全量'));
});

test('消息数变化也算有更新（时间戳缺失时的兜底）', () => {
  const remote = [{ id: 'a', title: 'A', message_count: 5 }];
  const index = { sessions: { a: { message_count: 3 } } };
  const plan = planSync(remote, index);
  assert.equal(plan.toFetch.length, 1);
});

test('两边都没有可比字段时判定为未变，避免每次全量重抓', () => {
  const remote = [{ id: 'a', title: 'A' }];
  const index = { sessions: { a: {} } };
  assert.equal(planSync(remote, index).toFetch.length, 0);
});

test('写入会话文件并读回，索引可持久化', () => {
  const dir = tempDir();
  const summary = { id: '0123456789abcdef', title: '测试对话', updated_ms: Date.UTC(2024, 0, 2, 12) };
  const raw = { id: '0123456789abcdef', title: '测试对话', extra: '原始字段要保留' };
  const messages = [{ message_id: 'm1', role: 'USER', content: '你好' }];

  const entry = writeSessionFile(dir, summary, raw, messages);

  assert.match(entry.file, /^sessions[\\/]2024-01-02_测试对话__[0-9a-f]{8}\.json$/);
  assert.equal(entry.message_count, 1);

  const saved = readJsonFile(path.join(dir, entry.file));
  assert.equal(saved.schema, 1);
  assert.equal(saved.session.extra, '原始字段要保留', '原始字段不能丢');
  assert.deepEqual(saved.messages, messages, '消息原样保存');
  assert.ok(saved.fetchedAt);

  const index = emptyIndex();
  index.sessions[summary.id] = entry;
  saveIndex(dir, index);

  const reloaded = loadIndex(dir);
  assert.equal(reloaded.sessions[summary.id].title, '测试对话');
  assert.ok(reloaded.updatedAt);
});

test('索引损坏时备份并报警，而不是静默清空', () => {
  const dir = tempDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.json'), '{坏掉的 json', 'utf8');

  assert.throws(() => loadIndex(dir), /已损坏/);
  const backups = fs.readdirSync(dir).filter((name) => name.startsWith('index.json.corrupt-'));
  assert.equal(backups.length, 1);
  assert.equal(loadIndex(dir).sessions && Object.keys(loadIndex(dir).sessions).length, 0, '损坏后重新开始，但旧文件已备份');
});

test('原子写入与旧文件清理', () => {
  const dir = tempDir();
  const file = path.join(dir, 'nested', 'a.json');
  atomicWriteJson(file, { ok: true });
  assert.deepEqual(readJsonFile(file), { ok: true });

  assert.equal(removeStaleFile(dir, 'nested/a.json'), true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(removeStaleFile(dir, 'nested/a.json'), false, '删不存在的文件不抛错');
  assert.equal(removeStaleFile(dir, null), false);
});
