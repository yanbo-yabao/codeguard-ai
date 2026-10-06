'use strict';

/**
 * 评审相关 API
 * ---------------------------------------------------------------------------
 * POST   /api/reviews        提交代码发起评审
 * GET    /api/reviews        分页查询历史记录
 * GET    /api/reviews/:id    读取单条完整记录
 * DELETE /api/reviews/:id    删除记录
 */

const { ValidationError } = require('../core/errors');

/**
 * 注册评审路由
 * @param {import('../core/http/router').Router} router 路由器
 * @param {import('../services/review-service').ReviewService} service 评审服务
 */
function register(router, service) {
  router.post('/api/reviews', async (ctx) => {
    const body = (await ctx.parseBody()) || {};
    if (typeof body !== 'object') throw new ValidationError('请求体必须是 JSON 对象');

    const record = await service.review(body);

    // 大响应不下发完整代码预览与逐条修复补丁（分别通过专用接口获取）
    ctx.json(201, {
      id: record.id,
      createdAt: record.createdAt,
      source: {
        title: record.source.title,
        fileName: record.source.fileName,
        language: record.source.language,
        codeHash: record.source.codeHash,
        totalLines: record.source.totalLines,
      },
      engines: record.engines,
      score: record.score,
      metrics: record.metrics,
      issues: record.issues,
      summary: record.summary,
      llm: { ...record.llm, roleSummaries: record.llm.roleSummaries },
      stats: record.stats,
      warnings: record.warnings,
      fixCount: record.fixes.length,
    });
  });

  router.get('/api/reviews', (ctx) => {
    const result = service.list({
      limit: ctx.query.limit,
      offset: ctx.query.offset,
      keyword: ctx.query.keyword,
    });
    ctx.json(200, result);
  });

  router.get('/api/reviews/:id', (ctx) => {
    ctx.json(200, service.get(ctx.params.id));
  });

  router.delete('/api/reviews/:id', (ctx) => {
    service.remove(ctx.params.id);
    ctx.json(200, { deleted: true, id: ctx.params.id });
  });
}

module.exports = { register };
