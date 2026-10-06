'use strict';

/**
 * HTTP 应用装配层
 * ---------------------------------------------------------------------------
 * 把「请求日志 → 安全响应头 → CORS → 路由分发 → 静态资源 → 404/500 兜底」
 * 串成一条中间件流水线，暴露 createHttpServer() 供 src/server.js 调用。
 */

const http = require('http');
const config = require('../../config');
const logger = require('../logger');
const { createContext } = require('./context');
const { serveStatic } = require('./static-files');
const { MethodNotAllowedError } = require('./router');
const { AppError, toAppError } = require('../errors');

const log = logger.child('http');

/** 允许跨域的来源：本地开发与局域网演示场景统一放行，方便前端分离部署 */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Request-Id',
  'Access-Control-Max-Age': '86400',
};

/**
 * 设置基础安全响应头
 * @param {object} ctx 请求上下文
 */
function applySecurityHeaders(ctx) {
  ctx.setHeader('X-Content-Type-Options', 'nosniff');
  ctx.setHeader('X-Frame-Options', 'SAMEORIGIN');
  ctx.setHeader('Referrer-Policy', 'no-referrer');
  for (const [name, value] of Object.entries(CORS_HEADERS)) {
    ctx.setHeader(name, value);
  }
}

/**
 * 创建 HTTP 服务器
 * @param {object} options 选项
 * @param {import('./router').Router} options.router 已注册路由的路由器
 * @returns {import('http').Server} HTTP 服务器实例
 */
function createHttpServer({ router }) {
  const server = http.createServer(async (req, res) => {
    const ctx = createContext(req, res);
    ctx.maxBodyBytes = config.server.maxBodyBytes;
    applySecurityHeaders(ctx);

    // 预检请求直接返回，不进入业务逻辑
    if (ctx.method === 'OPTIONS') {
      ctx.noContent();
      return;
    }

    try {
      const matched = router.match(ctx.method, ctx.pathname);

      if (matched) {
        ctx.params = matched.params;
        await matched.route.handler(ctx);
        if (!ctx.responded) {
          ctx.json(500, { error: { code: 'NO_RESPONSE', message: '处理函数未返回响应' } });
        }
      } else if (ctx.method === 'GET' && serveStatic(ctx, config.webDir)) {
        // 静态资源已由 serveStatic 完成响应
      } else {
        ctx.json(404, {
          error: {
            code: 'ROUTE_NOT_FOUND',
            message: `未找到资源：${ctx.method} ${ctx.pathname}`,
            details: { hint: 'GET /api/meta/routes 可查看完整接口清单' },
          },
        });
      }
    } catch (error) {
      if (error instanceof MethodNotAllowedError) {
        ctx.setHeader('Allow', error.allowed.join(', '));
        ctx.json(405, {
          error: { code: 'METHOD_NOT_ALLOWED', message: error.message, details: { allowed: error.allowed } },
        });
      } else {
        const appError = toAppError(error);
        const level = appError.status >= 500 ? 'error' : 'warn';
        log[level](`${ctx.method} ${ctx.pathname} 处理失败`, {
          requestId: ctx.requestId,
          code: appError.code,
          status: appError.status,
          message: appError.message,
        });
        if (appError.status >= 500 && !(appError instanceof AppError && appError.expose)) {
          log.debug('异常堆栈', { stack: error?.stack });
        }
        ctx.json(appError.status, { ...appError.toResponse(), requestId: ctx.requestId });
      }
    } finally {
      const elapsed = Date.now() - ctx.startedAt;
      log.debug(`${ctx.method} ${ctx.pathname} ${res.statusCode} ${elapsed}ms`, {
        requestId: ctx.requestId,
      });
    }
  });

  // 客户端提前断开连接时不产生未捕获异常
  server.on('clientError', (error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    log.debug('客户端连接异常', { message: error.message });
  });

  return server;
}

module.exports = { createHttpServer };
