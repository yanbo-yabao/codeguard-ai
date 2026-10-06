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
    'Cache-Control': filePath.endsWith('.html') ? 'no-cache' : 'public, max-age=3600',
    'X-Request-Id': ctx.requestId,
  });
  ctx.responded = true;

  const stream = fs.createReadStream(filePath);
  stream.on('error', () => ctx.res.end());
  stream.pipe(ctx.res);
  return true;
}

module.exports = { serveStatic, resolveStaticPath, guessMimeType, MIME_TYPES };
