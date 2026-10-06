'use strict';

/**
 * 大模型客户端测试
 * ---------------------------------------------------------------------------
 * 覆盖重点：非标准 JSON 输出的容错解析、指数退避重试、超时控制，
 * 以及离线模拟器的确定性（保证测试与断网演示可复现）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { LlmClient, parseJsonLoose } = require('../src/agents/llm-client');
const { buildSummaryPrompt, buildReviewPrompt } = require('../src/agents/prompt-templates');

/**
 * 启动一个本地模拟接口服务
 * @param {Function} handler 请求处理函数 `(req, res, count) => void`
 * @returns {Promise<{server:import('http').Server, port:number, url:string, requests:Function}>}
 */
function startMockServer(handler) {
  return new Promise((resolve) => {
    let count = 0;
    const server = http.createServer((req, res) => {
      count += 1;
      handler(req, res, count);
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        url: `http://127.0.0.1:${server.address().port}`,
        requests: () => count,
      });
    });
  });
}

/** 生成一个合法的 OpenAI 兼容响应体 */
function chatResponse(content) {
  return JSON.stringify({
    model: 'mock-model',
    choices: [{ index: 0, message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  });
}

test('parseJsonLoose：直接 JSON、代码块包裹、前后缀文本三种形态均可解析', () => {
  assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonLoose('```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(parseJsonLoose('好的，结果如下：\n{"a":3}\n希望有帮助。'), { a: 3 });
  assert.deepEqual(parseJsonLoose('```\n{"a":4}\n```'), { a: 4 });
});

test('parseJsonLoose：无法解析时抛出携带预览的错误', () => {
  assert.throws(() => parseJsonLoose('完全不是 JSON'), (error) => {
    assert.equal(error.code, 'LLM_ERROR');
    assert.ok(error.details.preview.length > 0);
    return true;
  });
  assert.throws(() => parseJsonLoose(''), /返回内容为空/);
});

test('LlmClient：缺少密钥时 available 为 false 且拒绝调用', async () => {
  const client = new LlmClient({ provider: 'openai-compatible', apiKey: '', baseUrl: 'http://x', model: 'm' });
  assert.equal(client.available, false);
  await assert.rejects(() => client.chat({ messages: [] }), (error) => {
    assert.equal(error.code, 'CONFIG_ERROR');
    return true;
  });
});

test('LlmClient：正常调用返回内容与 token 用量统计', async () => {
  const mock = await startMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(chatResponse('{"ok":true}'));
  });

  try {
    const client = new LlmClient({
      provider: 'openai-compatible',
      apiKey: 'test-key',
      baseUrl: mock.url,
      model: 'mock-model',
    });

    const result = await client.chatJson({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(result.ok, true);
    assert.equal(result._meta.model, 'mock-model');
    assert.equal(result._meta.usage.totalTokens, 30);
    assert.equal(client.usage.calls, 1);
    assert.equal(client.usage.totalTokens, 30);
  } finally {
    mock.server.close();
  }
});

test('LlmClient：5xx 触发重试并在成功后返回结果', async () => {
  const mock = await startMockServer((req, res, count) => {
    if (count === 1) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end('{"error":"服务暂时不可用"}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(chatResponse('{"retried":true}'));
  });

  try {
    const client = new LlmClient({
      provider: 'openai-compatible',
      apiKey: 'k',
      baseUrl: mock.url,
      model: 'm',
      maxRetries: 2,
    });

    const result = await client.chatJson({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(result.retried, true);
    assert.equal(result._meta.attempt, 1, '第二次尝试才成功');
    assert.equal(mock.requests(), 2);
  } finally {
    mock.server.close();
  }
});

test('LlmClient：401 属于不可重试错误，立即失败', async () => {
  const mock = await startMockServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end('{"error":"invalid api key"}');
  });

  try {
    const client = new LlmClient({
      provider: 'openai-compatible',
      apiKey: 'bad',
      baseUrl: mock.url,
      model: 'm',
      maxRetries: 3,
    });

    await assert.rejects(() => client.chat({ messages: [{ role: 'user', content: 'hi' }] }), (error) => {
      assert.equal(error.code, 'LLM_ERROR');
      assert.equal(error.details.status, 401);
      return true;
    });
    assert.equal(mock.requests(), 1, '不可重试错误不应重复请求');
    assert.equal(client.usage.failures, 1);
  } finally {
    mock.server.close();
  }
});

test('LlmClient：请求超时被中止并抛出可读错误', async () => {
  const mock = await startMockServer(() => {
    /* 故意不响应，触发客户端超时 */
  });

  try {
    const client = new LlmClient({
      provider: 'openai-compatible',
      apiKey: 'k',
      baseUrl: mock.url,
      model: 'm',
      timeoutMs: 300,
      maxRetries: 0,
    });

    await assert.rejects(() => client.chat({ messages: [{ role: 'user', content: 'hi' }] }), (error) => {
      assert.equal(error.code, 'LLM_ERROR');
      assert.match(error.message, /超时/);
      return true;
    });
  } finally {
    mock.server.close();
  }
});

test('LlmClient：输出被 max_tokens 截断时给出可操作的精确诊断', async () => {
  const mock = await startMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      model: 'reasoning-model',
      choices: [{ index: 0, message: { role: 'assistant', content: '{"summary":"被截断的半截' }, finish_reason: 'length' }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 4096,
        total_tokens: 4196,
        completion_tokens_details: { reasoning_tokens: 3800 },
      },
    }));
  });

  try {
    const client = new LlmClient({
      provider: 'openai-compatible',
      apiKey: 'k',
      baseUrl: mock.url,
      model: 'reasoning-model',
      maxRetries: 3,
    });

    await assert.rejects(
      () => client.chat({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 4096 }),
      (error) => {
        assert.equal(error.code, 'LLM_ERROR');
        assert.match(error.message, /max_tokens（4096）截断/);
        assert.match(error.message, /REVIEW_MAX_TOKENS/);
        assert.equal(error.details.reasoningTokens, 3800);
        assert.equal(error.details.finishReason, 'length');
        return true;
      },
    );
    // 截断属于语义错误，重试无法解决，应只请求一次
    assert.equal(mock.requests(), 1);
    assert.equal(client.usage.reasoningTokens, 3800, '推理 token 用量应被统计');
  } finally {
    mock.server.close();
  }
});

