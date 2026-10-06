'use strict';

/**
 * 静态资源服务（零依赖）
 * ---------------------------------------------------------------------------
 * 把 web/ 目录作为前端单页应用的根，实现：
 *   - 扩展名 → MIME 映射；
 *   - 目录默认文档 index.html；
 *   - 路径穿越防御（解析后必须仍位于根目录之内）；
 *   - 基于文件修改时间的轻量协商缓存。
 */

const fs = require('fs');
const path = require('path');

/** 扩展名与 MIME 类型映射表 */
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

/**
 * 根据文件路径推断 MIME 类型
 * @param {string} filePath 文件路径
 * @returns {string} MIME 类型
 */
function guessMimeType(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

/**
 * 将 URL 路径安全地解析为磁盘文件路径
 * @param {string} rootDir 静态根目录
 * @param {string} urlPath 请求路径（已解码）
 * @returns {string|null} 磁盘路径；越界或不存在时返回 null
 */
function resolveStaticPath(rootDir, urlPath) {
  const root = path.resolve(rootDir);
  // 归一化后强制拼接，剥离 ../ 之类的回溯片段
  const relative = urlPath.replace(/^\/+/, '');
  let target = path.resolve(root, relative);

  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    target = path.join(target, 'index.html');
  }

  // 安全校验：解析结果必须位于静态根目录之内
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (target !== root && !target.startsWith(rootWithSep)) return null;

  return fs.existsSync(target) && fs.statSync(target).isFile() ? target : null;
}

/**
 * 长缓存白名单：这类资源内容稳定、体积较大，可按本地缓存直接复用。
 * 其余资源（html / js / css / json / md）一律 no-cache —— 必须回源用 ETag 协商。
 *
 * 为什么不能用 max-age 缓存脚本：曾出现「新页面 + 旧脚本」的组合 ——
 * 浏览器缓存了旧 app.js，新加的按钮虽然在，但点击事件无处绑定，表现为「点了没反应」。
 * 对本地工具而言，304 协商几乎零成本，因此优先级是「永远正确」而不是「少一次请求」。
 */
const LONG_CACHE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico',
  '.woff', '.woff2', '.ttf',
]);

/**
 * 生成 Cache-Control 头
 * @param {string} filePath 文件路径
 * @returns {string} Cache-Control 值
 */
function cacheControlFor(filePath) {
  return LONG_CACHE_EXTENSIONS.has(path.extname(filePath).toLowerCase())
    ? 'public, max-age=86400'
    : 'no-cache';
}

/**
 * 发送静态文件
 * @param {object} ctx 请求上下文
 * @param {string} rootDir 静态根目录
 * @returns {boolean} 是否成功命中文件
 */
function serveStatic(ctx, rootDir) {
  const filePath = resolveStaticPath(rootDir, ctx.pathname);
  if (!filePath) return false;

  const stat = fs.statSync(filePath);
  const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;

  // 协商缓存：命中则直接返回 304
  if (ctx.headers['if-none-match'] === etag) {
    ctx.responded = true;
    ctx.res.writeHead(304, { ETag: etag, 'X-Request-Id': ctx.requestId });
    ctx.res.end();
    return true;
  }

  ctx.res.writeHead(200, {
    'Content-Type': guessMimeType(filePath),
    'Content-Length': stat.size,
    ETag: etag,
    'Cache-Control': cacheControlFor(filePath),
    'X-Request-Id': ctx.requestId,
  });
  ctx.responded = true;

  const stream = fs.createReadStream(filePath);
  stream.on('error', () => ctx.res.end());
  stream.pipe(ctx.res);
  return true;
}

module.exports = { serveStatic, resolveStaticPath, guessMimeType, cacheControlFor, MIME_TYPES };
