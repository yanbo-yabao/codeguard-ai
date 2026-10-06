'use strict';

/**
 * 报告导出 API
 * ---------------------------------------------------------------------------
 * GET /api/reviews/:id/report?format=json|markdown|html|sarif
 * GET /api/reviews/:id/fixes          仅获取修复建议列表
 *
 * 通过 ?download=1 可强制浏览器以附件形式下载。
 */

const { ValidationError } = require('../core/errors');

/** 支持的导出格式 */
const SUPPORTED_FORMATS = ['json', 'markdown', 'md', 'html', 'sarif'];

/**
 * 注册报告路由
 * @param {import('../core/http/router').Router} router 路由器
 * @param {import('../services/review-service').ReviewService} service 评审服务
 */
function register(router, service) {
  router.get('/api/reviews/:id/report', (ctx) => {
    const format = String(ctx.query.format || 'json').toLowerCase();
    if (!SUPPORTED_FORMATS.includes(format)) {
      throw new ValidationError(`不支持的报告格式：${format}`, {
        supported: SUPPORTED_FORMATS,
      });
    }

    const result = service.exportReport(ctx.params.id, format);
    ctx.setHeader('Content-Disposition', `inline; filename="${result.fileName}"`);
    if (ctx.query.download === '1') {
      ctx.setHeader('Content-Disposition', `attachment; filename="${result.fileName}"`);
    }
    ctx.send(200, result.content, result.contentType);
  });

  router.get('/api/reviews/:id/fixes', (ctx) => {
    const record = service.get(ctx.params.id);
    ctx.json(200, { id: record.id, total: record.fixes.length, fixes: record.fixes });
  });
}

module.exports = { register, SUPPORTED_FORMATS };
