'use strict';

/**
 * HTTP 接口集成测试
 * ---------------------------------------------------------------------------
 * 覆盖重点：完整请求-响应链路、状态码语义、错误码约定、静态资源服务与路径穿越防御。
 * 服务以随机端口启动（port: 0），避免与其他测试或本地实例冲突。
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'codeguard-api-'));
process.env.DATA_DIR = TMP_DATA_DIR;
process.env.LLM_PROVIDER = 'mock';
process.env.LOG_LEVEL = 'silent';

const test = require('node:test');
const assert = require('node:assert/strict');

const { start } = require('../src/server');

/** 启动一次测试用服务，返回请求助手 */
async function withServer(run) {
  const { server, port } = await start({ port: 0, host: '127.0.0.1', silent: true });
  const base = `http://127.0.0.1:${port}`;

  const request = async (pathname, options) => {
    const response = await fetch(base + pathname, options);
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: response.status, headers: response.headers, text, json };
  };

  try {
    await run({ base, request });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('GET /api/meta/health：返回健康状态与环境自检明细', async () => {
  await withServer(async ({ request }) => {
    const result = await request('/api/meta/health');
    assert.equal(result.status, 200);
    assert.equal(result.json.status, 'ok');
    assert.ok(Array.isArray(result.json.checks));
    assert.ok(result.json.checks.some((item) => item.name === 'Node.js 版本'));
    assert.ok(result.json.memoryMB >= 0);
  });
});

test('GET /api/meta/config：密钥被脱敏，绝不下发原始值', async () => {
  await withServer(async ({ request }) => {
    const result = await request('/api/meta/config');
    assert.equal(result.status, 200);
    assert.ok(result.json.app.version);
    assert.ok(result.json.llm.providerLabel);
    assert.ok(!Object.prototype.hasOwnProperty.call(result.json.llm, 'apiKey'), '不得下发原始密钥字段');
    assert.ok(result.json.runtime.node.startsWith('v'));
  });
});

test('GET /api/meta/rules：返回完整规则清单与分类字典', async () => {
  await withServer(async ({ request }) => {
    const result = await request('/api/meta/rules');
    assert.equal(result.status, 200);
    assert.ok(result.json.total >= 40);
    assert.equal(result.json.rules.length, result.json.total);
    assert.equal(result.json.dimensions.length, 5);
    assert.equal(result.json.severities.length, 5);
  });
});

test('GET /api/meta/routes：接口清单可供交付评审核对', async () => {
  await withServer(async ({ request }) => {
    const result = await request('/api/meta/routes');
    assert.equal(result.status, 200);
    assert.ok(result.json.routes.length >= 10);
    assert.ok(result.json.routes.every((route) => route.path.startsWith('/api')));
  });
});

test('GET /api/meta/languages 与 /api/meta/formats', async () => {
  await withServer(async ({ request }) => {
    const languages = await request('/api/meta/languages');
    assert.equal(languages.status, 200);
    assert.ok(languages.json.languages.some((item) => item.key === 'javascript'));

    const formats = await request('/api/meta/formats');
    assert.equal(formats.status, 200);
    assert.ok(formats.json.formats.includes('sarif'));
  });
});

test('GET /api/version：返回应用与运行时版本', async () => {
  await withServer(async ({ request }) => {
    const result = await request('/api/version');
    assert.equal(result.status, 200);
    assert.equal(result.json.name, 'codeguard-ai');
    assert.ok(result.json.node.startsWith('v'));
  });
});

test('POST /api/reviews：发起评审并返回完整结果（201）', async () => {
  await withServer(async ({ request }) => {
    const result = await request('/api/reviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: 'const API_KEY = "sk-abcdef1234567890";\nfunction f(a, b) { return a / b; }\n',
        fileName: 'demo.js',
        title: '接口测试',
        includeFixes: false,
      }),
    });

    assert.equal(result.status, 201);
    assert.match(result.json.id, /^rv_/);
    assert.equal(result.json.source.title, '接口测试');
    assert.ok(result.json.score.overall < 100);
    assert.ok(result.json.issues.length > 0);
    assert.ok(result.json.stats.issueCount === result.json.issues.length);
    assert.ok(typeof result.json.fixCount === 'number');

    // 记录可被检索
    const detail = await request(`/api/reviews/${result.json.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.id, result.json.id);

    // 列表包含该记录
    const list = await request('/api/reviews');
    assert.equal(list.status, 200);
    assert.ok(list.json.items.some((item) => item.id === result.json.id));
  });
});

test('POST /api/reviews：参数非法时返回 400 与稳定错误码', async () => {
  await withServer(async ({ request }) => {
    const empty = await request('/api/reviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '   ' }),
    });
    assert.equal(empty.status, 400);
    assert.equal(empty.json.error.code, 'VALIDATION_ERROR');

    const malformed = await request('/api/reviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '不是 JSON',
    });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.json.error.code, 'VALIDATION_ERROR');
  });
});

test('GET /api/reviews/:id/report：四种导出格式均可用', async () => {
  await withServer(async ({ request }) => {
    const created = await request('/api/reviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'const API_KEY = "sk-abcdef123";\n', fileName: 'a.js', useLlm: false }),
    });
    const id = created.json.id;

    const expectations = [
      ['json', /application\/json/],
      ['markdown', /text\/markdown/],
      ['html', /text\/html/],
      ['sarif', /application\/json/],
    ];
    for (const [format, contentType] of expectations) {
      const result = await request(`/api/reviews/${id}/report?format=${format}`);
      assert.equal(result.status, 200, `${format} 导出应返回 200`);
      assert.match(result.headers.get('content-type'), contentType);
      assert.ok(result.text.length > 0);
      assert.match(result.headers.get('content-disposition') || '', /filename=/);
    }

    // 不支持的格式
    const invalid = await request(`/api/reviews/${id}/report?format=xlsx`);
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.error.code, 'VALIDATION_ERROR');

    // 附件下载模式
    const download = await request(`/api/reviews/${id}/report?format=html&download=1`);
    assert.match(download.headers.get('content-disposition'), /attachment/);
  });
});

test('GET /api/reviews/:id/fixes：返回该次评审的修复建议', async () => {
  await withServer(async ({ request }) => {
    const created = await request('/api/reviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'const API_KEY = "sk-abcdef123";\n', fileName: 'a.js', useLlm: false, fixLimit: 3 }),
    });

    const fixes = await request(`/api/reviews/${created.json.id}/fixes`);
    assert.equal(fixes.status, 200);
    assert.ok(Array.isArray(fixes.json.fixes));
    assert.equal(fixes.json.total, fixes.json.fixes.length);
    assert.ok(fixes.json.fixes.length > 0, '应至少为硬编码凭据生成一条修复建议');
  });
});

test('DELETE /api/reviews/:id：删除成功与重复删除的语义', async () => {
  await withServer(async ({ request }) => {
    const created = await request('/api/reviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'const a = 1;\n', fileName: 'a.js', useLlm: false, includeFixes: false }),
    });
    const id = created.json.id;

    const deleted = await request(`/api/reviews/${id}`, { method: 'DELETE' });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.json.deleted, true);

    const again = await request(`/api/reviews/${id}`, { method: 'DELETE' });
    assert.equal(again.status, 404);
    assert.equal(again.json.error.code, 'NOT_FOUND');
  });
});

test('GET /api/meta/overview：概览统计随评审次数更新', async () => {
  await withServer(async ({ request }) => {
    const before = await request('/api/meta/overview');
    assert.equal(before.status, 200);

    await request('/api/reviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'const a = 1;\n', fileName: 'a.js', useLlm: false, includeFixes: false }),
    });

    const after = await request('/api/meta/overview');
    assert.equal(after.json.totalReviews, before.json.totalReviews + 1);
  });
});

test('错误处理：404 / 405 / 路径穿越均被正确拦截', async () => {
  await withServer(async ({ request }) => {
    const notFound = await request('/api/not-exist');
    assert.equal(notFound.status, 404);
    assert.equal(notFound.json.error.code, 'ROUTE_NOT_FOUND');

    const wrongMethod = await request('/api/reviews', { method: 'PUT', body: '{}' });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.json.error.code, 'METHOD_NOT_ALLOWED');
    assert.ok(wrongMethod.headers.get('allow'));

    const missing = await request('/api/reviews/not-exist-id');
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error.code, 'NOT_FOUND');

    // 路径穿越：应返回 404 而不是泄露文件内容
    const traversal = await request('/../package.json');
    assert.ok([400, 404].includes(traversal.status), `路径穿越应被拦截，实际 ${traversal.status}`);
    assert.ok(!traversal.text.includes('"dependencies"'), '不应泄露项目文件内容');
  });
});

test('静态资源：首页与前端资源可正常访问，且带缓存头', async () => {
  await withServer(async ({ request }) => {
    const index = await request('/');
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);
    assert.ok(index.text.includes('CodeGuard'));

    const script = await request('/assets/app.js');
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /javascript/);

    const stylesheet = await request('/assets/style.css');
    assert.equal(stylesheet.status, 200);
    assert.match(stylesheet.headers.get('content-type'), /text\/css/);

    // 条件请求应命中 304
    const etag = stylesheet.headers.get('etag');
    assert.ok(etag, '静态资源应带 ETag');
    const cached = await request('/assets/style.css', { headers: { 'If-None-Match': etag } });
    assert.equal(cached.status, 304);
  });
});

test('安全响应头与请求追踪 ID 已启用', async () => {
  await withServer(async ({ request }) => {
    const result = await request('/api/version');
    assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(result.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(result.headers.get('access-control-allow-origin'), '*');
    assert.match(result.headers.get('x-request-id') || '', /^req_/);
  });
});

test.after(() => {
  try {
    fs.rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch {
    /* 忽略清理失败 */
  }
});
