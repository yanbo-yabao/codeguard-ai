'use strict';

/**
 * RAG 检索器测试
 * ---------------------------------------------------------------------------
 * 覆盖重点：相关性命中（SQL 注入/密钥等主题应召回对应知识条目）、
 * 无关查询不硬凑（低于阈值不召回）、确定性（同输入同输出）。
 */

process.env.LOG_LEVEL = 'silent';

const test = require('node:test');
const assert = require('node:assert/strict');

const { retrieve, tokenize } = require('../src/rag/retriever');

test('检索：SQL 注入主题召回修复模式条目', () => {
  const hits = retrieve('这段 SQL 是字符串拼接的，怎么防注入');
  assert.ok(hits.length > 0, '应召回至少一条');
  assert.equal(hits[0].id, 'kb-sqli', '最相关应为 SQL 注入修复模式');
  assert.ok(hits[0].score >= 4);
  assert.match(hits[0].content, /参数化/);
});

test('检索：硬编码密钥主题召回密钥管理条目', () => {
  const hits = retrieve('password 和 api key 硬编码在源码里怎么办');
  assert.ok(hits.some((item) => item.id === 'kb-secrets'), '应召回密钥修复模式');
});

test('检索：无关查询不硬凑（低于阈值不召回）', () => {
  const hits = retrieve('量子引力波天线的轨道参数设计');
  assert.deepEqual(hits, [], '无关主题不应召回任何条目');
});

test('检索：确定性与条数上限', () => {
  const first = retrieve('性能优化 数据库查询太慢', { limit: 2 });
  const second = retrieve('性能优化 数据库查询太慢', { limit: 2 });
  assert.deepEqual(first, second, '同输入必须同输出');
  assert.ok(first.length <= 2, '应遵守 limit');
  assert.ok(first.some((item) => item.id === 'kb-perf-query'), '应召回 N+1 查询优化条目');
});

test('分词：中文二元组与英文整词', () => {
  const tokens = tokenize('SQL 注入 sqlInjection 修复');
  assert.ok(tokens.has('注入'), '中文二元组应包含「注入」');
  assert.ok(tokens.has('sqlinjection'), '英文应小写整词');
});
