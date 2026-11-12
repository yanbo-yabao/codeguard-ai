'use strict';

/**
 * 代码运行服务测试
 * ---------------------------------------------------------------------------
 * 覆盖：输出归一化、报错行号解析、变量名提取、JS 插桩、
 * 真实执行（run）、自动判题（judge）、逐行调试（debug）、超时熔断。
 * Python 用例在未检测到解释器时自动跳过。
 */

process.env.LOG_LEVEL = 'silent';

const test = require('node:test');
const assert = require('node:assert');

const { RunService, internals, PORTABLE_TOOL_PATHS } = require('../src/runners/runner-service');

const { normalizeOutput, parseErrorLine, extractVarNames, instrumentJs, execCode } = internals;

test('normalizeOutput：统一换行、去行尾空白与末尾空行（保留行首空白）', () => {
  assert.equal(normalizeOutput('a  \r\nb\n\n\n'), 'a\nb');
  assert.equal(normalizeOutput(' 3 \n'), ' 3');
  assert.equal(normalizeOutput(''), '');
});

test('工具链探测包含项目便携目录（部署时拷进 tools\\ 即用）', () => {
  assert.ok(PORTABLE_TOOL_PATHS.c.some((item) => item.includes('tools') && item.endsWith('gcc.exe')));
  assert.ok(PORTABLE_TOOL_PATHS.cpp.some((item) => item.endsWith('g++.exe')));
  assert.ok(PORTABLE_TOOL_PATHS.java.every((item) => item.endsWith('bin')));
});

test('parseErrorLine：识别 JS 与 Python 报错行号', () => {
  assert.equal(parseErrorLine('at Object.<anonymous> (/tmp/x/main.js:2:9)'), 2);
  assert.equal(parseErrorLine('  File "main.py", line 5\n    x ='), 5);
  assert.equal(parseErrorLine('some random text'), null);
});

test('extractVarNames：提取声明的变量与函数名', () => {
  const names = extractVarNames('let a = 1;\nconst b = 2;\nfunction foo() { var c; }');
  assert.deepEqual([...names].sort(), ['a', 'b', 'c', 'foo']);
});

test('instrumentJs：为可执行行插入调试探针', () => {
  const { code } = instrumentJs('let sum = 0;\n// 注释\nconsole.log(sum);');
  assert.ok(code.includes('__cg_dbg__(1,'), '第 1 行应有探针');
  assert.ok(code.includes('__cg_dbg__(3,'), '第 3 行应有探针');
  assert.ok(!code.includes('__cg_dbg__(2,'), '注释行不插探针');
});

test('run：JavaScript 真实执行并读写标准输入输出', async () => {
  const service = new RunService();
  const result = await service.run({
    language: 'javascript',
    code: "const d = require('fs').readFileSync(0,'utf8').trim().split(/\\s+/).map(Number);\nconsole.log(d[0] + d[1]);",
    stdin: '3 4\n',
  });
  assert.equal(result.ok, true);
  assert.equal(result.stdout.trim(), '7');
  assert.equal(result.error, null);
  assert.ok(result.durationMs >= 0);
});

test('run：运行报错时返回错误信息与行号', async () => {
  const service = new RunService();
  const result = await service.run({ language: 'javascript', code: 'const a = 1;\nthrow new Error("boom");', stdin: '' });
  assert.equal(result.ok, false);
  assert.ok(result.error && /boom/.test(result.error.message));
  assert.equal(result.error.line, 2);
});

test('judge：自动判题逐用例比对输出', async () => {
  const service = new RunService();
  const result = await service.judge({
    language: 'javascript',
    code: "const d = require('fs').readFileSync(0,'utf8').trim().split(/\\s+/).map(Number);\nconsole.log(d[0] + d[1]);",
    testCases: [
      { input: '1 2\n', expected: '3\n' },
      { input: '-5 5\n', expected: '1\n' },
      { input: '0 0\n', expected: '0\n' },
    ],
  });
  assert.equal(result.total, 3);
  assert.equal(result.passed, 2);
  assert.equal(result.allPassed, false);
  assert.equal(result.cases[0].ok, true);
  assert.equal(result.cases[1].ok, false);
  assert.equal(result.cases[1].actual.trim(), '0');
});

test('debug：JS 逐行跟踪返回执行顺序与变量快照', async () => {
  const service = new RunService();
  const result = await service.debug({
    language: 'javascript',
    code: 'let sum = 0;\nfor (let i = 1; i <= 3; i += 1) {\n  sum += i;\n}\nconsole.log(sum);',
    stdin: '',
  });
  assert.equal(result.ok, true);
  assert.equal(result.stdout.trim(), '6');
  assert.ok(result.trace.length >= 5, '应记录多步轨迹');
  const loopSteps = result.trace.filter((step) => step.line === 3);
  assert.equal(loopSteps.length, 3, '循环体所在行应记录 3 次执行');
  const last = result.trace[result.trace.length - 1];
  assert.ok(Object.keys(last.vars).length > 0, '变量快照不应为空');
});

