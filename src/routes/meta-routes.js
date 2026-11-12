'use strict';

/**
 * 元信息 API
 * ---------------------------------------------------------------------------
 * GET /api/meta/health    健康检查（含环境自检明细）
 * GET /api/meta/config    脱敏后的运行配置
 * GET /api/meta/rules     规则清单与分类字典
 * GET /api/meta/routes    接口清单（便于交付评审时核对）
 * GET /api/meta/languages 支持的语言清单
 */

const config = require('../config');
const { describeRules, LANGUAGES } = require('../analyzers');

/**
 * 注册元信息路由
 * @param {import('../core/http/router').Router} router 路由器
 */
function register(router) {
  router.get('/api/meta/health', (ctx) => {
    const selfCheck = config.selfCheck();
    ctx.json(selfCheck.ok ? 200 : 503, {
      status: selfCheck.ok ? 'ok' : 'degraded',
      app: { name: config.pkg.name, version: config.pkg.version },
      uptimeSeconds: Math.round(process.uptime()),
      memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      checks: selfCheck.checks,
    });
  });

  router.get('/api/meta/config', (ctx) => {
    ctx.json(200, config.describe());
  });

  router.get('/api/meta/rules', (ctx) => {
    ctx.json(200, describeRules());
  });

  router.get('/api/meta/routes', (ctx) => {
    ctx.json(200, { routes: router.describe() });
  });

  router.get('/api/meta/languages', (ctx) => {
    ctx.json(200, {
      languages: Object.values(LANGUAGES).map((profile) => ({
        key: profile.key,
        label: profile.label,
        extensions: profile.extensions,
      })),
    });
  });

  router.get('/api/version', (ctx) => {
    ctx.json(200, {
      name: config.pkg.name,
      version: config.pkg.version,
      description: config.pkg.description,
      node: process.version,
    });
  });
}

module.exports = { register };
