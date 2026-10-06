'use strict';

/**
 * 通用工具函数集
 */

const crypto = require('crypto');

/**
 * 生成短 ID（时间戳 + 随机后缀，可读性优于 UUID，且天然按时间有序）
 * @param {string} [prefix] 前缀
 * @returns {string} 形如 rv_lq3k9x_a1b2
 */
function shortId(prefix = '') {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(3).toString('hex');
  return prefix ? `${prefix}_${ts}_${rand}` : `${ts}_${rand}`;
}

/**
 * 计算文本的 SHA-256 摘要，用于评审结果缓存与去重
 * @param {string} text 输入文本
 * @returns {string} 十六进制摘要
 */
function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/**
 * 限制数值范围
 * @param {number} value 输入值
 * @param {number} min 下界
 * @param {number} max 上界
 * @returns {number} 截断后的值
 */
function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * 数字保留指定小数位（返回数字类型）
 * @param {number} value 输入值
 * @param {number} [digits] 小数位
 * @returns {number} 结果
 */
function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

/**
 * 转义 HTML 特殊字符，防止报告导出时产生 XSS
 * @param {string} text 输入文本
 * @returns {string} 转义结果
 */
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 将毫秒数格式化为人类可读字符串
 * @param {number} ms 毫秒
 * @returns {string} 例如 "1.23s"
 */
function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
}

/**
 * 判断字符串是否为空（null/undefined/纯空白）
 * @param {unknown} value 待判断值
 * @returns {boolean} 是否为空
 */
function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

/**
 * 带并发上限的批量异步映射
 * ---------------------------------------------------------------------------
 * 用于控制大模型调用并发：既避免瞬间打满速率限制，也不退化为完全串行。
 * 单个任务的异常会被捕获并交由调用方处理，不会中断整批任务。
 * @template T,R
 * @param {T[]} items 待处理列表
 * @param {number} limit 并发上限
 * @param {(item:T, index:number)=>Promise<R>} worker 处理函数
 * @returns {Promise<Array<{ok:boolean,value?:R,error?:Error,index:number}>>} 结果列表（与输入同序）
 */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  const concurrency = Math.max(1, Math.min(Number(limit) || 1, items.length || 1));
  let cursor = 0;

  const runner = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = { ok: true, value: await worker(items[index], index), index };
      } catch (error) {
        results[index] = { ok: false, error, index };
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, runner));
  return results;
}

module.exports = {
  shortId,
  sha256,
  clamp,
  round,
  escapeHtml,
  formatDuration,
  isBlank,
  mapWithConcurrency,
};
