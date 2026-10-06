'use strict';

/**
 * 分类字典
 * ---------------------------------------------------------------------------
 * 集中定义「严重级别」与「审查维度」两个核心枚举，避免在各模块中出现魔法字符串。
 * 严重级别决定扣分权重，审查维度决定雷达图与筛选器的分面。
 */

/** 严重级别定义：order 用于排序，weight 用于评分扣分 */
const SEVERITIES = {
  blocker: { key: 'blocker', label: '阻断', order: 5, weight: 15, color: '#e5484d', icon: '⛔' },
  critical: { key: 'critical', label: '严重', order: 4, weight: 10, color: '#f76808', icon: '🔴' },
  major: { key: 'major', label: '主要', order: 3, weight: 5, color: '#f5a623', icon: '🟠' },
  minor: { key: 'minor', label: '次要', order: 2, weight: 2, color: '#3b82f6', icon: '🔵' },
  info: { key: 'info', label: '建议', order: 1, weight: 0.5, color: '#8b949e', icon: '⚪' },
};

/** 审查维度定义（大模型发现的问题会被归入对应业务维度，因此不单列「智能评审」轴） */
const DIMENSIONS = {
  security: { key: 'security', label: '安全性', color: '#e5484d', description: '密钥泄露、注入、不安全依赖等安全缺陷' },
  bug: { key: 'bug', label: '缺陷风险', color: '#f76808', description: '可能导致运行期错误的逻辑缺陷' },
  performance: { key: 'performance', label: '性能', color: '#a371f7', description: '低效实现与资源浪费' },
  readability: { key: 'readability', label: '可读性', color: '#3b82f6', description: '命名、注释、结构与风格一致性' },
  maintainability: { key: 'maintainability', label: '可维护性', color: '#2da44e', description: '复杂度、耦合度与可扩展性' },
};

/** 严重级别降序列表，便于遍历 */
const SEVERITY_ORDER = Object.values(SEVERITIES)
  .sort((a, b) => b.order - a.order)
  .map((item) => item.key);

/**
 * 归一化严重级别字符串
 * @param {string} value 原始级别
 * @returns {string} 合法级别键
 */
function normalizeSeverity(value) {
  const key = String(value || '').toLowerCase().trim();
  return SEVERITIES[key] ? key : 'minor';
}

/**
 * 归一化审查维度字符串
 * @param {string} value 原始维度
 * @returns {string} 合法维度键
 */
function normalizeDimension(value) {
  const key = String(value || '').toLowerCase().trim();
  return DIMENSIONS[key] ? key : 'maintainability';
}

module.exports = {
  SEVERITIES,
  DIMENSIONS,
  SEVERITY_ORDER,
  normalizeSeverity,
  normalizeDimension,
};
