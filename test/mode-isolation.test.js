'use strict';

/**
 * 前端工作模式结果隔离测试
 * ---------------------------------------------------------------------------
 * 用 DOM 桩驱动 web/assets/app.js 的真实交互逻辑，验证：
 *   1. 三个工作模式（解题补全 / 练习调试 / 错误修复）的结果互相独立，切换不串台
 *   2. 无结果的模式显示空状态，有结果的模式显示自己的结果
 *   3. 练习模式的运行/判题/调试结果只属于练习模式
 */

process.env.LLM_PROVIDER = 'mock';
process.env.LOG_LEVEL = 'silent';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

/* ==================== DOM 桩 ==================== */

const elements = new Map();

function makeElement() {
  const classes = new Set();
  return {
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle: (name, force) => {
        const want = force === undefined ? !classes.has(name) : Boolean(force);
        if (want) classes.add(name); else classes.delete(name);
        return want;
      },
      contains: (name) => classes.has(name),
    },
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    click() {},
    focus() {},
    textContent: '',
    innerHTML: '',
    value: '',
    checked: true,
    disabled: false,
    placeholder: '',
    className: '',
    dataset: {},
    files: [],
  };
}

function element(selector) {
  if (!elements.has(selector)) elements.set(selector, makeElement());
  return elements.get(selector);
}

global.document = {
  readyState: 'complete',
  querySelector: (selector) => element(selector),
  querySelectorAll: () => [],
  addEventListener() {},
};
global.window = global;
global.localStorage = { getItem: () => '1', setItem() {} };
global.fetch = async () => { throw new Error('offline in tests'); };
global.FileReader = class { readAsDataURL() {} };

const app = require(path.join(__dirname, '..', 'web', 'assets', 'app.js'));

/* ==================== 测试数据 ==================== */

const FIX_RESULT = {
  feature: 'fix',
  mode: 'fix',
  language: 'Python',
  languageKey: 'python',
  answer: null,
  completedCode: null,
  fixedCode: 'def f():\n    return 0\n',
  completionSource: 'none',
  notes: [],
  issues: [],
  summary: { text: '静态语法检查发现 1 处问题', offline: true },
  engines: { static: true, llm: false, confirmed: 0, checkedBy: {} },
  rag: { hits: [] },
  warnings: ['大模型未配置，仅返回静态语法检查结果。'],
  stats: { issueCount: 1, durationMs: 12 },
};

const COMPLETE_RESULT = {
  feature: 'complete',
  mode: 'generate',
  language: 'JavaScript',
  languageKey: 'javascript',
  answer: '1. 先读入两个数…',
  completedCode: 'console.log(1);\n',
  fixedCode: null,
  completionSource: 'mock',
  notes: ['离线占位'],
  issues: [],
  summary: { text: '已生成补全代码', offline: false },
  engines: { static: false, llm: true, confirmed: 0, checkedBy: {} },
  rag: { hits: [] },
  warnings: [],
  stats: { issueCount: 0, durationMs: 8 },
};

/* ==================== 用例 ==================== */

test('工作模式结果互相独立：切换模式不残留、不串台', () => {
  // 1. 渲染错误修复结果
  app.state.modeResults.fix = FIX_RESULT;
  app.showResultByMode('fix');
  assert.equal(element('#complete-code-title').textContent, '修复后的完整代码', '修复模式应展示修复代码标题');
  assert.ok(!element('#completion-body').classList.contains('hidden'));
  assert.ok(element('#answer-card').classList.contains('hidden'), '修复模式不显示解题讲解卡片');

  // 2. 切到解题补全（尚无结果）→ 显示空状态，不残留修复结果
  app.showResultByMode('complete');
  assert.ok(element('#completion-body').classList.contains('hidden'), '无结果的模式必须隐藏结果容器');
  assert.ok(!element('#empty-state').classList.contains('hidden'), '无结果的模式必须显示空状态');

  // 3. 解题补全有自己的结果后 → 显示自己的结果
  app.state.modeResults.complete = COMPLETE_RESULT;
  app.showResultByMode('complete');
  assert.ok(!element('#completion-body').classList.contains('hidden'));
  assert.equal(element('#complete-code-title').textContent, '完整代码', '补全模式应展示补全代码标题');
  assert.ok(!element('#answer-card').classList.contains('hidden'), '补全模式显示解题讲解卡片');

  // 4. 再切回修复模式 → 修复结果原样回来
  app.showResultByMode('fix');
  assert.equal(element('#complete-code-title').textContent, '修复后的完整代码');
  assert.ok(element('#answer-card').classList.contains('hidden'));
});

