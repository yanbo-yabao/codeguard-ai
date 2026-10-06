'use strict';

/**
 * 报告导出测试
 * ---------------------------------------------------------------------------
 * 覆盖重点：四种导出格式的结构完整性、HTML 的自包含性（可离线打开），
 * 以及 SARIF 是否符合 2.1.0 规范的基本形态。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { toMarkdown, toHtml, toSarif, exportReport } = require('../src/services/report-service');

/** 构造一份用于导出测试的最小记录 */
function buildRecord() {
  return {
    id: 'rv_test_0001',
    createdAt: '2026-03-01T10:00:00.000Z',
    source: {
      title: 'demo.js',
      fileName: 'demo.js',
      language: 'JavaScript',
      languageKey: 'javascript',
      codeHash: 'a'.repeat(64),
      totalLines: 40,
      codePreview: 'const a = 1;',
      codeTruncated: false,
    },
    options: { useLlm: false, roles: [], ignoreRules: [], includeFixes: true },
    engines: { static: true, llm: false, llmRoles: [] },
    metrics: {
      totalLines: 40,
      nonBlankLines: 30,
      codeLines: 24,
      commentLines: 6,
      blankLines: 10,
      commentRatio: 0.2,
      maxLineLength: 90,
      longLineCount: 0,
      functionCount: 2,
      maxFunctionLength: 12,
      maxComplexity: 4,
      avgComplexity: 2.5,
      maxNesting: 3,
      maintainabilityIndex: 78,
      todoCount: 0,
      functions: [
        { name: 'alpha', startLine: 1, endLine: 8, lines: 8, complexity: 3, nesting: 2, params: 2 },
        { name: 'beta', startLine: 10, endLine: 20, lines: 11, complexity: 4, nesting: 3, params: 1 },
      ],
    },
    score: {
      overall: 68.5,
      grade: 'C',
      gradeLabel: '需改进',
      advice: '存在影响稳定性或安全性的问题，建议本轮迭代内修复。',
      dimensions: {
        security: { key: 'security', label: '安全性', color: '#e5484d', score: 55, penalty: 12, issueCount: 1 },
        bug: { key: 'bug', label: '缺陷风险', color: '#f76808', score: 82, penalty: 6, issueCount: 1 },
        performance: { key: 'performance', label: '性能', color: '#a371f7', score: 100, penalty: 0, issueCount: 0 },
        readability: { key: 'readability', label: '可读性', color: '#3b82f6', score: 96, penalty: 1, issueCount: 1 },
        maintainability: { key: 'maintainability', label: '可维护性', color: '#2da44e', score: 90, penalty: 3, issueCount: 0 },
      },
      penalty: { raw: 22, normalized: 18.2, sigma: 0.83, structural: 0, bySeverity: {} },
      structural: { complexityPenalty: 0, nestingPenalty: 0 },
      deductions: [
        { issueId: 'i1', ruleId: 'SEC001', title: '硬编码敏感凭据', severity: 'blocker', source: 'static', weight: 15, applied: 15 },
      ],
      model: { name: 'CodeGuard 加权扣分模型 v1', description: '综合得分 = 100 − σ × Σ(权重 × 可信度)', sigma: 0.83, formula: 'x' },
    },
    issues: [
      {
        id: 'i1', ruleId: 'SEC001', title: '硬编码敏感凭据', dimension: 'security', dimensionLabel: '安全性',
        severity: 'blocker', severityLabel: '阻断', severityOrder: 5, message: '检测到硬编码凭据 <script>alert(1)</script>',
        line: 12, column: 1, snippet: 'const API_KEY = "sk-xxx";', suggestion: '改为从环境变量读取。',
        reference: 'OWASP A07', source: 'static', confidence: 0.9,
      },
      {
        id: 'i2', ruleId: 'LLM-SEC', title: '模型发现的越权风险', dimension: 'bug', dimensionLabel: '缺陷风险',
        severity: 'major', severityLabel: '主要', severityOrder: 3, message: '缺少归属校验。',
        line: 30, column: 1, snippet: 'return db.find(id);', suggestion: '补充 owner 校验。',
        reference: '大模型语义评审', source: 'llm', role: 'bug', roleLabel: '缺陷检测专家', confidence: 0.7,
      },
    ],
    fixes: [
      {
        issueId: 'i1', ruleId: 'SEC001', title: '硬编码敏感凭据', line: 12, applicable: true, offline: true,
        source: 'template', rationale: '改为环境变量注入。', risk: 'low',
        before: 'const API_KEY = "sk-xxx";', after: 'const API_KEY = process.env.API_KEY;',
        diff: '@@ -12,1 +12,1 @@\n-const API_KEY = "sk-xxx";\n+const API_KEY = process.env.API_KEY;',
        tests: ['缺少环境变量时应抛出明确错误'],
      },
    ],
    summary: {
      overview: '共发现 2 个问题，其中阻断级 1 个。',
      highlights: ['注释率达标'],
      blockers: ['第 12 行：硬编码敏感凭据'],
      actions: ['处理 SEC001'],
      offline: true,
    },
    llm: { enabled: false, model: null, roles: [], roleSummaries: {}, usage: {}, durationMs: 0, errors: [] },
    stats: {
      durationMs: 1234,
      staticIssueCount: 1,
      llmIssueCount: 1,
      confirmedCount: 0,
      llmOnlyCount: 1,
      issueCount: 2,
      severityCounts: { blocker: 1, critical: 0, major: 1, minor: 0, info: 0 },
      dimensionCounts: { security: 1, bug: 1, performance: 0, readability: 0, maintainability: 0 },
      appliedRuleCount: 40,
      ruleCount: 41,
      ruleHits: { SEC001: 1 },
      estimatedPenalty: 20,
    },
    warnings: [],
    meta: { version: '1.0.0', ruleVersion: 'v1', engine: 'codeguard-ai', scoreModel: 'CodeGuard 加权扣分模型 v1' },
  };
}

