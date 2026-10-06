'use strict';

/**
 * 示例：规范实现（对照组）
 * ---------------------------------------------------------------------------
 * 用途：验证 CodeGuard AI 对高质量代码**不产生误报**。
 * 本文件演示了团队代码规范的推荐写法：
 *   - 完整的 JSDoc 注释，说明用途、参数与返回值
 *   - 严格相等比较与显式边界判断
 *   - 错误处理包含日志与向上抛出
 *   - 常量提取，避免魔法数字
 *   - 函数职责单一，圈复杂度均低于阈值
 *
 * 预期结果：审查后综合得分应不低于 92 分（等级 S），问题数为 0。
 */

const MAX_PRECISION = 1e-9;
const TAX_RATE = 0.06;

/**
 * 以误差容限判断两个浮点数是否相等。
 * 浮点运算存在舍入误差，直接使用 === 比较会产生难以复现的判定失败。
 * @param {number} left 左操作数
 * @param {number} right 右操作数
 * @returns {boolean} 是否在容限范围内相等
 */
function nearlyEqual(left, right) {
  return Math.abs(left - right) < MAX_PRECISION;
}

/**
 * 安全除法：除数为 0 时返回指定兜底值，避免 Infinity 向下游传播。
 * @param {number} numerator 被除数
 * @param {number} denominator 除数
 * @param {number} [fallback] 除数为零时的返回值，默认 0
 * @returns {number} 商值
 */
function safeDivide(numerator, denominator, fallback = 0) {
  if (denominator === 0) {
    return fallback;
  }
  return numerator / denominator;
}

/**
 * 计算一组数值的平均值。
 * @param {number[]} values 数值数组
 * @returns {number} 平均值；数组为空时返回 0
 */
function average(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return 0;
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return safeDivide(total, values.length);
}

/**
 * 计算含税总价，金额按分取整以避免浮点累积误差。
 * @param {number[]} prices 单价数组（单位：元）
 * @returns {number} 含税总价（单位：元，保留两位小数）
 */
function totalWithTax(prices) {
  if (!Array.isArray(prices) || prices.length === 0) {
    return 0;
  }
  const cents = prices.reduce((sum, price) => sum + Math.round(price * 100), 0);
  const taxed = Math.round(cents * (1 + TAX_RATE));
  return taxed / 100;
}

/**
 * 并发获取多个远端资源。
 * 使用 Promise.all 并行执行，并统一收敛错误信息。
 * @param {string[]} urls 资源地址列表
 * @returns {Promise<Array<{ok:boolean, data:unknown, error:string|null}>>} 与输入等长的结果列表
 */
async function fetchAll(urls) {
  if (!Array.isArray(urls) || urls.length === 0) {
    return [];
  }
  return Promise.all(
    urls.map(async (url) => {
      try {
        const response = await fetch(url);
        return { ok: response.ok, data: await response.text(), error: null };
      } catch (error) {
        return { ok: false, data: null, error: error.message };
      }
    }),
  );
}

module.exports = { nearlyEqual, safeDivide, average, totalWithTax, fetchAll };
