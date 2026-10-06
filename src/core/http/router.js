'use strict';

/**
 * 微型路由器（零依赖）
 * ---------------------------------------------------------------------------
 * 支持 `:param` 形式的路径参数与精确匹配两类路由，路径匹配结果会被缓存，
 * 匹配到路径但方法不符时抛出 405，便于前端区分「接口不存在」与「方法用错」。
 */

const { ValidationError } = require('../errors');

/** 路由编译缓存：同一个路径模式只编译一次正则 */
const patternCache = new Map();

/**
 * 将路径模式编译为正则表达式
 * @param {string} pattern 形如 /api/reviews/:id
 * @returns {{regex:RegExp, keys:string[]}} 编译结果
 */
function compilePattern(pattern) {
  const cached = patternCache.get(pattern);
  if (cached) return cached;

  const keys = [];
  const source = pattern
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        keys.push(segment.slice(1));
        return '([^/]+)';
      }
      if (segment === '*') {
        keys.push('wildcard');
        return '(.*)';
      }
      // 转义正则元字符，避免路径中的 . 、+ 等被解释为通配
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');

  const compiled = { regex: new RegExp(`^${source}/?$`), keys };
  patternCache.set(pattern, compiled);
  return compiled;
}

/** 路由未命中且方法不符时抛出的错误 */
class MethodNotAllowedError extends Error {
  /**
   * @param {string[]} allowed 该路径允许的方法列表
   */
  constructor(allowed) {
    super('请求方法不被支持');
    this.name = 'MethodNotAllowedError';
    this.allowed = allowed;
  }
}

/** 微路由器 */
class Router {
  constructor() {
    /** @type {Array<{method:string,pattern:string,regex:RegExp,keys:string[],handler:Function}>} */
    this.routes = [];
  }

  /**
   * 注册一条路由
   * @param {string} method HTTP 方法（大写）
   * @param {string} pattern 路径模式
   * @param {Function} handler 处理函数 `async (ctx) => void`
   * @returns {Router} 链式调用
   */
  register(method, pattern, handler) {
    if (typeof handler !== 'function') {
      throw new ValidationError(`路由 ${method} ${pattern} 的处理函数非法`);
    }
    const { regex, keys } = compilePattern(pattern);
    this.routes.push({ method: method.toUpperCase(), pattern, regex, keys, handler });
    return this;
  }

  /** GET 路由 */
  get(pattern, handler) {
    return this.register('GET', pattern, handler);
  }

  /** POST 路由 */
  post(pattern, handler) {
    return this.register('POST', pattern, handler);
  }

  /** PUT 路由 */
  put(pattern, handler) {
    return this.register('PUT', pattern, handler);
  }

  /** DELETE 路由 */
  delete(pattern, handler) {
    return this.register('DELETE', pattern, handler);
  }

  /** OPTIONS 路由 */
  options(pattern, handler) {
    return this.register('OPTIONS', pattern, handler);
  }

  /**
   * 匹配路由
   * @param {string} method HTTP 方法
   * @param {string} pathname 请求路径
   * @returns {{route:object, params:Record<string,string>}|null} 匹配结果
   * @throws {MethodNotAllowedError} 路径存在但方法不符
   */
  match(method, pathname) {
    const allowed = [];

    for (const route of this.routes) {
      const matched = route.regex.exec(pathname);
      if (!matched) continue;

      if (route.method !== method.toUpperCase()) {
        allowed.push(route.method);
        continue;
      }

      const params = {};
      route.keys.forEach((key, index) => {
        params[key] = decodeURIComponent(matched[index + 1] ?? '');
      });
      return { route, params };
    }

    if (allowed.length > 0) {
      throw new MethodNotAllowedError([...new Set([...allowed, 'OPTIONS'])]);
    }
    return null;
  }

  /**
   * 导出路由表（供 /api/meta/routes 展示，便于交付评审时核对接口清单）
   * @returns {Array<{method:string,path:string}>}
   */
  describe() {
    return this.routes
      .filter((route) => route.pattern.startsWith('/api'))
      .map((route) => ({ method: route.method, path: route.pattern }));
  }
}

module.exports = { Router, MethodNotAllowedError, compilePattern };
