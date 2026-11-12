'use strict';

/**
 * 路由总装
 * ---------------------------------------------------------------------------
 * 创建路由器并完成全部 API 注册，返回路由器与服务实例。
 * 所有业务依赖通过参数注入，便于在测试中以 mock 服务替换真实实现。
 */

const { Router } = require('../core/http/router');
const metaRoutes = require('./meta-routes');
const settingsRoutes = require('./settings-routes');
const completionRoutes = require('./completion-routes');
const runRoutes = require('./run-routes');

/**
 * 构建应用路由
 * @param {object} [options] 选项
 * @param {import('../services/completion-service').CompletionService} [options.completionService] 补全服务实例
 * @param {import('../runners/runner-service').RunService} [options.runService] 代码运行服务实例
 * @returns {{router:import('../core/http/router').Router, completionService:object, runService:object}} 路由与服务
 */
function buildRoutes(options = {}) {
  // 延迟 require，避免在只读取路由表时也初始化大模型客户端
  const CompletionService = options.completionService
    ? null
    : require('../services/completion-service').CompletionService;
  const completionService = options.completionService || new CompletionService();
  const RunService = options.runService
    ? null
    : require('../runners/runner-service').RunService;
  const runService = options.runService || new RunService();

  const router = new Router();
  metaRoutes.register(router);
  settingsRoutes.register(router, completionService);
  completionRoutes.register(router, completionService);
  runRoutes.register(router, runService);

  return { router, completionService, runService };
}

module.exports = { buildRoutes };
