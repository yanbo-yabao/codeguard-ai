'use strict';

/**
 * 评审服务（业务编排）测试
 * ---------------------------------------------------------------------------
 * 覆盖重点：输入校验、双引擎结果融合与交叉印证统计、降级行为、以及结果持久化。
 * 使用离线模拟器（mock）作为大模型后端，保证测试零外网依赖且结果确定。
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// 必须在 require 业务模块之前完成环境注入：配置中心在模块加载时即读取环境变量
const TMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'codeguard-test-'));
process.env.DATA_DIR = TMP_DATA_DIR;
process.env.LLM_PROVIDER = 'mock';
process.env.REVIEW_ENABLE_LLM = 'true';
process.env.LOG_LEVEL = 'silent';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ReviewService, mergeIssues } = require('../src/services/review-service');
const { ReviewStore } = require('../src/core/storage');
const { LlmClient } = require('../src/agents/llm-client');

/** 创建使用独立存储目录的服务实例 */
function createService() {
  const dir = fs.mkdtempSync(path.join(TMP_DATA_DIR, 'reviews-'));
  const store = new ReviewStore(dir);
  store.init();
  return new ReviewService({ client: new LlmClient({ provider: 'mock' }), store });
}

/** 构造一个问题对象 */
function issue(overrides = {}) {
  return {
    id: `x${Math.random()}`,
    ruleId: 'SEC001',
    title: '硬编码凭据',
    dimension: 'security',
    severity: 'blocker',
    severityOrder: 5,
    line: 10,
    source: 'static',
    ...overrides,
  };
}

test('mergeIssues：同维度邻近行的大模型结论被判定为互相印证', () => {
  const staticIssues = [issue({ id: 's1', line: 10, dimension: 'security' })];
  const llmIssues = [
    issue({ id: 'l1', line: 11, dimension: 'security', source: 'llm' }),
    issue({ id: 'l2', line: 40, dimension: 'performance', source: 'llm', severity: 'major', severityOrder: 3 }),
  ];

  const merged = mergeIssues(staticIssues, llmIssues);

  assert.equal(merged.confirmed, 1, '邻近行同维度应判定为印证');
  assert.equal(merged.llmOnly, 1);
  assert.equal(merged.issues.length, 2, '被印证的模型结论不重复计入');
  assert.equal(merged.issues.find((item) => item.id === 's1').confirmedBy, 1);
});

test('mergeIssues：结果按严重级别降序、同级按行号升序排列', () => {
  const merged = mergeIssues(
    [issue({ id: 'a', line: 50, severity: 'major', severityOrder: 3 }), issue({ id: 'b', line: 5, severity: 'blocker', severityOrder: 5 })],
    [issue({ id: 'c', line: 20, severity: 'major', severityOrder: 3, dimension: 'performance', source: 'llm' })],
  );

  assert.deepEqual(merged.issues.map((item) => item.id), ['b', 'c', 'a']);
});

test('normalizeInput：拒绝空代码与超长代码', async () => {
  const service = createService();

  assert.throws(() => service.normalizeInput({ code: '' }), (error) => {
    assert.equal(error.code, 'VALIDATION_ERROR');
    return true;
  });
  assert.throws(() => service.normalizeInput({ code: '   \n  ' }), /不能为空/);
  assert.throws(() => service.normalizeInput({ code: 'a'.repeat(800_001) }), /过长/);
});

test('normalizeInput：默认值与非法值修正', () => {
  const service = createService();
  const normalized = service.normalizeInput({
    code: 'const a = 1;',
    fileName: '/tmp/very/deep/demo.js',
    roles: ['security', '不存在的角色'],
    dimensions: ['security', '不存在的维度'],
    minSeverity: '不存在的级别',
    ignoreRules: ['SEC001'],
  });

  assert.equal(normalized.fileName, 'demo.js', '文件名应只保留基名');
  assert.deepEqual(normalized.roles, ['security']);
  assert.deepEqual(normalized.dimensions, ['security']);
  assert.equal(normalized.minSeverity, null);
  assert.deepEqual(normalized.ignoreRules, ['SEC001']);
  assert.equal(normalized.useLlm, true);
});

test('review：完整流程产出结构完整的评审记录并持久化', async () => {
  const service = createService();
  const code = [
    'const API_KEY = "sk-abcdef1234567890";',
    'function f(a, b) {',
    '  if (a == b) { return 1; }',
    '  return a / b;',
    '}',
    '',
  ].join('\n');

  const record = await service.review({ code, fileName: 'demo.js', title: '演示' });

  // 基本信息
  assert.match(record.id, /^rv_/);
  assert.equal(record.source.title, '演示');
  assert.equal(record.source.languageKey, 'javascript');
  assert.equal(record.source.codeHash.length, 64);

  // 双引擎
  assert.equal(record.engines.static, true);
  assert.equal(record.engines.llm, true);
  assert.ok(record.stats.staticIssueCount > 0);
  assert.ok(record.stats.llmIssueCount > 0);
  assert.ok(record.stats.confirmedCount > 0, '模拟器与规则引擎应存在互相印证的结论');

  // 评分与结论
  assert.ok(record.score.overall >= 0 && record.score.overall <= 100);
  assert.ok(record.score.grade);
  assert.ok(record.summary.overview.length > 0);
  assert.equal(record.issues.length, record.stats.issueCount);

  // 修复建议
  assert.ok(Array.isArray(record.fixes));
  assert.ok(record.fixes.every((fix) => fix.issueId && fix.ruleId && fix.rationale));

  // 持久化与读取
  const loaded = service.get(record.id);
  assert.equal(loaded.id, record.id);
  assert.deepEqual(loaded.issues.map((item) => item.id), record.issues.map((item) => item.id));

  const listed = service.list({ limit: 10 });
  assert.ok(listed.items.some((item) => item.id === record.id));
});

