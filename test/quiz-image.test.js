'use strict';

/**
 * 变式出题与图片提问测试
 * ---------------------------------------------------------------------------
 * 覆盖：quiz 流水线（离线模拟出题）、图片提问（多模态消息组装与诚实降级）、
 * 图片参数校验、解题讲解字段。
 */

process.env.LLM_PROVIDER = 'mock';
process.env.LOG_LEVEL = 'silent';

const test = require('node:test');
const assert = require('node:assert');

const { CompletionService } = require('../src/services/completion-service');
const { buildCompletePrompt } = require('../src/agents/prompt-templates');

test('变式出题：返回题面、测试用例、起始代码与参考答案', async () => {
  const service = new CompletionService();
  const result = await service.complete({ feature: 'quiz', prompt: '两数之和', language: 'python' });

  assert.equal(result.feature, 'quiz');
  assert.equal(result.mode, 'quiz');
  assert.ok(result.quiz && result.quiz.title.length > 0);
  assert.ok(result.quiz.description.length > 0);
  assert.ok(Array.isArray(result.quiz.testCases) && result.quiz.testCases.length >= 1);
  assert.ok(result.quiz.testCases.every((item) => typeof item.input === 'string' && typeof item.expected === 'string'));
  assert.ok(typeof result.quiz.referenceSolution === 'string');
  assert.ok(typeof result.quiz.starterCode === 'string');
  assert.equal(result.completionSource, 'mock', '离线模拟出题必须诚实标注');
  assert.ok(result.warnings.some((item) => item.includes('离线模拟器')), '必须提示这是演示出题');
});

test('变式出题：未配置大模型时明确告知而不是假装出题', async () => {
  const service = new CompletionService();
  const result = await service.complete({ feature: 'quiz', prompt: '快速排序', useLlm: false });
  assert.equal(result.quiz, null);
  assert.ok(result.warnings.some((item) => item.includes('已关闭大模型')));
});

test('图片提问：多模态消息组装为文本 + 图片两段', () => {
  const messages = buildCompletePrompt({
    prompt: '这道题怎么做',
    language: 'JavaScript',
    imageUrl: 'data:image/png;base64,AAAA',
  });
  const user = messages.find((item) => item.role === 'user');
  assert.ok(Array.isArray(user.content), '带图片时用户消息应为多模态数组');
  assert.equal(user.content[0].type, 'text');
  assert.equal(user.content[1].type, 'image_url');
  assert.equal(user.content[1].image_url.url, 'data:image/png;base64,AAAA');
});

test('图片提问：纯文本时用户消息仍是字符串', () => {
  const messages = buildCompletePrompt({ prompt: 'hi', language: 'JavaScript' });
  const user = messages.find((item) => item.role === 'user');
  assert.equal(typeof user.content, 'string');
});

test('图片提问：离线模式下诚实说明无法理解图片', async () => {
  const service = new CompletionService();
  const result = await service.complete({
    feature: 'complete',
    prompt: '这道题怎么做',
    image: 'data:image/png;base64,AAAA',
  });
  assert.equal(result.feature, 'complete');
  assert.ok(typeof result.answer === 'string');
  assert.ok(result.answer.includes('图片'), '讲解中应提及图片处理情况');
});

test('图片参数校验：非法 data URL / 超大图片被拒绝', async () => {
  const service = new CompletionService();
  await assert.rejects(
    () => service.complete({ feature: 'complete', prompt: 'x', image: 'C:\\fake\\path.png' }),
    /data URL/,
  );
  await assert.rejects(
    () => service.complete({ feature: 'complete', prompt: 'x', image: `data:image/png;base64,${'A'.repeat(8000001)}` }),
    /过大/,
  );
  await assert.rejects(
    () => service.complete({ feature: 'fix', code: 'x = 1', image: 'data:image/png;base64,AAAA' }),
    /仅用于解题与补全/,
  );
});

test('解题讲解：complete 结果包含 answer 字段', async () => {
  const service = new CompletionService();
  const result = await service.complete({ feature: 'complete', prompt: '随机功能请求 zzzqqq', language: 'javascript' });
  assert.ok('answer' in result);
  assert.equal(result.feature, 'complete');
  assert.equal(result.quiz, null);
});
