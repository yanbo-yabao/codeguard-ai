'use strict';

/**
 * 确定性语法检查器测试
 * ---------------------------------------------------------------------------
 * 覆盖重点：括号匹配、字符串闭合、JavaScript 编译验证、
 * 以及最重要的「零误报」——字符串/注释/标记语言中的符号不得触发检查。
 */

process.env.LOG_LEVEL = 'silent';

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkSyntax } = require('../src/analyzers/syntax-checker');

test('干净的 JavaScript 代码不产生任何问题（零误报）', () => {
  const code = [
    'const fs = require("fs");',
    '',
    '/** 求和 */',
    'function sum(list) {',
    '  const note = "(括号在字符串里 )"; // 注释里的 { 也不算',
    '  return list.reduce((acc, item) => acc + item, 0);',
    '}',
    'module.exports = { sum };',
  ].join('\n');

  const { issues } = checkSyntax({ code, fileName: 'sum.js' });
  assert.deepEqual(issues, [], '规范代码不应报任何语法问题');
});

test('未闭合的花括号被检出且行号准确', () => {
  const code = 'function broken() {\n  return 1;\n';
  const { issues } = checkSyntax({ code, fileName: 'broken.js' });

  const bracket = issues.find((item) => item.ruleId === 'SYN001');
  assert.ok(bracket, '应检出括号未闭合');
  assert.equal(bracket.line, 1);
  assert.equal(bracket.severity, 'major');
  assert.match(bracket.suggestion, /闭合括号/);
});

test('括号类型不匹配被检出并指出期望的括号', () => {
  const code = 'function broken() {\n  return 1;\n]';
  const { issues } = checkSyntax({ code, fileName: 'broken.js' });

  const mismatch = issues.find((item) => item.ruleId === 'SYN001' && /不配对/.test(item.message));
  assert.ok(mismatch, '应检出括号不匹配');
  assert.match(mismatch.message, /\}/);
});

test('未闭合的字符串被检出（SYN002）', () => {
  const code = 'const s = "abc\nconst t = 1;';
  const { issues } = checkSyntax({ code, fileName: 'str.js' });

  const stringIssue = issues.find((item) => item.ruleId === 'SYN002');
  assert.ok(stringIssue, '应检出字符串未闭合');
  assert.equal(stringIssue.line, 1);
});

test('JavaScript 编译验证检出真实语法错误（SYN003）', () => {
  const code = 'const a = ;\n';
  const { issues } = checkSyntax({ code, fileName: 'err.js' });

  const compile = issues.find((item) => item.ruleId === 'SYN003');
  assert.ok(compile, 'vm 编译应检出语法错误');
  assert.equal(compile.severity, 'critical');
  assert.equal(compile.confidence, 1);
});

test('ESM 语法（import/export）不被 vm 误报', () => {
  const code = "import path from 'path';\nexport function ok() { return path.sep; }\n";
  const { issues } = checkSyntax({ code, fileName: 'esm.mjs' });
  assert.deepEqual(issues.filter((item) => item.ruleId === 'SYN003'), [], 'import/export 是合法语法');
});

test('JSX 语法不被 vm 误报', () => {
  const code = 'const el = <div className="box">hi</div>;\n';
  const { issues } = checkSyntax({ code, fileName: 'view.jsx' });
  assert.deepEqual(issues.filter((item) => item.ruleId === 'SYN003'), [], 'JSX 是合法语法');
});

test('顶层 await 不被 vm 误报', () => {
  const code = "const data = await fetch('/api');\n";
  const { issues } = checkSyntax({ code, fileName: 'top.mjs' });
  assert.deepEqual(issues.filter((item) => item.ruleId === 'SYN003'), [], '顶层 await 在模块中合法');
});

test('HTML 标记语言整体跳过启发式检查（零误报）', () => {
  const code = '<title>首页</title>\n<p>写一个函数 f(x，例如（不闭合</p>\n';
  const { issues, checkedBy } = checkSyntax({ code, fileName: 'index.html' });
  assert.deepEqual(issues, [], 'HTML 正文中的括号不应报错');
  assert.equal(checkedBy.heuristic, false);
});

test('Python 括号未闭合被检出，字符串里的括号不误报', () => {
  const code = 'def add(a, b):\n    s = "(不要算我"\n    return a + b\n';
  const clean = checkSyntax({ code, fileName: 'add.py' });
  assert.deepEqual(clean.issues, [], '字符串中的括号不应计入');

  const broken = checkSyntax({ code: 'def add(a, b:\n    return a + b\n', fileName: 'add.py' });
  assert.ok(broken.issues.some((item) => item.ruleId === 'SYN001'), '应检出未闭合括号');
});

