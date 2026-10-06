'use strict';

/**
 * 度量引擎测试
 * ---------------------------------------------------------------------------
 * 覆盖重点：函数识别的准确性（保留字排除、行号换算）与可维护性指数的数值行为。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { detectLanguage, splitCodeAndComments } = require('../src/analyzers/languages');
const { computeMetrics, findFunctions, cyclomaticComplexity, maxBraceDepth } = require('../src/analyzers/metrics');

/** 便捷构造度量输入 */
function metricsOf(code, fileName) {
  const profile = detectLanguage({ fileName, code });
  const parts = splitCodeAndComments(code, profile);
  return computeMetrics({ code, codeOnly: parts.code, commentOnly: parts.comments, profile });
}

test('findFunctions：识别命名函数并计算行数', () => {
  const code = ['function add(a, b) {', '  return a + b;', '}', ''].join('\n');
  const functions = findFunctions(code, detectLanguage({ fileName: 'a.js' }));

  assert.equal(functions.length, 1);
  assert.equal(functions[0].name, 'add');
  assert.equal(functions[0].startLine, 1);
  assert.equal(functions[0].endLine, 3);
  assert.equal(functions[0].params, 2);
});

test('findFunctions：控制流语句不得被误判为函数（回归）', () => {
  const code = ['function f(a) {', '  if (a > 0) {', '    return 1;', '  }', '  for (;;) {', '    break;', '  }', '}', ''].join('\n');
  const functions = findFunctions(code, detectLanguage({ fileName: 'a.js' }));

  assert.equal(functions.length, 1, `期望仅识别 1 个函数，实际识别到：${functions.map((fn) => fn.name).join(',')}`);
  assert.equal(functions[0].name, 'f');
});

test('findFunctions：模式含前置空白时行号不得偏移（回归）', () => {
  const code = ['// 注释占一行', 'const a = 1;', 'function g() {', '  return 1;', '}', ''].join('\n');
  const functions = findFunctions(code, detectLanguage({ fileName: 'a.js' }));

  assert.equal(functions.length, 1);
  assert.equal(functions[0].startLine, 3, '函数实际起始行应为第 3 行');
  assert.equal(functions[0].lines, 3);
});

test('findFunctions：缩进式语言按缩进判定函数边界', () => {
  const code = ['def f(a, b):', '    if a:', '        return b', '    return a', '', 'def g():', '    return 1', ''].join('\n');
  const functions = findFunctions(code, detectLanguage({ fileName: 'a.py' }));

  assert.equal(functions.length, 2);
  assert.equal(functions[0].name, 'f');
  assert.equal(functions[0].startLine, 1);
  assert.equal(functions[0].endLine, 4);
  assert.equal(functions[0].params, 2);
  assert.equal(functions[1].name, 'g');
  assert.equal(functions[1].startLine, 6);
});

test('cyclomaticComplexity：V(G) = 1 + 判定节点数', () => {
  const profile = detectLanguage({ fileName: 'a.js' });
  assert.equal(cyclomaticComplexity('return a;', profile), 1);
  assert.equal(cyclomaticComplexity('if (a) { return 1; }', profile), 2);
  assert.equal(cyclomaticComplexity('if (a && b) { return 1; }', profile), 3);
  assert.equal(cyclomaticComplexity('for (;;) { if (a) break; }', profile), 3);
});

test('maxBraceDepth：只统计语句块花括号，调用括号不计入（回归）', () => {
  // 链式调用产生很深的圆括号，但真实嵌套只有 1 层
  assert.equal(maxBraceDepth('Promise.all(urls.map(async (u) => { return u; }));'), 1);
  assert.equal(maxBraceDepth('{ { { } } }'), 3);
});

test('computeMetrics：注释率与代码行统计正确', () => {
  const code = ['// 注释一', '// 注释二', '', 'const a = 1;', 'const b = 2;', ''].join('\n');
  const metrics = metricsOf(code, 'a.js');

  assert.equal(metrics.totalLines, 6);
  assert.equal(metrics.commentLines, 2);
  assert.equal(metrics.codeLines, 2);
  assert.equal(metrics.blankLines, 2);
  // 有效行 4 行中 2 行为注释 → 0.5
  assert.equal(metrics.commentRatio, 0.5);
});

test('computeMetrics：最长函数、复杂度、嵌套深度', () => {
  const code = [
    'function small() { return 1; }',
    'function big(a) {',
    '  if (a) {',
    '    for (;;) {',
    '      if (a && a > 1) {',
    '        return a;',
    '      }',
    '    }',
    '  }',
    '  return 0;',
    '}',
    '',
  ].join('\n');
  const metrics = metricsOf(code, 'a.js');

  assert.equal(metrics.functionCount, 2);
  assert.equal(metrics.maxFunctionLength, 10);
  assert.equal(metrics.maxComplexity, 5); // 1 + if + for + if + &&
  assert.ok(metrics.maxNesting >= 3, `期望嵌套至少 3 层，实际 ${metrics.maxNesting}`);
});

test('computeMetrics：可维护性指数随规模增长而下降（回归：运算符优先级）', () => {
  const tiny = metricsOf('const a = 1;\n', 'a.js');
  const huge = metricsOf(['// 说明'].concat(Array.from({ length: 600 }, (_, i) => `const v${i} = ${i};`)).join('\n'), 'a.js');

  // 若三元运算符优先级处理有误，该指数会退化为与规模无关的固定值
  assert.ok(tiny.maintainabilityIndex > huge.maintainabilityIndex,
    `小文件指数(${tiny.maintainabilityIndex})应高于大文件(${huge.maintainabilityIndex})`);
  assert.ok(tiny.maintainabilityIndex <= 100 && tiny.maintainabilityIndex >= 0);
  assert.ok(huge.maintainabilityIndex >= 0);
});

test('computeMetrics：超长行与行尾空白统计', () => {
  const longLine = `const x = "${'a'.repeat(130)}";`;
  const code = `${longLine}\nconst y = 1;   \n`;
  const metrics = metricsOf(code, 'a.js');

  assert.equal(metrics.longLineCount, 1);
  assert.equal(metrics.maxLineLength, longLine.length);
  assert.equal(metrics.trailingWhitespaceCount, 1);
});

test('computeMetrics：TODO 标记计数来自注释区', () => {
  const code = ['// TODO 补充测试', 'const a = 1;', '/* FIXME 待重构 */', ''].join('\n');
  const metrics = metricsOf(code, 'a.js');

  assert.equal(metrics.todoCount, 2);
});
