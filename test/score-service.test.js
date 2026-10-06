'use strict';

/**
 * 评分卡模型测试
 * ---------------------------------------------------------------------------
 * 覆盖重点：扣分公式的可复现性、等级划分边界、以及规模归一化与来源可信度系数的行为。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeScore, sizeNormalization, issuePenalty, resolveGrade } = require('../src/services/score-service');
const { DIMENSIONS } = require('../src/core/taxonomy');

/** 构造一个问题对象 */
function issue(severity, dimension = 'bug', extra = {}) {
  return { id: `x-${severity}-${Math.random()}`, ruleId: 'TST001', title: 't', severity, dimension, source: 'static', ...extra };
}

/** 构造度量对象 */
function metrics(totalLines = 100) {
  return { totalLines, nonBlankLines: totalLines, maxComplexity: 0, maxNesting: 0 };
}

test('无问题时满分为 100 且等级为 S', () => {
  const score = computeScore({ issues: [], metrics: metrics() });
  assert.equal(score.overall, 100);
  assert.equal(score.grade, 'S');
  assert.equal(score.penalty.raw, 0);
});

test('等级阈值边界正确', () => {
  assert.equal(resolveGrade(100).grade, 'S');
  assert.equal(resolveGrade(92).grade, 'S');
  assert.equal(resolveGrade(91.9).grade, 'A');
  assert.equal(resolveGrade(82).grade, 'A');
  assert.equal(resolveGrade(70).grade, 'B');
  assert.equal(resolveGrade(60).grade, 'C');
  assert.equal(resolveGrade(59.9).grade, 'D');
  assert.equal(resolveGrade(0).grade, 'D');
});

test('规模归一化系数 σ 随代码规模单调下降且不超过 1', () => {
  const samples = [10, 30, 100, 500, 1200, 5000].map((n) => sizeNormalization(n));
  assert.equal(samples[0], 1);
  assert.equal(samples[1], 1);
  for (let i = 2; i < samples.length; i += 1) {
    assert.ok(samples[i] < samples[i - 1], `σ 应随规模单调下降：${samples[i - 1]} → ${samples[i]}`);
    assert.ok(samples[i] > 0 && samples[i] <= 1);
  }
});

test('大模型的结论按置信度折算，扣分低于同级静态结论', () => {
  const staticPenalty = issuePenalty(issue('major'));
  const llmPenalty = issuePenalty(issue('major', 'bug', { source: 'llm', confidence: 1 }));

  assert.equal(staticPenalty, 5);
  assert.ok(llmPenalty < staticPenalty, '大模型结论应低于确定性结论');
  assert.equal(Number(llmPenalty.toFixed(2)), 4);
});

test('相同问题数下，大文件得分高于小文件', () => {
  const issues = [issue('major'), issue('minor')];
  const small = computeScore({ issues, metrics: metrics(30) });
  const large = computeScore({ issues, metrics: metrics(1000) });

  assert.ok(large.overall > small.overall, `大文件(${large.overall})应高于小文件(${small.overall})`);
});

test('扣分与综合得分保持闭环（可复算）', () => {
  const issues = [issue('blocker'), issue('critical'), issue('major'), issue('minor'), issue('info')];
  const score = computeScore({ issues, metrics: metrics(30) });

  const rawSum = 15 + 10 + 5 + 2 + 0.5;
  assert.equal(score.penalty.raw, rawSum);
  assert.equal(score.penalty.normalized, Number((rawSum * score.penalty.sigma).toFixed(2)));
  assert.equal(score.overall, Number(Math.max(0, 100 - score.penalty.normalized).toFixed(1)));
});

test('结构风险修正：高复杂度与深嵌套会额外扣分', () => {
  const base = computeScore({ issues: [], metrics: { totalLines: 200, nonBlankLines: 200, maxComplexity: 0, maxNesting: 0 } });
  const complex = computeScore({ issues: [], metrics: { totalLines: 200, nonBlankLines: 200, maxComplexity: 25, maxNesting: 8 } });

  assert.equal(base.overall, 100);
  assert.ok(complex.structural.complexityPenalty > 0);
  assert.ok(complex.structural.nestingPenalty > 0);
  assert.ok(complex.overall < 100);
  assert.equal(complex.deductions.length, 0, '结构扣分不产生问题条目');
});

test('结构风险修正可关闭', () => {
  const metricsDeep = { totalLines: 200, nonBlankLines: 200, maxComplexity: 25, maxNesting: 8 };
  const withStructural = computeScore({ issues: [], metrics: metricsDeep });
  const withoutStructural = computeScore({ issues: [], metrics: metricsDeep, options: { enableStructuralPenalty: false } });

  assert.ok(withoutStructural.overall > withStructural.overall);
  assert.equal(withoutStructural.structural.complexityPenalty, 0);
});

test('五个业务维度全部输出，且得分在 0~100 之间', () => {
  const score = computeScore({
    issues: [issue('blocker', 'security'), issue('major', 'performance'), issue('minor', 'readability')],
    metrics: metrics(200),
  });

  const keys = Object.keys(score.dimensions);
  assert.deepEqual(keys.sort(), Object.keys(DIMENSIONS).sort());
  for (const dimension of Object.values(score.dimensions)) {
    assert.ok(dimension.score >= 0 && dimension.score <= 100, `${dimension.key} 得分越界：${dimension.score}`);
    assert.ok(typeof dimension.label === 'string' && dimension.label.length > 0);
  }
  assert.ok(score.dimensions.security.score < 100);
  assert.equal(score.dimensions.bug.issueCount, 0);
});

test('安全问题敏感度最高：同级别下安全维度扣分最多', () => {
  const score = computeScore({
    issues: [issue('major', 'security'), issue('major', 'readability')],
    metrics: metrics(200),
  });
  assert.ok(score.dimensions.security.penalty > score.dimensions.readability.penalty);
});

test('扣分明细按生效扣分降序，且不超过 50 条', () => {
  const issues = Array.from({ length: 80 }, () => issue('minor'));
  const score = computeScore({ issues, metrics: metrics(500) });

  assert.ok(score.deductions.length <= 50);
  for (let i = 1; i < score.deductions.length; i += 1) {
    assert.ok(score.deductions[i - 1].applied >= score.deductions[i].applied);
  }
});

test('模型元信息可用于报告复现', () => {
  const score = computeScore({ issues: [issue('major')], metrics: metrics(50) });
  assert.ok(score.model.name);
  assert.ok(score.model.description.includes('σ'));
  assert.ok(score.model.formula.includes('clamp'));
  assert.equal(score.model.sigma, score.penalty.sigma);
});