test('练习模式的运行结果只属于练习模式', () => {
  app.renderRunResult({ ok: true, language: 'javascript', stdout: '3\n', stderr: '', exitCode: 0, durationMs: 5, trace: [] });
  assert.ok(app.state.practiceRendered === true);
  assert.ok(!element('#run-card').classList.contains('hidden'));

  // 切到解题补全 → 练习结果不出现
  app.showResultByMode('complete');
  assert.ok(element('#practice-body').classList.contains('hidden'), '其他模式不得展示练习结果');

  // 切回练习 → 运行结果还在
  app.showResultByMode('practice');
  assert.ok(!element('#practice-body').classList.contains('hidden'));
  assert.ok(element('#empty-state').classList.contains('hidden'), '练习模式有结果时不再显示空状态');
});

test('判题与调试结果渲染进练习模式专属卡片', () => {
  app.renderJudgeResult({
    language: 'javascript', passed: 1, total: 2, allPassed: false,
    cases: [
      { index: 1, input: '1 2\n', expected: '3\n', actual: '3\n', ok: true, stderr: '', timedOut: false, durationMs: 3 },
      { index: 2, input: '-5 5\n', expected: '0\n', actual: '1\n', ok: false, stderr: '', timedOut: false, durationMs: 3 },
    ],
  });
  assert.ok(!element('#judge-card').classList.contains('hidden'));
  assert.equal(element('#judge-badge').textContent, '通过 1 / 2');

  app.renderDebugTrace({
    ok: true,
    trace: [
      { line: 1, vars: { sum: '0' } },
      { line: 2, vars: { sum: '1', i: '1' } },
      { line: 2, vars: { sum: '3', i: '2' } },
    ],
  });
  assert.ok(!element('#debug-card').classList.contains('hidden'));
  assert.equal(element('#debug-badge').textContent, '3 步');
  assert.ok(element('#debug-summary').textContent.includes('循环'), '摘要应提示按行聚合与循环次数');
});

test('解题流程内嵌的变式题测试与「代码测试」互不串台', () => {
  // 代码测试页已有判题结果（来自上一用例）
  assert.equal(element('#judge-badge').textContent, '通过 1 / 2');

  // 解题流程内嵌测试渲染到自己的卡片
  app.renderJudgeResult({
    language: 'javascript', passed: 5, total: 5, allPassed: true,
    cases: [{ index: 1, input: '', expected: '1', actual: '1', ok: true, stderr: '', timedOut: false, durationMs: 1 }],
  }, 'quiz');
  assert.ok(!element('#quiz-judge-card').classList.contains('hidden'));
  assert.equal(element('#quiz-judge-badge').textContent, '通过 5 / 5');
  assert.equal(element('#judge-badge').textContent, '通过 1 / 2', '代码测试页的结果不得被改写');

  app.renderRunResult({ ok: true, language: 'javascript', stdout: '9\n', stderr: '', exitCode: 0, durationMs: 3, trace: [] }, { ctx: 'quiz' });
  assert.ok(!element('#quiz-run-card').classList.contains('hidden'));
  assert.equal(element('#quiz-run-stdout').textContent, '9\n');
});

test('运行失败时错误信息醒目展示（红色警示横幅）', () => {
  app.renderRunResult({
    ok: false, language: 'c', stdout: '', stderr: "main.c:4: error: 'reut' undeclared",
    exitCode: 1, durationMs: 40,
    error: { message: "gcc 报错：'reut' undeclared", line: 4 },
  }, { ctx: 'quiz' });
  const banner = element('#quiz-run-error-banner');
  assert.ok(!banner.classList.contains('hidden'), '失败时必须显示警示横幅');
  assert.ok(banner.innerHTML.includes('第 <b>4</b> 行'), '横幅应高亮报错行号');
  assert.ok(element('#quiz-run-stderr').classList.contains('error-output'), '错误输出框应高亮');

  // 成功时横幅收起
  app.renderRunResult({ ok: true, language: 'c', stdout: '7\n', stderr: '', exitCode: 0, durationMs: 3, trace: [] }, { ctx: 'quiz' });
  assert.ok(element('#quiz-run-error-banner').classList.contains('hidden'));
  assert.ok(!element('#quiz-run-stderr').classList.contains('error-output'));
});

