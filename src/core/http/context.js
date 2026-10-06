'use strict';

/**
 * 请求上下文封装
 * ---------------------------------------------------------------------------
 * 把原生 IncomingMessage / ServerResponse 包装成带语义化响应方法的 ctx 对象，
 * 业务处理函数只依赖 ctx，不直接触碰原生对象，便于单元测试与后续替换框架。
 */

const { PayloadTooLargeError, ValidationError } = require('../errors');
const { shortId } = require('../utils');

/**
 * 读取并解析 JSON 请求体
 * @param {import('http').IncomingMessage} req 原始请求
 * @param {number} limit 体积上限（字节）
 * @returns {Promise<object|null>} 解析后的对象，空请求体返回 null
 */
function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    /** 统一收敛（成功或失败只触发一次） */
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        // 超限后停止累积并主动断开，避免内存被持续占用
        req.destroy();
        finish(new PayloadTooLargeError(limit));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (size === 0) {
        finish(null, null);
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        finish(null, JSON.parse(raw));
      } catch {
        finish(new ValidationError('请求体不是合法的 JSON'));
      }
    });

    req.on('error', (error) => finish(error));
  });
}

/**
 * 创建请求上下文
 * @param {import('http').IncomingMessage} req 原始请求
 * @param {import('http').ServerResponse} res 原始响应
 * @returns {object} ctx 上下文对象
 */
function createContext(req, res) {
  const host = req.headers.host || 'localhost';
  let url;
  try {
    url = new URL(req.url, `http://${host}`);
  } catch {
    url = new URL('/__bad_request__', `http://${host}`);
  }

  const ctx = {
    /** 请求 ID，贯穿日志便于问题追踪 */
    requestId: shortId('req'),
    method: req.method,
    url: req.url,
    pathname: decodeURIComponent(url.pathname),
    query: Object.fromEntries(url.searchParams.entries()),
    headers: req.headers,
    params: {},
    body: null,
    req,
    res,
    startedAt: Date.now(),
    state: {},
    /** 响应是否已经发出，防止重复写头 */
    responded: false,
  };

  /**
   * 设置响应头
   * @param {string} name 头名称
   * @param {string} value 头值
   */
  ctx.setHeader = (name, value) => {
    if (!ctx.responded) res.setHeader(name, value);
  };

  /**
   * 发送响应
   * @param {number} status HTTP 状态码
   * @param {string|Buffer} payload 响应体
   * @param {string} contentType Content-Type
   */
  ctx.send = (status, payload, contentType) => {
    if (ctx.responded) return;
    ctx.responded = true;
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    res.writeHead(status, {
      'Content-Type': contentType,
      'Content-Length': body.length,
      'X-Request-Id': ctx.requestId,
    });
    res.end(body);
  };

  /**
   * 发送 JSON 响应
   * @param {number} status 状态码
   * @param {unknown} data 数据体
   */
  ctx.json = (status, data) => {
    ctx.send(status, JSON.stringify(data, null, 2), 'application/json; charset=utf-8');
  };

  /**
   * 发送纯文本响应
   * @param {number} status 状态码
   * @param {string} text 文本内容
   */
  ctx.text = (status, text) => {
    ctx.send(status, text, 'text/plain; charset=utf-8');
  };

  /**
   * 发送 HTML 响应
   * @param {number} status 状态码
   * @param {string} html HTML 内容
   */
  ctx.html = (status, html) => {
    ctx.send(status, html, 'text/html; charset=utf-8');
  };

  /**
   * 发送 204 空响应
   */
  ctx.noContent = () => {
    if (ctx.responded) return;
    ctx.responded = true;
    res.writeHead(204, { 'X-Request-Id': ctx.requestId });
    res.end();
  };

  /**
   * 解析请求体（带上限保护）
   * @returns {Promise<object|null>} JSON 对象
   */
  ctx.parseBody = async () => {
    if (ctx.body !== null) return ctx.body;
    ctx.body = await readJsonBody(req, ctx.maxBodyBytes || 5 * 1024 * 1024);
    return ctx.body;
  };

  return ctx;
}

module.exports = { createContext, readJsonBody };
