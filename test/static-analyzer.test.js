'use strict';

/**
 * 静态分析引擎测试
 * ---------------------------------------------------------------------------
 * 覆盖重点：规则注册表完整性、各规则的实际检出能力、以及「干净代码零误报」这一
 * 决定产品可用性的核心约束。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { analyze, describeRules, RULES } = require('../src/analyzers/static-analyzer');
const { SEVERITIES, DIMENSIONS } = require('../src/core/taxonomy');

/** 在给定代码上运行引擎并返回命中的规则 ID 集合 */
function hitRules(code, fileName = 'a.js', options = {}) {
  const result = analyze({ code, fileName, ...options });
  return new Set(result.issues.map((issue) => issue.ruleId));
}

test('规则注册表：数量、ID 唯一性与字段合法性', () => {
  assert.ok(RULES.length >= 40, `规则数量应不少于 40 条，实际 ${RULES.length} 条`);

  const ids = new Set();
  for (const rule of RULES) {
    assert.ok(!ids.has(rule.id), `规则 ID 重复：${rule.id}`);
    ids.add(rule.id);
    assert.ok(SEVERITIES[rule.severity], `规则 ${rule.id} 的 severity 非法`);
    assert.ok(DIMENSIONS[rule.dimension], `规则 ${rule.id} 的 dimension 非法`);
    assert.ok(rule.title && rule.description && rule.suggestion, `规则 ${rule.id} 缺少说明字段`);
  }

  const meta = describeRules();
  assert.equal(meta.total, RULES.length);
  assert.equal(meta.rules.length, RULES.length);
});

test('规则注册表：按严重级别降序排列，保证输出稳定', () => {
  for (let i = 1; i < RULES.length; i += 1) {
    const prev = SEVERITIES[RULES[i - 1].severity].order;
    const curr = SEVERITIES[RULES[i].severity].order;
    assert.ok(prev >= curr, `规则排序错误：${RULES[i - 1].id}(${prev}) 应不早于 ${RULES[i].id}(${curr})`);
  }
});

test('检出能力：硬编码凭据（含带前缀的常见命名）', () => {
  const hits = hitRules([
    'const API_KEY = "sk-abcdef1234567890";',
    'const DB_PASSWORD = \'prod_mysql_2026!\';',
    'ADMIN_TOKEN = "8f2c1a9e7b4d6035"',
  ].join('\n'));
  assert.ok(hits.has('SEC001'));

  // 占位符与环境变量取值不应命中
  const clean = hitRules([
    'const API_KEY = "your_api_key_here";',
    'const SECRET = "xxxxxxxxxxxx";',
  ].join('\n'));
  assert.ok(!clean.has('SEC001'), '占位符不应被判定为硬编码凭据');
});

test('检出能力：SQL 拼接与命令注入', () => {
  const hits = hitRules([
    'const sql = "SELECT * FROM users WHERE name = \'" + name + "\'";',
    'exec("git log " + branch);',
  ].join('\n'));
  assert.ok(hits.has('SEC003'), '应检出 SQL 拼接');
  assert.ok(hits.has('SEC004'), '应检出命令注入');
});

test('检出能力：动态执行、不安全随机数、弱哈希、关闭证书校验', () => {
  const hits = hitRules([
    'eval(userInput);',
    'const sessionId = Math.random().toString(36).slice(2);',
    "const digest = crypto.createHash('md5').update(data).digest('hex');",
    'const agent = new https.Agent({ rejectUnauthorized: false });',
  ].join('\n'));
  assert.ok(hits.has('SEC002'));
  assert.ok(hits.has('SEC005'));
  assert.ok(hits.has('SEC008'));
  assert.ok(hits.has('SEC007'));
});

test('检出能力：基础缺陷类规则', () => {
  const hits = hitRules([
    'function f(a, b) {',
    '  if (a == b) { return 1; }',
    '  try { run(); } catch (e) {}',
    '  const ratio = a / b;',
    '  for (const k in list) { total += k; }',
    '  return 0;',
    '}',
  ].join('\n'));
  assert.ok(hits.has('BUG001'), '应检出松散相等');
  assert.ok(hits.has('BUG002'), '应检出静默吞异常');
  assert.ok(hits.has('BUG005'), '应检出除零风险');
  assert.ok(hits.has('BUG007'), '应检出 for-in 遍历数组');
});

test('检出能力：Python 专有缺陷', () => {
  const py = hitRules([
    'def load(table, filters=[]):',
    '    query = "SELECT * FROM %s WHERE id = \'%s\'" % (table, filters)',
    '    return filters',
    '',
  ].join('\n'), 'a.py');
  assert.ok(py.has('BUG006'), '应检出可变默认参数');
  assert.ok(py.has('SEC003'), '应检出 SQL 拼接');
});

test('误报控制：Python 文档字符串不应被视为动态执行或调试输出', () => {
  const hits = hitRules([
    '"""本模块负责打印报表，说明文字中出现 print 与 eval 属于文档内容。"""',
    'import os',
    '',
    'def main():',
    '    return os.getcwd()',
    '',
  ].join('\n'), 'a.py');
  assert.ok(!hits.has('STY002'), '注释中的 print 不应被判定为调试输出');
  assert.ok(!hits.has('SEC002'), '注释中的 eval 不应被判定为动态执行');
});

