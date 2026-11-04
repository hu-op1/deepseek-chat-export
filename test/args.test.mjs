import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs } from '../lib/args.mjs';

const SPEC = {
  out: { type: 'string', default: 'data', desc: '' },
  top: { type: 'number', default: 10, desc: '' },
  force: { type: 'boolean', desc: '' },
  help: { type: 'boolean', alias: 'h', desc: '' },
};

test('默认值生效', () => {
  const options = parseArgs([], SPEC);
  assert.equal(options.out, 'data');
  assert.equal(options.top, 10);
  assert.equal(options.force, false);
  assert.deepEqual(options._, []);
});

test('解析 --key value 与 --key=value 两种写法', () => {
  assert.equal(parseArgs(['--out', 'tmp'], SPEC).out, 'tmp');
  assert.equal(parseArgs(['--out=tmp'], SPEC).out, 'tmp');
  assert.equal(parseArgs(['--top', '5'], SPEC).top, 5);
  assert.equal(parseArgs(['--top=5'], SPEC).top, 5);
});

test('布尔开关不吞掉后面的参数', () => {
  const options = parseArgs(['--force', '--out', 'x'], SPEC);
  assert.equal(options.force, true);
  assert.equal(options.out, 'x');
});

test('别名与 -h', () => {
  assert.equal(parseArgs(['-h'], SPEC).help, true);
  assert.equal(parseArgs(['--help'], SPEC).help, true);
});

test('非选项参数收集到 _ 里（ask.mjs 靠这个拿查询词）', () => {
  const options = parseArgs(['--top', '3', '那次聊显存', '--force'], SPEC);
  assert.deepEqual(options._, ['那次聊显存']);
  assert.equal(options.top, 3);
  assert.equal(options.force, true);
});

test('带空格的查询词整体保留', () => {
  const options = parseArgs(['--top', '3', '摩托车 怎么上牌'], SPEC);
  assert.deepEqual(options._, ['摩托车 怎么上牌']);
});

test('不认识的选项要报错，而不是静默忽略', () => {
  assert.throws(() => parseArgs(['--nope'], SPEC), /不认识的选项/);
});

test('选项缺少取值要报错', () => {
  assert.throws(() => parseArgs(['--out'], SPEC), /缺少取值/);
});
