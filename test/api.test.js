'use strict';

/**
 * HTTP API 集成测试
 * ---------------------------------------------------------------------------
 * 覆盖：元信息 / 设置只读 / 解题补全 / 变式出题 / 错误修复 / 代码运行（run·judge·debug）/
 * 参数校验 / 404 拦截 / 静态页面。
 */

process.env.LLM_PROVIDER = 'mock';
process.env.LOG_LEVEL = 'silent';

const test = require('node:test');
const assert = require('node:assert');

const { buildRoutes } = require('../src/routes');
const { createHttpServer } = require('../src/core/http/app');

/** 启动临时服务并执行测试体 */
async function withServer(fn) {
  const { router } = buildRoutes();
  const server = createHttpServer({ router });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('元信息接口：version / health / config / rules / routes / languages', async () => {
  await withServer(async (base) => {
    const version = await (await fetch(`${base}/api/version`)).json();
    assert.equal(version.name, 'codeguard-ai');

    const health = await (await fetch(`${base}/api/meta/health`)).json();
    assert.ok(['ok', 'degraded'].includes(health.status));
    assert.ok(Array.isArray(health.checks));

    const config = await (await fetch(`${base}/api/meta/config`)).json();
    assert.ok(config && typeof config === 'object');

    const rules = await (await fetch(`${base}/api/meta/rules`)).json();
    assert.ok(Array.isArray(rules.rules) && rules.rules.length > 0);

    const routes = await (await fetch(`${base}/api/meta/routes`)).json();
    const paths = routes.routes.map((item) => item.path);
    assert.ok(paths.includes('/api/completions'));
    assert.ok(paths.includes('/api/run'));
    assert.ok(!paths.some((item) => item.includes('/api/reviews')), '审查接口必须已下线');

    const languages = await (await fetch(`${base}/api/meta/languages`)).json();
    assert.ok(Array.isArray(languages.languages) && languages.languages.length > 0);
  });
});

test('设置接口：GET 返回脱敏快照与供应商清单（不返回明文密钥）', async () => {
  await withServer(async (base) => {
    const snapshot = await (await fetch(`${base}/api/settings`)).json();
    assert.ok(Array.isArray(snapshot.providers) && snapshot.providers.length >= 12);
    assert.ok(snapshot.providers.every((item) => item.key && item.label && item.baseUrlHint !== undefined));
    assert.ok(!JSON.stringify(snapshot).match(/sk-[A-Za-z0-9]{8,}/), '快照不得包含明文密钥');
  });
});

test('解题与补全：返回解题讲解与完整代码（离线模拟，结果诚实标注）', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feature: 'complete', prompt: '帮我写一个 hello world 程序', language: 'javascript' }),
    });
    assert.equal(res.status, 201);
    const result = await res.json();
    assert.equal(result.feature, 'complete');
    assert.ok(typeof result.answer === 'string');
    assert.ok(result.completedCode === null || typeof result.completedCode === 'string');
    assert.ok(['llm', 'template', 'mock', 'none'].includes(result.completionSource));
    assert.ok(result.warnings.length > 0, '离线模式必须有诚实提示');
    assert.ok(result.summary && typeof result.summary.text === 'string');
  });
});

test('变式出题：返回题面、测试用例与参考答案', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feature: 'quiz', prompt: '两数之和', language: 'python' }),
    });
    assert.equal(res.status, 201);
    const result = await res.json();
    assert.equal(result.feature, 'quiz');
    assert.ok(result.quiz && result.quiz.title);
    assert.ok(Array.isArray(result.quiz.testCases) && result.quiz.testCases.length >= 1);
    assert.ok(typeof result.quiz.referenceSolution === 'string');
    assert.ok(result.quiz.testCases.every((item) => typeof item.input === 'string' && typeof item.expected === 'string'));
  });
});

test('错误检查与修复：返回问题清单结构与降级说明', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feature: 'fix', code: 'def f(:\n    pass\n', language: 'python' }),
    });
    assert.equal(res.status, 201);
    const result = await res.json();
    assert.equal(result.feature, 'fix');
    assert.ok(Array.isArray(result.issues));
    assert.equal(result.completedCode, null);
    assert.ok(result.engines.static === true);
  });
});

