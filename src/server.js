'use strict';

/**
 * 服务入口
 * ---------------------------------------------------------------------------
 * 职责：装配依赖 → 启动 HTTP 服务 → 处理优雅退出。
 * 启动后会打印一份可直接用于演示与验收的访问信息。
 */

const config = require('./config');
const logger = require('./core/logger');
const { createHttpServer } = require('./core/http/app');
const { buildRoutes } = require('./routes');
const { store } = require('./core/storage');

const log = logger.child('server');

/**
 * 打印启动横幅
 * @param {object} info 启动信息
 */
function printBanner(info) {
  const lines = [
    '',
    '  ██████╗ ██████╗ ██████╗ ███████╗ ██████╗ ██╗   ██╗ █████╗ ██████╗ ██████╗',
    ' ██╔════╝██╔═══██╗██╔══██╗██╔════╝██╔════╝ ██║   ██║██╔══██╗██╔══██╗██╔══██╗',
    ' ██║     ██║   ██║██║  ██║█████╗  ██║  ███╗██║   ██║███████║██████╔╝██║  ██║',
    ' ██║     ██║   ██║██║  ██║██╔══╝  ██║   ██║██║   ██║██╔══██║██╔══██╗██║  ██║',
    ' ╚██████╗╚██████╔╝██████╔╝███████╗╚██████╔╝╚██████╔╝██║  ██║██║  ██║██████╔╝',
    '  ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝ ╚═════╝  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝ ',
    '',
    `  CodeGuard AI  v${info.version}   ·   面向开发者的 AI 代码审查 Agent`,
    '',
    `  评审台    http://${info.host}:${info.port}/`,
    `  健康检查  http://${info.host}:${info.port}/api/meta/health`,
    `  接口清单  http://${info.host}:${info.port}/api/meta/routes`,
    `  规则清单  http://${info.host}:${info.port}/api/meta/rules`,
    '',
    `  运行环境  ${info.env} / Node ${info.node}`,
    `  大模型    ${info.llm}`,
    `  数据目录  ${info.dataDir}`,
    '  按 Ctrl+C 停止服务',
    '',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

/**
 * 启动服务
 * @param {object} [options] 选项
 * @param {number} [options.port] 覆盖端口（0 表示随机端口，用于测试）
 * @returns {Promise<{server:import('http').Server, port:number, url:string}>} 启动结果
 */
async function start(options = {}) {
  store.init();

  const { router, service } = buildRoutes();
  const server = createHttpServer({ router });

  const port = options.port === undefined ? config.server.port : options.port;
  const host = options.host || config.server.host;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const actualPort = server.address().port;

  // 端口被占用时自动顺延，避免演示现场启动失败
  const info = {
    version: config.pkg.version,
    host: host === '0.0.0.0' ? 'localhost' : host,
    port: actualPort,
    env: config.env,
    node: process.version,
    llm: config.llm.available
      ? `${config.llm.providerLabel} / ${config.llm.model}`
      : `未启用（${config.llm.reason}）`,
    dataDir: config.storage.dataDir,
  };

  if (!options.silent) printBanner(info);
  log.info(`HTTP 服务已启动，监听 ${host}:${actualPort}`);

  return { server, port: actualPort, url: `http://${info.host}:${actualPort}`, service };
}

/**
 * 优雅退出：停止接收新连接，等待在途请求完成后退出
 * @param {import('http').Server} server HTTP 服务器
 * @param {string} [signal] 触发信号
 */
function shutdown(server, signal = 'SIGINT') {
  log.info(`收到 ${signal}，开始优雅退出…`);
  const timer = setTimeout(() => {
    log.warn('等待超时，强制退出');
    process.exit(1);
  }, 5000);
  timer.unref();

  server.close(() => {
    log.info('服务已停止');
    clearTimeout(timer);
    process.exit(0);
  });
}

/* 直接执行（node src/server.js）时启动服务 */
if (require.main === module) {
  start()
    .then(({ server }) => {
      process.on('SIGINT', () => shutdown(server, 'SIGINT'));
      process.on('SIGTERM', () => shutdown(server, 'SIGTERM'));
      process.on('unhandledRejection', (reason) => {
        log.error('未处理的 Promise 拒绝', { reason: String(reason) });
      });
      process.on('uncaughtException', (error) => {
        log.error('未捕获异常', { message: error.message, stack: error.stack });
      });
    })
    .catch((error) => {
      log.error(`服务启动失败：${error.message}`);
      if (error.code === 'EADDRINUSE') {
        log.error(`端口 ${config.server.port} 已被占用，请修改 .env 中的 PORT 后重试`);
      }
      process.exit(1);
    });
}

module.exports = { start, shutdown, printBanner };
