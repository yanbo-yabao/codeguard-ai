'use strict';

/**
 * 代码补全 API
 * ---------------------------------------------------------------------------
 * POST /api/completions   提交提示词 + 代码，返回补全结果与语法修改建议
 */

const { ValidationError } = require('../core/errors');

/**
 * 注册补全路由
 * @param {import('../core/http/router').Router} router 路由器
 * @param {import('../services/completion-service').CompletionService} service 补全服务
 */
function register(router, service) {
  router.post('/api/completions', async (ctx) => {
    const body = (await ctx.parseBody()) || {};
    if (typeof body !== 'object') throw new ValidationError('请求体必须是 JSON 对象');

    const result = await service.complete(body);
    ctx.json(201, result);
  });
}

module.exports = { register };
