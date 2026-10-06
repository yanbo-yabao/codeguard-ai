'use strict';

/**
 * 路由总装
 * ---------------------------------------------------------------------------
 * 创建路由器并完成全部 API 注册，返回路由器与服务实例。
 * 所有业务依赖通过参数注入，便于在测试中以 mock 服务替换真实实现。
 */

const { Router } = require('../core/http/router');
const reviewRoutes = require('./review-routes');
const reportRoutes = require('./report-routes');
const metaRoutes = require('./meta-routes');

/**
 * 构建应用路由
 * @param {object} [options] 选项
 * @param {import('../services/review-service').ReviewService} [options.service] 评审服务实例
 * @returns {{router:import('../core/http/router').Router, service:object}} 路由与服务
 */
function buildRoutes(options = {}) {
  // 延迟 require，避免在只读取路由表时也初始化存储与大模型客户端
  const ReviewService = options.service
    ? null
    : require('../services/review-service').ReviewService;
  const service = options.service || new ReviewService();

  const router = new Router();
  reviewRoutes.register(router, service);
  reportRoutes.register(router, service);
  metaRoutes.register(router, service);

  return { router, service };
}

module.exports = { buildRoutes };