test('LlmClient：正文为空时给出明确错误而非沉默', async () => {
  const mock = await startMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      model: 'm',
      choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 },
    }));
  });

  try {
    const client = new LlmClient({ provider: 'openai-compatible', apiKey: 'k', baseUrl: mock.url, model: 'm' });
    await assert.rejects(() => client.chat({ messages: [{ role: 'user', content: 'hi' }] }), /返回内容为空/);
  } finally {
    mock.server.close();
  }
});

test('离线模拟器：同一输入产出确定性结果', async () => {
  const client = new LlmClient({ provider: 'mock' });
  assert.equal(client.available, true);
  assert.equal(client.isMock, true);

  const messages = buildReviewPrompt({
    role: 'security',
    code: 'const API_KEY = "sk-abcdef123456";\neval(x);\n',
    language: 'JavaScript',
  });

  const first = await client.chatJson({ messages });
  const second = await client.chatJson({ messages });

  assert.deepEqual(first.findings, second.findings, '模拟器输出必须完全一致');
  assert.ok(first.findings.length >= 2);
  assert.ok(first.findings.every((item) => item.line >= 1 && item.title && item.message));
});

test('离线模拟器：识别总结类请求并返回汇报结构', async () => {
  const client = new LlmClient({ provider: 'mock' });
  const messages = buildSummaryPrompt({
    score: { overall: 62, grade: 'C', dimensions: { security: '50', bug: '80' } },
    issues: [
      { severity: 'blocker', line: 12, title: '硬编码凭据' },
      { severity: 'major', line: 30, title: '循环内串行等待' },
    ],
    metrics: { totalLines: 100, functionCount: 5, maxComplexity: 8 },
  });

  const payload = await client.chatJson({ messages });
  assert.ok(typeof payload.overview === 'string' && payload.overview.length > 0);
  assert.ok(Array.isArray(payload.blockers));
  assert.ok(payload.blockers.some((item) => item.includes('硬编码凭据')));
  assert.ok(Array.isArray(payload.actions));
});

test('离线模拟器：调用会计入用量统计但不产生 token 消耗', async () => {
  const client = new LlmClient({ provider: 'mock' });
  await client.chat({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(client.usage.calls, 0, '模拟器不消耗真实 token，故不计入远程调用次数');
  assert.equal(client.usage.failures, 0);
});