test('run：死循环超时被强制终止', async () => {
  const result = await execCode({ language: 'javascript', code: 'while (true) {}', timeoutMs: 600 });
  assert.equal(result.timedOut, true);
  assert.equal(result.ok, false);
});

test('run：不支持的语言给出明确错误', async () => {
  const service = new RunService();
  const result = await service.run({ language: 'rust', code: 'fn main() {}', stdin: '' });
  assert.equal(result.ok, false);
  assert.ok(/暂不支持/.test(result.error.message));
});

/* ==================== C / C++ / Java（未安装编译器则跳过） ==================== */

const SUM_C = '#include <stdio.h>\nint main() {\n    int a, b;\n    scanf("%d %d", &a, &b);\n    printf("%d\\n", a + b);\n    return 0;\n}\n';
const SUM_CPP = '#include <iostream>\nusing namespace std;\nint main() {\n    long a, b;\n    cin >> a >> b;\n    cout << a + b << endl;\n    return 0;\n}\n';
const SUM_JAVA = 'import java.util.*;\npublic class Main {\n    public static void main(String[] args) {\n        Scanner sc = new Scanner(System.in);\n        long a = sc.nextLong();\n        long b = sc.nextLong();\n        System.out.println(a + b);\n    }\n}\n';

test('run：C 真实编译执行', { skip: !RunService.detect().c }, async () => {
  const service = new RunService();
  const result = await service.run({ language: 'c', code: SUM_C, stdin: '3 4\n' });
  assert.equal(result.ok, true);
  assert.equal(result.stdout.trim(), '7');
});

test('run：C++ 真实编译执行 + 判题', { skip: !RunService.detect().cpp }, async () => {
  const service = new RunService();
  const judge = await service.judge({
    language: 'cpp',
    code: SUM_CPP,
    testCases: [
      { input: '1 2\n', expected: '3\n' },
      { input: '-5 5\n', expected: '1\n' },
    ],
  });
  assert.equal(judge.passed, 1);
  assert.equal(judge.allPassed, false);
  assert.equal(judge.cases[1].actual.trim(), '0');
});

test('run：Java 真实编译执行', { skip: !RunService.detect().java }, async () => {
  const service = new RunService();
  const result = await service.run({ language: 'java', code: SUM_JAVA, stdin: '3 4\n' });
  assert.equal(result.ok, true);
  assert.equal(result.stdout.trim(), '7');
});

test('debug：C 逐行跟踪返回执行轨迹（循环行多次执行）', { skip: !RunService.detect().c }, async () => {
  const service = new RunService();
  const result = await service.debug({
    language: 'c',
    code: '#include <stdio.h>\nint main() {\n    int s = 0;\n    for (int i = 1; i <= 3; i++) {\n        s += i;\n    }\n    printf("%d\\n", s);\n    return 0;\n}\n',
    stdin: '',
  });
  assert.equal(result.ok, true);
  assert.equal(result.stdout.trim(), '6');
  assert.ok(result.trace.length >= 5, '应记录多步轨迹');
  assert.equal(result.trace.filter((step) => step.line === 5).length, 3, '循环体应记录 3 次执行');
});

test('debug：Java 逐行跟踪返回执行轨迹', { skip: !RunService.detect().java }, async () => {
  const service = new RunService();
  const result = await service.debug({
    language: 'java',
    code: 'public class Main {\n    public static void main(String[] args) {\n        int s = 0;\n        for (int i = 1; i <= 3; i++) {\n            s += i;\n        }\n        System.out.println(s);\n    }\n}\n',
    stdin: '',
  });
  assert.equal(result.ok, true);
  assert.ok(result.trace.length >= 5);
});

test('run：编译失败时返回编译错误与行号', { skip: !RunService.detect().cpp }, async () => {
  const service = new RunService();
  const result = await service.run({ language: 'cpp', code: 'int main() { return x; }', stdin: '' });
  assert.equal(result.ok, false);
  assert.ok(/error|错误/i.test(result.error.message));
  assert.equal(result.error.line, 1);
});

/* ==================== Python（未安装则跳过） ==================== */

const python = RunService.findPython();

test('run：Python 真实执行', { skip: !python }, async () => {
  const service = new RunService();
  const result = await service.run({ language: 'python', code: 'a, b = map(int, input().split())\nprint(a + b)', stdin: '3 4\n' });
  assert.equal(result.ok, true);
  assert.equal(result.stdout.trim(), '7');
});

test('debug：Python 逐行跟踪返回变量快照（不含内部变量）', { skip: !python }, async () => {
  const service = new RunService();
  const result = await service.debug({
    language: 'python',
    code: 'total = 0\nfor i in range(3):\n    total += i\nprint(total)',
    stdin: '',
  });
  assert.equal(result.ok, true);
  assert.ok(result.trace.length >= 4);
  const names = result.trace.flatMap((step) => Object.keys(step.vars));
  assert.ok(!names.includes('__builtins__'), '内部变量不应出现在快照中');
  assert.ok(names.includes('total'), '用户变量应出现在快照中');
});
