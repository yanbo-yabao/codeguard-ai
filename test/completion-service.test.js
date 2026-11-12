'use strict';

/**
 * 代码补全服务（业务编排）测试
 * ---------------------------------------------------------------------------
 * 覆盖重点：输入校验与模式判定、静态语法检查、双引擎交叉印证、
 * 降级行为（未配置大模型 / 关闭大模型）、补全结果自检。
 * 使用离线模拟器（mock）作为大模型后端，保证测试零外网依赖且结果确定。
 */

// 必须在 require 业务模块之前完成环境注入：配置中心在模块加载时即读取环境变量
process.env.LLM_PROVIDER = 'mock';
process.env.LOG_LEVEL = 'silent';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CompletionService, mergeDiagnosis } = require('../src/services/completion-service');
const { LlmClient } = require('../src/agents/llm-client');

/** 创建使用 mock 大模型的服务实例 */
function createService() {
  return new CompletionService({ client: new LlmClient({ provider: 'mock' }) });
}

test('normalizeInput：提示词与代码都为空时拒绝', () => {
  const service = createService();
  assert.throws(() => service.normalizeInput({ prompt: '', code: '' }), (error) => {
    assert.equal(error.code, 'VALIDATION_ERROR');
    return true;
  });
});

test('normalizeInput：功能与模式判定正确（complete / fix / generate）', () => {
  const service = createService();
  // 有提示词 + 有代码 → 补全
  const both = service.normalizeInput({ prompt: '补全', code: 'let a;' });
  assert.equal(both.feature, 'complete');
  assert.equal(both.mode, 'complete');
  // 仅代码 → 错误检查与修复
  const fix = service.normalizeInput({ prompt: '', code: 'let a;' });
  assert.equal(fix.feature, 'fix');
  assert.equal(fix.mode, 'fix');
  // 仅提示词 → 从零生成
  const gen = service.normalizeInput({ prompt: '写个快排', code: '' });
  assert.equal(gen.feature, 'complete');
  assert.equal(gen.mode, 'generate');
  // 显式 feature 优先于推断
  assert.equal(service.normalizeInput({ feature: 'fix', prompt: '意图', code: 'x' }).feature, 'fix');
});

test('normalizeInput：非法 feature、complete 缺提示词、fix 缺代码均被拒绝', () => {
  const service = createService();
  assert.throws(() => service.normalizeInput({ feature: 'other', prompt: 'p', code: 'x' }), /feature/);
  assert.throws(() => service.normalizeInput({ feature: 'complete', prompt: '', code: 'x' }), (error) => {
    assert.equal(error.code, 'VALIDATION_ERROR');
    return true;
  });
  assert.throws(() => service.normalizeInput({ feature: 'fix', prompt: 'p', code: '' }), (error) => {
    assert.equal(error.code, 'VALIDATION_ERROR');
    return true;
  });
});

test('功能 A · 代码补全：返回补全代码与要点说明，产物自检无语法问题', async () => {
  const service = createService();
  const result = await service.complete({
    feature: 'complete',
    prompt: '写一个加法函数',
    code: '',
    language: 'javascript',
    fileName: 'add.js',
  });

  assert.equal(result.feature, 'complete');
  assert.equal(result.mode, 'generate');
  assert.ok(result.completedCode, '应返回补全后的代码');
  assert.equal(result.fixedCode, null, '补全功能不返回修复代码');
  assert.ok(result.selfCheck, '补全结果应执行自检');
  assert.equal(result.selfCheck.target, 'completedCode');
  assert.equal(result.selfCheck.issueCount, 0, '补全代码自身不应有语法问题');
  assert.equal(result.engines.static, false, '补全功能不检查输入代码');
});

test('功能 B · 错误修复：静态 + mock 诊断交叉印证，返回修复后代码', async () => {
  const service = createService();
  const result = await service.complete({
    feature: 'fix',
    prompt: '应正确求阶乘',
    code: 'function fact(n) {\n  if (n <= 1) return 1\n  return n * fact(n - 1)\n',
    language: 'javascript',
    fileName: 'fact.js',
  });

  assert.equal(result.feature, 'fix');
  assert.equal(result.completedCode, null, '修复功能不返回补全代码');
  assert.ok(result.fixedCode, '应返回修复后的代码');
  assert.ok(result.issues.length > 0, '未闭合括号应被静态检查检出');
  assert.ok(result.issues.some((item) => item.ruleId === 'SYN001' || item.ruleId === 'SYN003'));
  assert.equal(result.engines.static, true);
  assert.equal(result.engines.llm, true);
  assert.equal(result.summary.offline, false);
  assert.ok(result.selfCheck, '修复结果应执行自检');
  assert.equal(result.selfCheck.target, 'fixedCode');
  assert.ok(result.stats.confirmedCount >= 1, '同位置结论应被计为印证');
});

test('双引擎印证：mock 诊断结论与静态结论同位置合并为印证', async () => {
  const service = createService();
  // mock 的 syntax 角色对括号不配对的代码会给出「括号配对可疑」结论，
  // 与静态 SYN001 同位置命中，应计为印证而非重复条目
  const result = await service.complete({
    feature: 'fix',
    prompt: '',
    code: 'function broken() {\n  return 1;\n',
    language: 'javascript',
  });

  assert.ok(result.stats.staticIssueCount >= 1);
  assert.ok(result.stats.llmIssueCount >= 1);
  assert.ok(result.stats.confirmedCount >= 1, '同位置结论应被计为印证');
  assert.ok(result.issues.every((item) => item.ruleId !== 'LLM-SYN' || item.confirmedBy === undefined));
});

