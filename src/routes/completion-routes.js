'use strict';

/**
 * 代码补全 API
 * ---------------------------------------------------------------------------
 * POST /api/completions   提交提示词 + 代码，返回补全结果与语法修改建议
 *
 * 每请求大模型配置（访客用自己的 Key，只对本次请求生效）：
 *   请求头 x-llm-provider / x-llm-key / x-llm-model / x-llm-base-url
 *   （或请求体 llmConfig 同名字段）
 *   未携带时使用服务器全局配置（data/settings.json / .env）。
 *   自带配置不落盘、不共享、不影响其他访客。
 */

const { ValidationError } = require('../core/errors');
const { CompletionService } = require('../services/completion-service');
const { LlmClient } = require('../agents/llm-client');

/**
 * 从请求头 / 请求体提取每请求大模型配置
 * ---------------------------------------------------------------------------
 * 请求头优先于请求体；空字符串字段被忽略（缺省项回落到全局配置）。
 * @param {object} ctx 请求上下文
 * @param {object} body 请求体
 * @returns {object|null} 覆盖配置；无任何有效字段时返回 null
 */
function extractLlmOverride(ctx, body) {
  const headers = ctx.headers || {};
  const embedded = (body && typeof body.llmConfig === 'object' && body.llmConfig) || {};
  const pick = (headerName, bodyName) => {
    const raw = headers[headerName] ?? embedded[bodyName];
    return typeof raw === 'string' ? raw.trim() : '';
  };
  const override = {
    provider: pick('x-llm-provider', 'provider'),
    apiKey: pick('x-llm-key', 'apiKey'),
    model: pick('x-llm-model', 'model'),
    baseUrl: pick('x-llm-base-url', 'baseUrl'),
  };
  const cleaned = Object.fromEntries(Object.entries(override).filter(([, value]) => value));
  return Object.keys(cleaned).length ? cleaned : null;
}

/**
 * 注册补全路由
 * @param {import('../core/http/router').Router} router 路由器
 * @param {import('../services/completion-service').CompletionService} service 补全服务
 */
function register(router, service) {
  router.post('/api/completions', async (ctx) => {
    const body = (await ctx.parseBody()) || {};
    if (typeof body !== 'object') throw new ValidationError('请求体必须是 JSON 对象');

    // 访客自带密钥优先：为本次请求创建独立服务实例（不写入任何配置文件）
    const override = extractLlmOverride(ctx, body);
    const active = override
      ? new CompletionService({ client: new LlmClient(override) })
      : service;
    const result = await active.complete(body);
    ctx.json(201, result);
  });
}

module.exports = { register, extractLlmOverride };
