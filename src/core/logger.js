'use strict';

/**
 * 统一日志器
 * ---------------------------------------------------------------------------
 * 特点：
 *   - 分级输出（debug < info < warn < error），低于阈值的日志直接丢弃；
 *   - 双格式：pretty（带 ANSI 颜色，适合本地终端）与 json（适合容器日志采集）；
 *   - 零依赖，ANSI 转义在非 TTY 或 NO_COLOR 环境下自动降级为纯文本。
 */

const config = require('../config');

/** 日志级别权重表 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

/** ANSI 颜色表 */
const COLORS = {
  debug: '\u001b[90m',
  info: '\u001b[36m',
  warn: '\u001b[33m',
  error: '\u001b[31m',
  reset: '\u001b[0m',
  dim: '\u001b[2m',
};

/** 是否允许输出颜色：显式关闭、非 TTY 或已设置 NO_COLOR 时禁用 */
function supportsColor() {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout && process.stdout.isTTY);
}

const USE_COLOR = supportsColor();

/**
 * 按宽度右对齐补空格
 * @param {string} text 文本
 * @param {number} width 目标宽度
 * @returns {string} 对齐后的文本
 */
function pad(text, width) {
  const value = String(text);
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

/**
 * 创建一个日志器实例
 * @param {object} [options] 选项
 * @param {string} [options.scope] 作用域名称，会作为前缀输出
 * @param {string} [options.level] 覆盖全局日志级别
 * @returns {{debug:Function,info:Function,warn:Function,error:Function,child:Function,scope:string}}
 */
function createLogger(options = {}) {
  const scope = options.scope || 'app';
  const threshold = LEVELS[options.level || config.log.level] ?? LEVELS.info;
  const useJson = (options.format || config.log.format) === 'json';

  /**
   * 内部输出实现
   * @param {string} level 级别
   * @param {string} message 消息
   * @param {object} [meta] 附加字段
   */
  function write(level, message, meta) {
    if (LEVELS[level] < threshold) return;

    const timestamp = new Date().toISOString();

    if (useJson) {
      const payload = { ts: timestamp, level, scope, msg: message };
      if (meta && Object.keys(meta).length > 0) payload.meta = meta;
      const line = JSON.stringify(payload);
      (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);
      return;
    }

    const tag = USE_COLOR ? `${COLORS[level]}${pad(level.toUpperCase(), 5)}${COLORS.reset}` : pad(level.toUpperCase(), 5);
    const clock = USE_COLOR ? `${COLORS.dim}${timestamp.slice(11, 19)}${COLORS.reset}` : timestamp.slice(11, 19);
    const scoped = USE_COLOR ? `${COLORS.dim}[${scope}]${COLORS.reset}` : `[${scope}]`;

    let line = `${clock} ${tag} ${scoped} ${message}`;
    if (meta && Object.keys(meta).length > 0) {
      line += ` ${USE_COLOR ? COLORS.dim : ''}${JSON.stringify(meta)}${USE_COLOR ? COLORS.reset : ''}`;
    }

    (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);
  }

  return {
    scope,
    debug: (message, meta) => write('debug', message, meta),
    info: (message, meta) => write('info', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    error: (message, meta) => write('error', message, meta),
    /**
     * 派生子日志器，便于按模块追踪来源
     * @param {string} childScope 子作用域
     * @returns {ReturnType<typeof createLogger>} 子日志器
     */
    child: (childScope) => createLogger({ ...options, scope: `${scope}:${childScope}` }),
  };
}

module.exports = createLogger();
module.exports.createLogger = createLogger;
module.exports.LEVELS = LEVELS;
