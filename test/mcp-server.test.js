'use strict';

/**
 * MCP 服务器测试
 * ---------------------------------------------------------------------------
 * 覆盖：协议握手、工具发现（5 工具）、review_code 下线引导、
 * complete_code / quiz_code / run_code 工具执行、未知方法错误码。
 * 使用真实服务（离线模拟大模型 + 真实代码执行），不依赖网络。
 */

process.env.LLM_PROVIDER = 'mock';
process.env.LOG_LEVEL = 'silent';

const test = require('node:test');
const assert = require('node:assert');

const { McpServer, TOOLS, PROTOCOL_VERSION } = require('../src/mcp/server');

/** 解析工具结果里的 JSON 文本 */
function parseContent(result) {
  assert.ok(result && Array.isArray(result.content) && result.content.length > 0);
  return JSON.parse(result.content[0].text);
}

test('initialize 握手返回协议版本与服务器信息', async () => {
  const server = new McpServer();
  const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.id, 1);
  assert.equal(response.result.protocolVersion, PROTOCOL_VERSION);
  assert.equal(response.result.serverInfo.name, 'codeguard-ai');
});

test('tools/list 返回 5 个工具且带参数 Schema', async () => {
  const server = new McpServer();
  const response = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = response.result.tools.map((item) => item.name);
  assert.deepEqual(names, ['complete_code', 'fix_code', 'quiz_code', 'run_code', 'list_rules']);
  for (const tool of TOOLS) {
    assert.ok(tool.description && tool.inputSchema, `工具 ${tool.name} 必须有描述与 Schema`);
    assert.equal(typeof tool.inputSchema, 'object');
  }
});

test('review_code 已下线：返回引导信息而不是审查结果', async () => {
  const server = new McpServer();
  const result = await server.callTool({ name: 'review_code', arguments: { code: 'x' } });
  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes('已下线'));
});

test('complete_code：解题与补全返回讲解与代码', async () => {
  const server = new McpServer();
  const result = await server.callTool({
    name: 'complete_code',
    arguments: { prompt: '写一个 hello world', language: 'javascript' },
  });
  assert.ok(!result.isError);
  const payload = parseContent(result);
  assert.equal(payload.feature, 'complete');
  assert.ok(typeof payload.answer === 'string');
  assert.ok(Array.isArray(payload.warnings));
});

test('quiz_code：返回变式题与测试用例', async () => {
  const server = new McpServer();
  const result = await server.callTool({ name: 'quiz_code', arguments: { prompt: '两数之和', language: 'python' } });
  assert.ok(!result.isError);
  const payload = parseContent(result);
  assert.ok(payload.quiz && payload.quiz.title);
  assert.ok(Array.isArray(payload.quiz.testCases));
});

test('run_code：真实执行并判题', async () => {
  const server = new McpServer();
  const result = await server.callTool({
    name: 'run_code',
    arguments: {
      code: 'console.log(1 + 2);',
      language: 'javascript',
      mode: 'judge',
      testCases: [{ input: '', expected: '3\n' }],
    },
  });
  assert.ok(!result.isError);
  const payload = parseContent(result);
  assert.equal(payload.allPassed, true);
  assert.equal(payload.passed, 1);
});

test('run_code：debug 模式返回逐行轨迹', async () => {
  const server = new McpServer();
  const result = await server.callTool({
    name: 'run_code',
    arguments: { code: 'let a = 1;\na += 1;\nconsole.log(a);', language: 'javascript', mode: 'debug' },
  });
  const payload = parseContent(result);
  assert.ok(Array.isArray(payload.trace) && payload.trace.length > 0);
});

test('list_rules 与未知工具的错误语义', async () => {
  const server = new McpServer();
  const rules = await server.callTool({ name: 'list_rules', arguments: {} });
  assert.ok(!rules.isError);
  const payload = parseContent(rules);
  assert.ok(Array.isArray(payload.rules) && payload.rules.length > 0);

  const unknown = await server.callTool({ name: 'nope', arguments: {} });
  assert.equal(unknown.isError, true);

  const unknownMethod = await server.handle({ jsonrpc: '2.0', id: 9, method: 'foo/bar' });
  assert.equal(unknownMethod.error.code, -32601);

  const notification = await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(notification, null);
});
