'use strict';

/**
 * 规则集总装
 * ---------------------------------------------------------------------------
 * 把分散在 4 个文件中的规则定义汇总为一份经校验的规则清单。
 * 校验在模块加载阶段完成（fail fast）：任何规则缺少必须字段或写法有误，
 * 都会立即抛错并指明是哪一条规则，避免运行期才暴露规则失效。
 */

const securityRules = require('./security-rules');
const bugRules = require('./bug-rules');
const performanceRules = require('./performance-rules');
const styleRules = require('./style-rules');
const { SEVERITIES, DIMENSIONS } = require('../../core/taxonomy');

/** 允许的问题来源类型 */
const SCAN_TYPES = ['line', 'syntaxLine', 'rawLine', 'comment', 'custom'];

/**
 * 校验单条规则定义的合法性
 * @param {object} rule 规则定义
 * @returns {object} 校验通过的规则
 * @throws {Error} 规则非法时抛出
 */
function validateRule(rule) {
  const where = `规则 ${rule && rule.id ? rule.id : '(缺少 id)'}`;

  if (!rule || typeof rule !== 'object') throw new Error(`${where} 不是对象`);
  if (!rule.id) throw new Error(`${where} 缺少 id`);
  if (!rule.title) throw new Error(`${where} 缺少 title`);
  if (!DIMENSIONS[rule.dimension]) throw new Error(`${where} 的 dimension 非法：${rule.dimension}`);
  if (!SEVERITIES[rule.severity]) throw new Error(`${where} 的 severity 非法：${rule.severity}`);
  if (!Array.isArray(rule.languages) || rule.languages.length === 0) throw new Error(`${where} 缺少 languages`);
  if (!rule.scan || !SCAN_TYPES.includes(rule.scan.type)) throw new Error(`${where} 的 scan.type 非法`);
  if (rule.scan.type === 'custom' && typeof rule.scan.run !== 'function') {
    throw new Error(`${where} 的 scan.type=custom 必须提供 run 函数`);
  }
  if (['line', 'syntaxLine', 'rawLine', 'comment'].includes(rule.scan.type)) {
    const hasSingle = rule.scan.pattern instanceof RegExp;
    const hasMultiple = Array.isArray(rule.scan.patterns) && rule.scan.patterns.every((item) => item instanceof RegExp);
    if (!hasSingle && !hasMultiple) throw new Error(`${where} 的 scan 必须提供 pattern 或 patterns（RegExp）`);
  }

  return Object.freeze({
    maxPerFile: Number.isFinite(rule.maxPerFile) ? rule.maxPerFile : Infinity,
    ...rule,
  });
}

/** 汇总后的规则清单：按严重级别降序排列，保证输出稳定 */
const RULES = [...securityRules, ...bugRules, ...performanceRules, ...styleRules]
  .map(validateRule)
  .sort((a, b) => {
    const diff = SEVERITIES[b.severity].order - SEVERITIES[a.severity].order;
    return diff !== 0 ? diff : a.id.localeCompare(b.id);
  });

/** 规则 ID 唯一性校验 */
const seenIds = new Set();
for (const rule of RULES) {
  if (seenIds.has(rule.id)) throw new Error(`规则 ID 重复：${rule.id}`);
  seenIds.add(rule.id);
}

module.exports = RULES;
module.exports.RULES = RULES;
module.exports.validateRule = validateRule;

/**
 * 输出规则清单摘要（供 /api/meta/rules 与 CLI rules 命令使用）
 * @returns {Array<object>} 精简后的规则描述
 */
module.exports.describeRules = function describeRules() {
  return RULES.map((rule) => ({
    id: rule.id,
    title: rule.title,
    dimension: rule.dimension,
    severity: rule.severity,
    languages: rule.languages,
    description: rule.description,
    suggestion: rule.suggestion,
    reference: rule.reference,
    scanType: rule.scan.type,
  }));
};