test('review：离线模式下修复建议使用内置模板且零大模型调用（回归）', async () => {
  const service = createService();
  const record = await service.review({
    code: 'const API_KEY = "sk-abcdef1234567890";\n',
    fileName: 'demo.js',
    useLlm: false,
    includeFixes: true,
    fixLimit: 3,
  });

  assert.ok(record.fixes.length > 0, '离线模式仍应生成修复建议（走内置模板）');
  assert.ok(
    record.fixes.every((fix) => fix.source === 'template'),
    `离线模式修复建议必须来自内置模板，实际来源：${record.fixes.map((fix) => fix.source).join(',')}`,
  );
  assert.equal(record.llm.usage.calls || 0, 0, 'useLlm=false 时不得产生任何大模型调用');
  assert.equal(record.engines.llm, false);
});

test('review：关闭大模型时降级为纯规则引擎并给出说明', async () => {
  const service = createService();
  const record = await service.review({
    code: 'const API_KEY = "sk-abcdef1234567890";\n',
    fileName: 'demo.js',
    useLlm: false,
    includeFixes: false,
  });

  assert.equal(record.engines.llm, false);
  assert.equal(record.stats.llmIssueCount, 0);
  assert.equal(record.fixes.length, 0);
  assert.ok(record.warnings.some((item) => item.includes('仅执行本地规则引擎')));
  assert.equal(record.summary.offline, true, '无大模型时应使用确定性兜底结论');
});

test('review：维度过滤同时作用于规则引擎与模型结论', async () => {
  const service = createService();
  const record = await service.review({
    code: 'const API_KEY = "sk-abcdef1234567890";\nconsole.log(1);\n',
    fileName: 'demo.js',
    dimensions: ['security'],
    includeFixes: false,
  });

  assert.ok(record.issues.length > 0);
  assert.ok(record.issues.every((item) => item.dimension === 'security'), '不应出现非安全维度的问题');
});

test('review：minSeverity 过滤与 ignoreRules 生效', async () => {
  const service = createService();
  const record = await service.review({
    code: 'const API_KEY = "sk-abcdef1234567890";\nconsole.log(1);\n',
    fileName: 'demo.js',
    minSeverity: 'blocker',
    ignoreRules: ['STY001'],
    useLlm: false,
    includeFixes: false,
  });

  assert.ok(record.issues.every((item) => item.severity === 'blocker'));
});

test('review：代码预览被截断但指纹覆盖全文', async () => {
  const service = createService();
  const longCode = `const API_KEY = "sk-abcdef1234567890";\n${'// 填充\n'.repeat(1200)}`;
  const record = await service.review({ code: longCode, fileName: 'big.js', useLlm: false, includeFixes: false });

  assert.ok(record.source.codePreview.length <= 4000);
  assert.equal(record.source.codeTruncated, true);
  assert.equal(record.source.codeHash.length, 64);
});

test('overview：统计信息与历史记录一致', async () => {
  const service = createService();
  await service.review({ code: 'const a = 1;\n', fileName: 'a.js', useLlm: false, includeFixes: false });
  await service.review({ code: 'const b = 2;\n', fileName: 'b.js', useLlm: false, includeFixes: false });

  const overview = service.overview();
  assert.equal(overview.totalReviews, 2);
  assert.equal(overview.recent.length, 2);
  assert.ok(typeof overview.averageScore === 'number');
  // 列表摘要中的 language 为面向人类阅读的语言标签（profile.label）
  assert.ok(overview.languageDistribution.JavaScript >= 1, `语言分布异常：${JSON.stringify(overview.languageDistribution)}`);
});

test('remove：删除后不可再读取', async () => {
  const service = createService();
  const record = await service.review({ code: 'const a = 1;\n', fileName: 'a.js', useLlm: false, includeFixes: false });

  assert.equal(service.remove(record.id), true);
  assert.throws(() => service.get(record.id), (error) => {
    assert.equal(error.code, 'NOT_FOUND');
    return true;
  });
});

test('exportReport：可从记录直接导出四种格式', async () => {
  const service = createService();
  const record = await service.review({ code: 'const API_KEY = "sk-abcdef123";\n', fileName: 'a.js', useLlm: false });

  for (const format of ['json', 'markdown', 'html', 'sarif']) {
    const result = service.exportReport(record.id, format);
    assert.ok(result.content.length > 0, `${format} 导出内容为空`);
    assert.ok(result.fileName.length > 0);
  }
});

test.after(() => {
  // 清理临时目录
  try {
    fs.rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响测试结论 */
  }
});
