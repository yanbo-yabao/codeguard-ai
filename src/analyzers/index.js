'use strict';

/**
 * 分析能力门面
 * ---------------------------------------------------------------------------
 * 对外只暴露一个稳定的入口，隐藏内部模块划分（语言画像 / 度量 / 规则 / 引擎），
 * 便于后续替换实现或增加新的分析后端而不影响调用方。
 */

const { detectLanguage, splitCodeAndComments, blankStrings, splitLines, LANGUAGES } = require('./languages');
const { computeMetrics } = require('./metrics');
const { analyze, analyzeFile, describeRules, RULES } = require('./static-analyzer');

module.exports = {
  /** 执行静态分析（核心入口） */
  analyze,
  /** 分析磁盘上的单个文件 */
  analyzeFile,
  /** 规则清单与元数据 */
  describeRules,
  /** 规则总数 */
  ruleCount: RULES.length,
  /** 语言识别 */
  detectLanguage,
  /** 预处理工具（供测试与二次开发使用） */
  splitCodeAndComments,
  blankStrings,
  splitLines,
  /** 度量引擎 */
  computeMetrics,
  /** 支持的语言画像表 */
  LANGUAGES,
};