test('关闭大模型：修复功能仅返回静态结果并明确告知', async () => {
  const service = createService();
  const result = await service.complete({
    feature: 'fix',
    prompt: '',
    code: 'function ok() { return 1; }\n',
    language: 'javascript',
    useLlm: false,
  });

  assert.equal(result.engines.llm, false);
  assert.equal(result.llm, null);
  assert.equal(result.summary.offline, true);
  assert.ok(result.warnings.some((item) => /已关闭大模型/.test(item)));
  assert.deepEqual(result.issues, [], '干净代码零误报');
  assert.equal(result.fixedCode, null);
});

test('大模型未配置：自动降级为静态检查且不整体失败', async () => {
  const service = new CompletionService({ client: new LlmClient({ provider: 'deepseek' }) });
  const result = await service.complete({
    feature: 'fix',
    prompt: '',
    code: 'function broken() {\n',
    language: 'javascript',
  });

  assert.equal(result.engines.llm, false);
  assert.ok(result.warnings.some((item) => /大模型未配置/.test(item)));
  assert.ok(result.issues.length > 0, '静态检查结论照常返回');
  assert.equal(result.summary.offline, true);
});

test('补全结果自检：mock 补全产出的代码通过语法检查', async () => {
  const service = createService();
  const result = await service.complete({ feature: 'complete', prompt: '写一个加法函数', code: '', language: 'javascript' });

  assert.equal(result.mode, 'generate');
  assert.ok(result.completedCode);
  assert.ok(result.selfCheck);
  assert.equal(result.selfCheck.target, 'completedCode');
  assert.equal(result.selfCheck.issueCount, 0, '补全代码自身不应有语法问题');
});

test('离线模板补全：不调用任何 API 也能补全常见功能', async () => {
  // 客户端未配置（deepseek 无密钥）= 不会发出任何网络请求
  const service = new CompletionService({ client: new LlmClient({ provider: 'deepseek' }) });
  const result = await service.complete({
    feature: 'complete',
    prompt: '帮我写一个快速排序',
    code: '',
    language: 'javascript',
  });

  assert.ok(result.completedCode, '应返回补全代码');
  assert.match(result.completedCode, /quickSort/, '应为快速排序真实实现');
  assert.equal(result.completionSource, 'template', '来源应为内置模板库');
  assert.equal(result.llm, null, '不应有大模型调用');
  assert.equal(result.selfCheck.issueCount, 0, '模板代码通过语法自检');
  assert.ok(result.warnings.some((item) => /内置离线模板库/.test(item)), '应明确告知来源');
  assert.ok(result.notes.some((item) => /非 AI 生成/.test(item)), '备注应诚实声明非 AI 生成');
});

test('离线模板补全：Python 同样可用，且可拼接现有代码', async () => {
  const service = new CompletionService({ client: new LlmClient({ provider: 'deepseek' }) });
  const result = await service.complete({
    feature: 'complete',
    prompt: '二分查找',
    code: '# 我的工具库',
    language: 'python',
  });

  assert.match(result.completedCode, /def binary_search/, '应为二分查找真实实现');
  assert.match(result.completedCode, /^# 我的工具库/, '现有代码应拼接在模板之前');
  assert.equal(result.completionSource, 'template');
});

test('离线模板补全：无匹配模板时如实告知，绝不硬凑', async () => {
  const service = new CompletionService({ client: new LlmClient({ provider: 'deepseek' }) });
  const result = await service.complete({
    feature: 'complete',
    prompt: '实现一个量子纠缠模拟器',
    code: '',
    language: 'javascript',
  });

  assert.equal(result.completedCode, null, '不应返回硬凑的代码');
  assert.equal(result.completionSource, 'none');
  assert.ok(result.warnings.length > 0);
});

test('产出安全复检：生成代码含高风险写法时报警（AI 安全与可控）', async () => {
  const service = createService();
  // 模板补全会把用户现有代码拼接在前：其中的 eval 应被产出安全复检捕获
  const result = await service.complete({
    feature: 'complete',
    prompt: '快速排序',
    code: 'function run(userInput) {\n  eval(userInput);\n}\n',
    language: 'javascript',
  });

  assert.ok(result.safetyCheck, '应执行产出安全复检');
  assert.ok(result.safetyCheck.issueCount >= 1, 'eval 应被安全规则标记');
  assert.ok(result.warnings.some((item) => /安全复检/.test(item)), '应给出安全风险警告');
});

test('mergeDiagnosis：邻近行结论计为印证、远距离结论独立计入', () => {
  const staticIssue = {
    id: 's1', ruleId: 'SYN001', line: 10, severity: 'major', severityOrder: 3,
  };
  const llmIssues = [
    { id: 'l1', ruleId: 'LLM-SYN', line: 11, severity: 'major', severityOrder: 3 },
    { id: 'l2', ruleId: 'LLM-SYN', line: 40, severity: 'minor', severityOrder: 2 },
  ];

  const merged = mergeDiagnosis([staticIssue], llmIssues);
  assert.equal(merged.confirmed, 1);
  assert.equal(merged.issues.length, 2);
  assert.equal(merged.issues.find((item) => item.id === 's1').confirmedBy, 1);
  assert.ok(merged.issues.some((item) => item.id === 'l2'));
});