test('Markdown 报告：包含全部必备章节与关键数据', () => {
  const md = toMarkdown(buildRecord());

  for (const heading of ['# 代码审查报告', '## 一、结论摘要', '## 二、评分卡', '## 三、问题清单', '## 四、修复建议', '## 五、代码度量', '## 附录：可复现性信息']) {
    assert.ok(md.includes(heading), `缺少章节：${heading}`);
  }
  assert.ok(md.includes('68.5'));
  assert.ok(md.includes('等级 C'));
  assert.ok(md.includes('SEC001'));
  assert.ok(md.includes('```diff'));
  assert.ok(md.includes('a'.repeat(64)));
});

test('Markdown 报告：表格中的竖线被转义，避免破坏表格结构', () => {
  const record = buildRecord();
  record.issues[0].message = '包含 | 竖线 | 的消息';
  const md = toMarkdown(record);
  assert.ok(md.includes('\\|'), '竖线应被转义');
});

test('HTML 报告：自包含且转义用户内容，防止 XSS', () => {
  const html = toHtml(buildRecord());

  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes('<style>'), '样式必须内联，保证离线可打开');
  assert.ok(!/<link[^>]+href="http/i.test(html), '不应引用外部样式');
  assert.ok(!/<script[^>]+src=/i.test(html), '报告不依赖外部脚本');
  assert.ok(html.includes('68.5'));
  assert.ok(!html.includes('<script>alert(1)</script>'), '用户内容必须被转义');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});

test('HTML 报告：得分圆环的 dasharray 与得分成比例', () => {
  const record = buildRecord();
  const html = toHtml(record);
  const circumference = 2 * Math.PI * 54;
  const expected = ((record.score.overall / 100) * circumference).toFixed(1);
  assert.ok(html.includes(expected), `应包含与得分匹配的弧长 ${expected}`);
});

test('SARIF 报告：结构合法、规则与结果数量一致', () => {
  const sarif = toSarif(buildRecord());

  assert.equal(sarif.version, '2.1.0');
  assert.ok(sarif.$schema.includes('sarif'));
  assert.equal(sarif.runs.length, 1);

  const run = sarif.runs[0];
  assert.equal(run.tool.driver.name, 'CodeGuard AI');
  assert.equal(run.results.length, 2);
  assert.equal(run.tool.driver.rules.length, 2);

  for (const result of run.results) {
    assert.ok(result.ruleId);
    assert.ok(Number.isInteger(result.ruleIndex));
    assert.ok(['error', 'warning', 'note'].includes(result.level));
    assert.equal(result.locations[0].physicalLocation.region.startLine > 0, true);
  }

  assert.equal(run.results[0].level, 'error', '阻断级应映射为 error');
  assert.equal(run.results[1].level, 'warning', '主要级应映射为 warning');
  assert.equal(run.invocations[0].properties.score, 68.5);
});

test('exportReport：按格式分派并给出正确的 MIME 与文件名', () => {
  const record = buildRecord();

  const json = exportReport(record, 'json');
  assert.match(json.contentType, /application\/json/);
  assert.ok(json.fileName.endsWith('.json'));
  assert.equal(JSON.parse(json.content).id, record.id);

  const md = exportReport(record, 'md');
  assert.match(md.contentType, /text\/markdown/);
  assert.ok(md.fileName.endsWith('.md'));

  const html = exportReport(record, 'html');
  assert.match(html.contentType, /text\/html/);
  assert.ok(html.fileName.endsWith('.html'));

  const sarif = exportReport(record, 'sarif');
  assert.ok(sarif.fileName.endsWith('.sarif.json'));

  // 未知格式回退为 JSON
  const fallback = exportReport(record, 'unknown-format');
  assert.match(fallback.contentType, /application\/json/);
});
