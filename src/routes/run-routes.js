'use strict';

/**
 * 代码运行 API
 * ---------------------------------------------------------------------------
 * POST /api/run        body: { mode, language, code, stdin?, testCases?, timeoutMs? }
 *   mode = 'run'    单次执行（喂标准输入，返回标准输出 / 报错）
 *   mode = 'judge'  自动判题（对 testCases 逐一执行并比对输出）
 *   mode = 'debug'  调试执行（返回逐行执行轨迹与变量快照）
 */

const { ValidationError } = require('../core/errors');
const { RunService, RUNNABLE, DEFAULT_TIMEOUT_MS } = require('../runners/runner-service');

/**
 * 校验并归一化请求体
 * @param {object} body 请求体
 * @returns {object} 归一化后的参数
 */
function normalize(body) {
  if (!body || typeof body !== 'object') throw new ValidationError('请求体必须是 JSON 对象');
  const { mode = 'run', language, code, stdin, testCases, timeoutMs } = body;
  if (!['run', 'judge', 'debug'].includes(mode)) {
    throw new ValidationError('mode 必须是 run / judge / debug 之一');
  }
  if (!language || typeof language !== 'string') throw new ValidationError('language 不能为空');
  const aliases = { js: 'javascript', 'c++': 'cpp', 'c plus plus': 'cpp', py: 'python' };
  const langKey = aliases[language.toLowerCase()] || language.toLowerCase();
  if (!RUNNABLE.includes(langKey)) {
    throw new ValidationError(`暂不支持运行该语言：${language}（当前支持 JavaScript / Python / C / C++ / Java）`);
  }
  if (typeof code !== 'string' || code.trim() === '') throw new ValidationError('code 不能为空');
  if (code.length > 100000) throw new ValidationError('code 过长（上限 100000 字符）');
  if (stdin !== undefined && typeof stdin !== 'string') throw new ValidationError('stdin 必须是字符串');

  const result = { mode, language: langKey, code, stdin: stdin ?? '', timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS };
  if (mode === 'judge') {
    if (!Array.isArray(testCases) || testCases.length === 0) {
      throw new ValidationError('judge 模式需要至少一组 testCases（[{input, expected}]）');
    }
    for (const item of testCases) {
      if (!item || typeof item !== 'object') throw new ValidationError('testCases 每项必须是 {input, expected} 对象');
      if (typeof item.expected !== 'string') throw new ValidationError('testCases.expected 必须是字符串');
      if (item.input !== undefined && typeof item.input !== 'string') throw new ValidationError('testCases.input 必须是字符串');
    }
    result.testCases = testCases;
  }
  return result;
}

/**
 * 注册代码运行路由
 * @param {import('../core/http/router').Router} router 路由器
 * @param {import('../runners/runner-service').RunService} service 运行服务
 */
function register(router, service) {
  router.get('/api/run/env', (ctx) => {
    ctx.json(200, {
      languages: RunService.availability(),
      runnable: RUNNABLE,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
  });

  router.post('/api/run', async (ctx) => {
    const params = normalize(await ctx.parseBody());
    let result;
    if (params.mode === 'judge') result = await service.judge(params);
    else if (params.mode === 'debug') result = await service.debug(params);
    else result = await service.run(params);
    ctx.json(200, result);
  });
}

module.exports = { register, normalize };
