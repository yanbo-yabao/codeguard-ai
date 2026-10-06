'use strict';

/**
 * 运行时设置（选择大模型 / 填写密钥）测试
 * ---------------------------------------------------------------------------
 * 覆盖重点：
 *   1. 设置存储的白名单清洗、持久化位置与清除语义；
 *   2. /api/settings 完整链路：读取 → 保存 → 立即生效 → 测试连接 → 清除回退；
 *   3. 密钥**绝不以明文**出现在任何响应中。
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'codeguard-settings-'));
process.env.DATA_DIR = TMP_DATA_DIR;
process.env.LLM_PROVIDER = 'mock';
process.env.LOG_LEVEL = 'silent';

const test = require('node:test');
const assert = require('node:assert/strict');

const { start } = require('../src/server');
const settingsStore = require('../src/core/settings-store');

/** 启动一次测试用服务，返回请求助手 */
async function withServer(run) {
  const { server, port } = await start({ port: 0, host: '127.0.0.1', silent: true });
  const base = `http://127.0.0.1:${port}`;

  const request = async (pathname, options) => {
    const response = await fetch(base + pathname, options);
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, headers: response.headers, text, json };
  };

  const send = (pathname, method, body) =>
    request(pathname, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  try {
    await run({ base, request, send });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** 每个用例从干净状态开始 */
function reset() {
  settingsStore.clear();
  settingsStore.apply();
}

test('设置存储：只保留白名单字段，空值表示取消该项覆盖', () => {
  const cleaned = settingsStore.sanitize({
    llm: { provider: 'deepseek', model: 'deepseek-flash', apiKey: '   ', evil: 'drop-me' },
  });
  assert.deepEqual(cleaned, { llm: { provider: 'deepseek', model: 'deepseek-flash' } });
  assert.ok(!('evil' in cleaned.llm));
});

test('设置文件：固定落在 data/ 目录下（该目录已被 .gitignore 排除）', () => {
  assert.equal(settingsStore.filePath(), path.join(TMP_DATA_DIR, 'settings.json'));
});

test('GET /api/settings：返回供应商清单与脱敏后的当前状态', async () => {
  reset();
  await withServer(async ({ send }) => {
    const result = await send('/api/settings', 'GET');
    assert.equal(result.status, 200);
    assert.ok(result.json.providers.length >= 3);
    const keys = result.json.providers.map((item) => item.key);
    assert.ok(keys.includes('deepseek'));
    assert.ok(keys.includes('openai-compatible'));
    assert.ok(keys.includes('mock'));
    assert.equal(result.json.llm.provider, 'mock'); // 来自 LLM_PROVIDER=mock
    assert.ok(result.json.llm.available);
    // 绝不回传明文
    assert.ok(!('apiKey' in result.json.llm));
  });
});

test('POST /api/settings：保存后立即生效，且响应中不含明文密钥', async () => {
  reset();
  const SECRET = 'sk-unit-test-abcdefghijklmnop';
  await withServer(async ({ send }) => {
    const saved = await send('/api/settings', 'POST', {
      provider: 'deepseek',
      model: 'deepseek-flash',
      baseUrl: 'https://api.deepseek.com',
      apiKey: SECRET,
    });

    assert.equal(saved.status, 200);
    assert.equal(saved.json.llm.provider, 'deepseek');
    assert.equal(saved.json.llm.providerLabel, 'DeepSeek 官方');
    assert.equal(saved.json.llm.available, true);
    assert.equal(saved.json.llm.apiKeySource, 'settings');
    assert.equal(saved.json.overrides.hasApiKey, true);

    // 关键安全断言：明文密钥不得出现在响应体任何位置
    assert.ok(!saved.text.includes(SECRET), '响应体不得包含明文密钥');
    assert.ok(saved.json.llm.apiKeyMasked.startsWith('sk-u'));
    assert.ok(saved.json.llm.apiKeyMasked.endsWith('mnop'));

    // 设置已落盘
    assert.ok(fs.existsSync(settingsStore.filePath()));
    const onDisk = JSON.parse(fs.readFileSync(settingsStore.filePath(), 'utf8'));
    assert.equal(onDisk.llm.apiKey, SECRET);
  });
});

test('POST /api/settings：密钥留空时沿用已保存的值（改模型不必重贴密钥）', async () => {
  reset();
  const SECRET = 'sk-keep-me-0123456789abcd';
  await withServer(async ({ send }) => {
    await send('/api/settings', 'POST', { provider: 'deepseek', apiKey: SECRET });
    const again = await send('/api/settings', 'POST', {
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      apiKey: '',
    });
    assert.equal(again.json.llm.model, 'deepseek-v4-pro');
    assert.equal(again.json.llm.apiKeySource, 'settings');
    assert.ok(again.json.llm.available, '沿用旧密钥后仍应可用');
    assert.ok(!again.text.includes(SECRET));
  });
});

test('POST /api/settings：apiKey 传 null 表示显式清除该覆盖', async () => {
  reset();
  await withServer(async ({ send }) => {
    await send('/api/settings', 'POST', { provider: 'deepseek', apiKey: 'sk-to-be-cleared-123456' });
    const cleared = await send('/api/settings', 'POST', { provider: 'deepseek', apiKey: null });
    assert.equal(cleared.json.overrides.hasApiKey, false);
  });
});

test('POST /api/settings/test：离线模拟器可连通', async () => {
  reset();
  await withServer(async ({ send }) => {
    const result = await send('/api/settings/test', 'POST', { provider: 'mock' });
    assert.equal(result.status, 200);
    assert.equal(result.json.ok, true);
  });
});

test('POST /api/settings/test：配置不完整时如实报错而不是抛异常', async () => {
  reset();
  await withServer(async ({ send }) => {
    const result = await send('/api/settings/test', 'POST', {
      provider: 'deepseek',
      apiKey: '',
      baseUrl: '',
      model: '',
    });
    assert.equal(result.status, 200);
    assert.equal(result.json.ok, false);
    assert.ok(typeof result.json.message === 'string' && result.json.message.length > 0);
  });
});

test('DELETE /api/settings：清除后回到环境变量默认值', async () => {
  reset();
  await withServer(async ({ send }) => {
    await send('/api/settings', 'POST', { provider: 'deepseek', apiKey: 'sk-temp-999999999999' });
    const after = await send('/api/settings', 'DELETE');

    assert.equal(after.status, 200);
    assert.equal(after.json.llm.provider, 'mock'); // 回到 LLM_PROVIDER=mock
    assert.equal(after.json.overrides.hasApiKey, false);
    assert.ok(!fs.existsSync(settingsStore.filePath()), '设置文件应已删除');
  });
});