test('误报控制：带守卫的除法与字符串中的比较符', () => {
  const hits = hitRules([
    'function safeDivide(a, b) {',
    '  if (b === 0) {',
    '    return 0;',
    '  }',
    '  return a / b;',
    '}',
    'const label = "a == b";',
  ].join('\n'));
  assert.ok(!hits.has('BUG005'), '已有零值守卫的除法不应命中');
  assert.ok(!hits.has('BUG001'), '字符串中的 == 不应命中');
});

test('误报控制：干净代码零告警（核心可用性约束）', () => {
  const clean = [
    "'use strict';",
    '',
    '/**',
    ' * 以误差容限判断两个浮点数是否相等。',
    ' * @param {number} left 左操作数',
    ' * @param {number} right 右操作数',
    ' * @returns {boolean} 是否相等',
    ' */',
    'function nearlyEqual(left, right) {',
    '  return Math.abs(left - right) < 1e-9;',
    '}',
    '',
    '/**',
    ' * 安全除法。',
    ' * @param {number} a 被除数',
    ' * @param {number} b 除数',
    ' * @returns {number} 商',
    ' */',
    'function safeDivide(a, b) {',
    '  if (b === 0) {',
    '    return 0;',
    '  }',
    '  return a / b;',
    '}',
    '',
    'module.exports = { nearlyEqual, safeDivide };',
    '',
  ].join('\n');

  const result = analyze({ code: clean, fileName: 'clean.js' });
  assert.deepEqual(
    result.issues.map((issue) => `${issue.ruleId}@L${issue.line}`),
    [],
    '规范代码不应产生任何告警',
  );
});

test('结果结构：问题对象字段完整且可排序', () => {
  const result = analyze({
    code: 'const API_KEY = "sk-abcdef123456";\n// TODO 待处理\n',
    fileName: 'a.js',
  });

  assert.ok(result.issues.length > 0);
  for (const issue of result.issues) {
    for (const field of ['id', 'ruleId', 'title', 'dimension', 'severity', 'message', 'line', 'source', 'suggestion']) {
      assert.ok(issue[field] !== undefined && issue[field] !== null, `问题缺少字段 ${field}`);
    }
    assert.equal(issue.source, 'static');
  }

  // 按严重级别降序排列
  for (let i = 1; i < result.issues.length; i += 1) {
    assert.ok(result.issues[i - 1].severityOrder >= result.issues[i].severityOrder);
  }
});

test('去重：同一规则在同一行只报一条', () => {
  const result = analyze({ code: 'const a = 1;   \n', fileName: 'a.js' });
  const whitespace = result.issues.filter((issue) => issue.ruleId === 'STY005');
  assert.ok(whitespace.length <= 1);
});

test('过滤：minSeverity 只保留达到阈值的问题', () => {
  const code = 'const API_KEY = "sk-abcdef123456";\nconsole.log(1);\n';
  const all = analyze({ code, fileName: 'a.js' });
  const majorOnly = analyze({ code, fileName: 'a.js', minSeverity: 'major' });

  assert.ok(all.issues.length > majorOnly.issues.length);
  assert.ok(majorOnly.issues.every((issue) => SEVERITIES[issue.severity].order >= SEVERITIES.major.order));
});

test('过滤：ignoreRules 与 dimensions 生效', () => {
  const code = 'const API_KEY = "sk-abcdef123456";\nconsole.log(1);\n';

  const ignored = analyze({ code, fileName: 'a.js', ignoreRules: ['SEC001'] });
  assert.ok(!ignored.issues.some((issue) => issue.ruleId === 'SEC001'));

  const securityOnly = analyze({ code, fileName: 'a.js', dimensions: ['security'] });
  assert.ok(securityOnly.issues.every((issue) => issue.dimension === 'security'));
});

test('统计：severityCounts 与 dimensionCounts 与实际问题一致', () => {
  const code = 'const API_KEY = "sk-abcdef123456";\nconsole.log(1);\n';
  const result = analyze({ code, fileName: 'a.js' });

  const severitySum = Object.values(result.stats.severityCounts).reduce((sum, value) => sum + value, 0);
  const dimensionSum = Object.values(result.stats.dimensionCounts).reduce((sum, value) => sum + value, 0);
  assert.equal(severitySum, result.issues.length);
  assert.equal(dimensionSum, result.issues.length);
  assert.equal(result.stats.codeHash.length, 64);
});

test('语言识别：扩展名决定生效规则集合', () => {
  const js = analyze({ code: 'function f() {}\n', fileName: 'a.js' });
  const py = analyze({ code: 'def f():\n    pass\n', fileName: 'a.py' });

  assert.equal(js.profile.key, 'javascript');
  assert.equal(py.profile.key, 'python');
  assert.notEqual(js.stats.appliedRuleCount, py.stats.appliedRuleCount);
});
