'use strict';

/**
 * 真编译器语法检查测试（SYN006）
 * ---------------------------------------------------------------------------
 * 覆盖：用户实际遇到的漏报场景（C 代码 reut}）、C++/Java/Python 编译诊断、
 * 干净代码零误报。无对应工具链的用例自动跳过。
 */

process.env.LOG_LEVEL = 'silent';

const test = require('node:test');
const assert = require('node:assert');

const { compileCheck } = require('../src/analyzers/compile-checker');
const { RunService } = require('../src/runners/runner-service');

const tools = RunService.detect();

test('C：reut} 这类拼写/缺分号错误必须被真编译器查出（用户实际反馈的漏报）', { skip: !tools.c }, () => {
  const { issues, checkedBy } = compileCheck({
    code: '#include<stdio.h>\nint main()\n{\nreut}',
    language: 'c',
  });
  assert.equal(checkedBy.realCompiler, true);
  assert.ok(issues.length > 0, 'gcc 必须能查出这段代码的问题');
  assert.ok(issues.every((item) => item.ruleId === 'SYN006' && item.line >= 1));
  assert.ok(issues.some((item) => item.line === 4), '错误应定位到第 4 行');
  assert.ok(issues.some((item) => /reut|undeclared|未声明|expected/i.test(item.message)), '报错应指出 reut 问题');
  assert.ok(issues.every((item) => item.suggestion && item.suggestion.length > 0), '每条问题都要有修改建议');
});

test('C++：真编译器诊断（缺分号）', { skip: !tools.cpp }, () => {
  const { issues, checkedBy } = compileCheck({
    code: '#include <iostream>\nint main() {\n    int a = 1\n    return 0;\n}',
    language: 'cpp',
  });
  assert.equal(checkedBy.realCompiler, true);
  assert.ok(issues.length > 0);
  assert.ok(issues.some((item) => item.line === 3 || item.line === 4), '错误应定位到缺分号的第 3/4 行');
});

test('Java：真编译器诊断（未声明变量）', { skip: !tools.java }, () => {
  const { issues } = compileCheck({
    code: 'public class Main {\n    public static void main(String[] args) {\n        System.out.println(x);\n    }\n}',
    language: 'java',
  });
  assert.ok(issues.length > 0);
  assert.ok(issues.some((item) => item.line === 3));
});

test('Python：解析器诊断（缺冒号）', { skip: !tools.python }, () => {
  const { issues } = compileCheck({
    code: 'def f(a)\n    return a\n',
    language: 'python',
  });
  assert.ok(issues.length > 0);
  assert.ok(issues.some((item) => item.line === 1));
});

test('干净代码零误报：合法 C 程序不产生任何问题', { skip: !tools.c }, () => {
  const { issues } = compileCheck({
    code: '#include <stdio.h>\nint main(void) {\n    printf("hi\\n");\n    return 0;\n}\n',
    language: 'c',
  });
  assert.deepEqual(issues, [], '合法代码不得误报');
});

test('无工具链/不支持的语言：静默跳过不报错', () => {
  const { issues, checkedBy } = compileCheck({ code: 'x = 1', language: 'rust' });
  assert.deepEqual(issues, []);
  assert.equal(checkedBy.realCompiler, false);
});

test('错误修复流水线（离线）：用户样例 C 代码能查出问题', { skip: !tools.c }, async () => {
  process.env.LLM_PROVIDER = 'mock';
  const { CompletionService } = require('../src/services/completion-service');
  const service = new CompletionService();
  const result = await service.complete({
    feature: 'fix',
    code: '#include<stdio.h>\nint main()\n{\nreut}',
    language: 'c',
    useLlm: false,
  });
  assert.ok(result.issues.length > 0, '离线模式必须查出问题');
  assert.ok(result.engines.checkedBy.realCompiler === true, '应使用真编译器检查');
  assert.ok(result.issues.every((item) => item.suggestion), '每条问题都要有修改方法');
});