test('代码测试·离线静态检查：useLlm=false 不调大模型，问题逐条带修改建议', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        feature: 'fix',
        code: '#include<stdio.h>\nint main()\n{\n    reut 0;\n}\n',
        language: 'c',
        useLlm: false,
      }),
    });
    assert.equal(res.status, 201);
    const result = await res.json();
    assert.equal(result.engines.llm, false, '离线检查不得调用大模型');
    assert.equal(result.summary.offline, true);
    assert.ok(result.issues.length > 0, '错误代码必须能查出问题');
    assert.ok(
      result.issues.every((item) => typeof item.suggestion === 'string' && item.suggestion.trim()),
      '每条问题必须带非空修改建议',
    );
  });
});

test('参数校验：非法 feature / 非法图片 / 空输入均返回 400', async () => {
  await withServer(async (base) => {
    const post = (body) => fetch(`${base}/api/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal((await post({ feature: 'unknown', prompt: 'x' })).status, 400);
    assert.equal((await post({ feature: 'complete', prompt: 'x', image: 'not-a-data-url' })).status, 400);
    assert.equal((await post({})).status, 400);
  });
});

test('代码运行：run / judge / debug 三种模式均真实执行', async () => {
  await withServer(async (base) => {
    const post = (body) => fetch(`${base}/api/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const run = await (await post({
      mode: 'run',
      language: 'javascript',
      code: "const d = require('fs').readFileSync(0,'utf8').trim().split(/\\s+/).map(Number);\nconsole.log(d[0] + d[1]);",
      stdin: '3 4\n',
    })).json();
    assert.equal(run.ok, true);
    assert.equal(run.stdout.trim(), '7');

    const judge = await (await post({
      mode: 'judge',
      language: 'javascript',
      code: 'console.log(1 + 2);',
      testCases: [{ input: '', expected: '3\n' }],
    })).json();
    assert.equal(judge.allPassed, true);
    assert.equal(judge.passed, 1);

    const debug = await (await post({
      mode: 'debug',
      language: 'javascript',
      code: 'let s = 0;\nfor (let i = 0; i < 3; i += 1) s += i;\nconsole.log(s);',
    })).json();
    assert.equal(debug.ok, true);
    assert.ok(Array.isArray(debug.trace) && debug.trace.length > 0, '调试模式必须返回逐行轨迹');

    const env = await (await fetch(`${base}/api/run/env`)).json();
    assert.equal(env.languages.javascript.available, true);
    assert.ok(Array.isArray(env.runnable) && env.runnable.includes('cpp'));
  });
});

test('代码运行：参数非法返回 400', async () => {
  await withServer(async (base) => {
    const post = (body) => fetch(`${base}/api/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal((await post({ mode: 'run', language: 'rust', code: 'x' })).status, 400);
    assert.equal((await post({ mode: 'judge', language: 'javascript', code: 'x' })).status, 400);
    assert.equal((await post({ mode: 'run', language: 'javascript', code: '' })).status, 400);
  });
});

test('代码运行：C++ 判题（编译型语言，编译一次多用例执行）', async () => {
  await withServer(async (base) => {
    const env = await (await fetch(`${base}/api/run/env`)).json();
    if (!env.languages.cpp.available) return; // 本机无 g++ 时跳过
    const res = await fetch(`${base}/api/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'judge',
        language: 'cpp',
        code: '#include <iostream>\nusing namespace std;\nint main() {\n    long a, b;\n    cin >> a >> b;\n    cout << a + b << endl;\n    return 0;\n}\n',
        testCases: [
          { input: '1 2\n', expected: '3\n' },
          { input: '-5 5\n', expected: '0\n' },
        ],
      }),
    });
    const judge = await res.json();
    assert.equal(judge.allPassed, true);
    assert.equal(judge.passed, 2);
  });
});

test('错误处理：未知接口返回 404 且不泄露文件内容', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/not-exist`);
    assert.equal(res.status, 404);
    const body = await res.text();
    assert.ok(!body.includes('devDependencies'), '不得泄露 package.json 等文件内容');
  });
});

test('静态页面：首页包含三工作模式入口', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('AI 解题与补全'));
    assert.ok(html.includes('代码测试'));
    assert.ok(html.includes('错误检查与修复'));
    assert.ok(html.includes('quiz-section'), '变式题测试应内嵌在解题流程中');
    assert.ok(!html.includes('data-mode="review"'), '审查入口必须已移除');
  });
});