test('转义引号不导致字符串误判', () => {
  const code = 'const s = "say \\"hi\\" ok";\nfunction f() { return 1; }\n';
  const { issues } = checkSyntax({ code, fileName: 'escape.js' });
  assert.deepEqual(issues, [], '转义引号不应破坏字符串状态机');
});

test('关键字拼写错误被检出（SYN004）', () => {
  const js = checkSyntax({ code: 'fuction hello() {\n  retrn 1;\n}\n', fileName: 'typo.js' });
  assert.ok(js.issues.filter((item) => item.ruleId === 'SYN004').length >= 2, 'fuction / retrn 应被检出');

  const py = checkSyntax({ code: 'def calc(x):\n    retrn x * 2\n', fileName: 'typo.py' });
  assert.ok(py.issues.some((item) => item.ruleId === 'SYN004'), 'Python 的 retrn 应被检出');

  const java = checkSyntax({ code: 'pubilc class A {\n  statci void main() {}\n}\n', fileName: 'A.java' });
  assert.ok(java.issues.filter((item) => item.ruleId === 'SYN004').length >= 2, 'Java 的 pubilc / statci 应被检出');
});

test('属性/方法名拼写错误被检出（SYN004）', () => {
  const code = 'function main() {\n  const list = [1, 2];\n  return list.mappper(x => x);\n}\n';
  const { issues } = checkSyntax({ code, fileName: 'api.js' });
  assert.ok(issues.some((item) => item.ruleId === 'SYN004' && /mappper/.test(item.message)), '.mappper 应被检出');
});

test('Python 复合语句缺少冒号被检出（SYN005）', () => {
  const { issues } = checkSyntax({ code: 'def add(a, b)\n    return a + b\n', fileName: 'colon.py' });
  const missing = issues.find((item) => item.ruleId === 'SYN005');
  assert.ok(missing, 'def 缺少冒号应被检出');
  assert.equal(missing.line, 1);
  assert.match(missing.suggestion, /冒号/);
});

test('Python 单行语句体与多行参数不误报缺冒号（零误报）', () => {
  const oneLiner = checkSyntax({ code: 'if x > 0: pass\n', fileName: 'ok1.py' });
  assert.deepEqual(oneLiner.issues, [], '单行语句体合法');

  const multiLine = checkSyntax({ code: 'def f(\n    a,\n    b,\n):\n    return a\n', fileName: 'ok2.py' });
  assert.deepEqual(multiLine.issues, [], '多行参数列表合法');
});

test('Python Tab 与空格混用导致缩进歧义被检出（SYN005）', () => {
  const code = 'def f(x):\n\tif x > 0:\n        return 1\n    return 0\n';
  const { issues } = checkSyntax({ code, fileName: 'tabs.py' });
  assert.ok(issues.some((item) => item.ruleId === 'SYN005' && /Tab/.test(item.title)), 'Tab/空格混用应被检出');
});

test('纯 Tab 或纯空格缩进不误报（零误报）', () => {
  const allTabs = checkSyntax({ code: 'def f(x):\n\tif x > 0:\n\t\treturn 1\n\treturn 0\n', fileName: 'tabs2.py' });
  assert.deepEqual(allTabs.issues, [], '统一用 Tab 不应报错');

  const allSpaces = checkSyntax({ code: 'def f(x):\n    if x > 0:\n        return 1\n    return 0\n', fileName: 'spaces.py' });
  assert.deepEqual(allSpaces.issues, [], '统一用空格不应报错');
});

test('Python 小写 true/false/none 被检出（SYN004）', () => {
  const { issues } = checkSyntax({ code: 'def f(x):\n    if x == none:\n        return true\n    return false\n', fileName: 'lit.py' });
  const hits = issues.filter((item) => item.ruleId === 'SYN004');
  assert.ok(hits.length >= 3, 'none / true / false 应被检出');
});

test('拼写检查不误报注释与字符串中的示例文字（零误报）', () => {
  const code = [
    '// 例如：retrn 是错误写法，fuction 也是',
    'const note = "pritn retrn fuction";',
    'function ok() { return 1; }',
  ].join('\n');
  const { issues } = checkSyntax({ code, fileName: 'comment.js' });
  assert.deepEqual(issues, [], '注释与字符串中的拼写错误示例不应被检出');
});