test('代码框行号栏：按行数生成行号并同步滚动', () => {
  const gutter = { childElementCount: 0, innerHTML: '', scrollTop: 0 };
  const fakeEditor = { querySelector: () => gutter };
  const textarea = { value: 'a\nb\nc', scrollTop: 20, closest: () => fakeEditor };

  app.refreshGutter(textarea);
  assert.equal((gutter.innerHTML.match(/<span>/g) || []).length, 3, '三行代码应生成三个行号');
  assert.ok(gutter.innerHTML.includes('>3<'), '最后一个行号应为 3');
  assert.equal(gutter.scrollTop, 20, '行号栏应同步滚动位置');

  // 行数不变时不重建（避免每次输入都重排）
  gutter.childElementCount = 3;
  gutter.innerHTML = 'KEEP';
  app.refreshGutter(textarea);
  assert.equal(gutter.innerHTML, 'KEEP');

  // 无 closest 的环境（如测试桩）静默跳过不报错
  app.refreshGutter({ value: 'x' });
});

test('代码格式化：单行代码自动换行并规范缩进', () => {
  const out = app.formatCode('int main() { reut; }', 'c');
  assert.equal(out, 'int main() {\n    reut;\n}');
});

test('代码格式化：for 循环括号内的分号不断行', () => {
  const out = app.formatCode('for (int i=0;i<3;i++) { s+=i; }', 'c');
  assert.equal(out, 'for (int i=0;i<3;i++) {\n    s+=i;\n}');
});

test('代码格式化：} else { 保持同行', () => {
  const out = app.formatCode('if (x) { a(); } else { b(); }', 'c');
  assert.ok(out.includes('} else {'), 'else 应与 } 保持同行');
  assert.equal(out.split('\n').length, 5);
});

test('代码格式化：字符串与注释内的符号不被切开', () => {
  const out = app.formatCode('printf("a;b{c}"); /* d;e */ x=1;', 'c');
  const lines = out.split('\n');
  assert.equal(lines[0], 'printf("a;b{c}");', '字符串内的 ; { } 不得引发断行');
  assert.ok(lines[1].includes('/* d;e */ x=1;'), '注释内的 ; 不得引发断行');
});

test('代码格式化：Python 只做空白规范化，不动缩进结构', () => {
  const out = app.formatCode('def f():\n\treturn 1  ', 'python');
  assert.equal(out, 'def f():\n    return 1');
});

test('代码格式化：同一组大括号换行后保持同一列（Allman 风格）', () => {
  const out = app.formatCode('#include<stdio.h>\nint main()\n{\nreut}', 'c');
  assert.equal(out, '#include<stdio.h>\nint main()\n{\n    reut\n}', '{ 与 } 必须同一列');
});

test('代码格式化：括号跨行时闭括号与开括号同列', () => {
  const out = app.formatCode('foo(\na,\nb\n);', 'c');
  assert.equal(out, 'foo(\n    a,\n    b\n   );', '( 与 ) 必须同一列，参数对齐到开括号后一列');
});

test('代码格式化：多层括号续行逐层对齐', () => {
  const out = app.formatCode('foo(\na,\nbar(\nb\n)\n);', 'c');
  assert.equal(out, 'foo(\n    a,\n    bar(\n        b\n       )\n   );');
});

test('写码时实时对齐：回车后新行的缩进列', () => {
  assert.equal(app.enterIndentCol('foo(a,'), 4, '括号内续行对齐开括号后一列');
  assert.equal(app.enterIndentCol('int main()'), 0, '普通语句沿用当前缩进');
  assert.equal(app.enterIndentCol('if (x) {'), 4, '{ 后加深一级');
  assert.equal(app.enterIndentCol('def f():'), 4, ': 后加深一级');
  assert.equal(app.enterIndentCol('int main()\n{\n    '), 4, '子块内沿用当前缩进');
  assert.equal(app.enterIndentCol('foo("a)b"'), 4, '字符串里的括号不算');
});

test('写码时实时对齐：输入闭括号时归位到配对括号的列', () => {
  assert.equal(app.closeAlignCol('int main()\n{\n    reut;\n', '}'), 0, '} 与 Allman 的 { 同列');
  assert.equal(app.closeAlignCol('int main() {\n    if (x) {\n', '}'), 4, '嵌套时对齐最近的 { 所在行');
  assert.equal(app.closeAlignCol('foo(\n    a,\n', ')'), 3, ') 与 ( 同列');
  assert.equal(app.closeAlignCol('x = [1,\n', ']'), 4, '] 与 [ 同列');
  assert.equal(app.closeAlignCol('console.log("]")\n', ']'), null, '字符串里的括号不构成配对');
});
