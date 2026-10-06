'use strict';

/**
 * 静态分析引擎
 * ---------------------------------------------------------------------------
 * 职责：把「语言画像 + 度量结果 + 规则清单」组装成一次完整的静态审查，
 * 输出结构统一、可直接进入评分与报告的问题列表。
 *
 * 执行流水线：
 *   源码 → 语言识别 → 注释/字符串分离 → 度量计算 → 规则匹配 → 过滤 → 去重 → 排序
 *
 * 规则扫描类型的语义：
 *   line       在「已剥离注释」的文本上逐行匹配（保留字符串，用于凭据类检测）
 *   syntaxLine 在「剥离注释与字符串」的纯语法文本上逐行匹配（用于运算符与关键字）
 *   comment    在「仅注释」文本上匹配（用于 TODO 等）
 *   custom     交给规则自定义函数，可访问完整上下文与度量结果
 */

const fs = require('fs');
const path = require('path');
const { detectLanguage, splitCodeAndComments, blankStrings, splitLines } = require('./languages');
const { computeMetrics, buildLineIndex, lineOf } = require('./metrics');
const RULES = require('./rules');
const { SEVERITIES, DIMENSIONS, normalizeSeverity } = require('../core/taxonomy');
const { sha256, round } = require('../core/utils');
const logger = require('../core/logger');

const log = logger.child('static-analyzer');

/** 片段截断长度，避免报告体积失控 */
const SNIPPET_LIMIT = 200;

/**
 * 渲染规则消息模板
 * @param {string} template 模板文本，支持 {match}、{1}、{length} 占位符
 * @param {object} entry 命中条目
 * @returns {string} 渲染后的消息
 */
function formatMessage(template, entry) {
  return String(template || '')
    .replace(/\{match\}/g, entry.matchText || '')
    .replace(/\{length\}/g, String((entry.lineText || '').length))
    .replace(/\{(\d+)\}/g, (_, index) => {
      const value = entry.matchArray ? entry.matchArray[Number(index)] : '';
      return value === undefined || value === null ? '' : String(value);
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 在给定行集合上执行一组正则
 * @param {RegExp[]} patterns 正则数组
 * @param {string[]} lines 待扫描行
 * @param {object} ctx 分析上下文
 * @param {Function} [filter] 命中过滤器 `(matchArray, lineText, ctx) => boolean`
 * @returns {Array<object>} 命中条目
 */
function collectByPatterns(patterns, lines, ctx, filter) {
  const found = [];

  for (let i = 0; i < lines.length; i += 1) {
    const lineText = lines[i];
    if (!lineText || !lineText.trim()) continue;

    for (const pattern of patterns) {
      // 每条规则在每个位置只报一次，避免同一行重复计数
      const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
      const re = new RegExp(pattern.source, flags);
      let match;
      let matchedOnThisLine = false;

      while ((match = re.exec(lineText)) !== null) {
        if (match[0].length === 0) {
          re.lastIndex += 1;
          continue;
        }
        if (filter && !filter(match, lineText, ctx)) continue;

        found.push({
          line: i + 1,
          column: match.index + 1,
          matchArray: match,
          matchText: match[0],
          lineText,
        });

        // 同一模式在同一行只保留首个命中，防止密集匹配淹没报告
        matchedOnThisLine = true;
        break;
      }

      if (matchedOnThisLine) continue;
    }
  }

  return found;
}

/**
 * 执行单条规则
 * @param {object} rule 规则定义
 * @param {object} ctx 分析上下文
 * @returns {Array<object>} 命中条目
 */
function runRule(rule, ctx) {
  const scan = rule.scan;

  if (scan.type === 'custom') {
    const output = scan.run(ctx) || [];
    return output.map((entry) => ({
      line: entry.line || 1,
      column: entry.column || 1,
      matchText: entry.matchText || '',
      messageOverride: entry.message || null,
      lineText: ctx.originalLines[(entry.line || 1) - 1] || '',
      matchArray: null,
    }));
  }

  const patterns = scan.patterns || [scan.pattern];
  const lines =
    scan.type === 'comment'
      ? ctx.commentLines
      : scan.type === 'syntaxLine'
        ? ctx.syntaxLines
        : scan.type === 'rawLine'
          ? ctx.originalLines
          : ctx.codeLines;

  return collectByPatterns(patterns, lines, ctx, scan.filter);
}

/**
 * 组装问题对象
 * @param {object} rule 规则定义
 * @param {object} entry 命中条目
 * @param {object} ctx 分析上下文
 * @returns {object} 标准问题对象
 */
function buildIssue(rule, entry, ctx) {
  const original = ctx.originalLines[entry.line - 1] ?? '';
  const snippet = original.trim().slice(0, SNIPPET_LIMIT);

  return {
    id: `${rule.id}:${entry.line}:${entry.column}`,
    ruleId: rule.id,
    title: rule.title,
    dimension: rule.dimension,
    dimensionLabel: DIMENSIONS[rule.dimension].label,
    severity: normalizeSeverity(rule.severity),
    severityLabel: SEVERITIES[normalizeSeverity(rule.severity)].label,
    severityOrder: SEVERITIES[normalizeSeverity(rule.severity)].order,
    message: entry.messageOverride || formatMessage(rule.message, entry),
    line: entry.line,
    column: entry.column,
    snippet,
    suggestion: rule.suggestion,
    reference: rule.reference || null,
    source: 'static',
    confidence: 0.9,
  };
}

/**
 * 构建分析上下文
 * @param {object} input 输入
 * @returns {object} 上下文对象
 */
function buildContext({ code, profile }) {
  const source = String(code ?? '');
  const { code: codeOnly, comments: commentOnly } = splitCodeAndComments(source, profile);
  const syntaxOnly = blankStrings(codeOnly, profile);
  const metrics = computeMetrics({ code: source, codeOnly, commentOnly, profile });
  const lineIndex = buildLineIndex(source);

  const originalLines = splitLines(source);
  const codeLines = splitLines(codeOnly);
  const syntaxLines = splitLines(syntaxOnly);
  const commentLines = splitLines(commentOnly);

  return {
    source,
    codeOnly,
    commentOnly,
    syntaxOnly,
    originalLines,
    codeLines,
    syntaxLines,
    commentLines,
    profile,
    metrics,
    /** 字符偏移 → 行号（1 基） */
    lineOfOffset: (offset) => lineOf(lineIndex, offset),
    /** 取原始行文本 */
    originalLine: (lineNo) => originalLines[lineNo - 1] ?? '',
    /** 取纯语法行文本 */
    syntaxLine: (lineNo) => syntaxLines[lineNo - 1] ?? '',
  };
}

/**
 * 判断规则是否适用于当前语言与维度过滤条件
 * @param {object} rule 规则
 * @param {object} profile 语言画像
 * @param {Set<string>|null} dimensionFilter 维度白名单
 * @param {Set<string>} ignoreRules 忽略的规则 ID
 * @returns {boolean} 是否执行
 */
function isApplicable(rule, profile, dimensionFilter, ignoreRules) {
  if (ignoreRules.has(rule.id)) return false;
  if (dimensionFilter && !dimensionFilter.has(rule.dimension)) return false;
  if (rule.languages.includes('*')) return true;
  return rule.languages.includes(profile.key);
}

/**
 * 执行静态分析
 * @param {object} options 选项
 * @param {string} options.code 源码
 * @param {string} [options.fileName] 文件名，用于语言推断
 * @param {string} [options.language] 显式指定语言
 * @param {string[]} [options.dimensions] 仅启用这些维度
 * @param {string} [options.minSeverity] 最低严重级别（低于该级别的问题将被过滤）
 * @param {string[]} [options.ignoreRules] 忽略的规则 ID
 * @returns {{profile:object, metrics:object, issues:object[], stats:object}}
 */
function analyze(options = {}) {
  const startedAt = Date.now();
  const source = String(options.code ?? '');
  const profile = detectLanguage({
    fileName: options.fileName,
    code: source,
    language: options.language,
  });

  const ctx = buildContext({ code: source, profile });

  const dimensionFilter =
    Array.isArray(options.dimensions) && options.dimensions.length > 0
      ? new Set(options.dimensions.filter((key) => DIMENSIONS[key]))
      : null;
  const ignoreRules = new Set(Array.isArray(options.ignoreRules) ? options.ignoreRules : []);
  const minOrder = options.minSeverity && SEVERITIES[options.minSeverity]
    ? SEVERITIES[options.minSeverity].order
    : 0;

  const collected = [];
  for (const rule of RULES) {
    if (!isApplicable(rule, profile, dimensionFilter, ignoreRules)) continue;
    let entries;
    try {
      entries = runRule(rule, ctx);
    } catch (error) {
      // 单条规则异常不应中断整次审查
      log.warn(`规则 ${rule.id} 执行失败：${error.message}`);
      continue;
    }
    for (const entry of entries.slice(0, rule.maxPerFile)) {
      collected.push(buildIssue(rule, entry, ctx));
    }
  }

  // 去重：同一规则在同一行只保留一条（不同规则命中同一行需分别保留）
  const deduped = new Map();
  for (const issue of collected) {
    const key = `${issue.ruleId}|${issue.line}`;
    if (!deduped.has(key)) deduped.set(key, issue);
  }

  const issues = [...deduped.values()]
    .filter((issue) => issue.severityOrder >= minOrder)
    .sort((a, b) => {
      if (b.severityOrder !== a.severityOrder) return b.severityOrder - a.severityOrder;
      return a.line - b.line;
    });

  const severityCounts = {};
  for (const key of Object.keys(SEVERITIES)) severityCounts[key] = 0;
  const dimensionCounts = {};
  for (const key of Object.keys(DIMENSIONS)) dimensionCounts[key] = 0;
  for (const issue of issues) {
    severityCounts[issue.severity] += 1;
    dimensionCounts[issue.dimension] += 1;
  }

  log.debug(
    `静态分析完成：${profile.label} / ${ctx.metrics.totalLines} 行 / ${issues.length} 个问题 / ${Date.now() - startedAt}ms`,
  );

  return {
    profile,
    metrics: ctx.metrics,
    issues,
    artifacts: {
      codeOnly: ctx.codeOnly,
      commentOnly: ctx.commentOnly,
      syntaxOnly: ctx.syntaxOnly,
    },
    stats: {
      engine: 'static',
      ruleCount: RULES.length,
      appliedRuleCount: RULES.filter((rule) => isApplicable(rule, profile, dimensionFilter, ignoreRules)).length,
      issueCount: issues.length,
      severityCounts,
      dimensionCounts,
      durationMs: Date.now() - startedAt,
      codeHash: sha256(source),
      estimatedPenalty: round(
        issues.reduce((sum, issue) => sum + SEVERITIES[issue.severity].weight, 0),
        2,
      ),
    },
  };
}

/**
 * 读取磁盘文件并分析
 * @param {string} filePath 源码文件路径
 * @param {object} [options] 传递给 analyze 的其他选项
 * @returns {object} 分析结果（附加 fileName / filePath）
 */
function analyzeFile(filePath, options = {}) {
  const absolute = path.resolve(filePath);
  const code = fs.readFileSync(absolute, 'utf8');
  const fileName = path.basename(absolute);
  const result = analyze({ ...options, code, fileName });
  return { ...result, filePath: absolute, fileName };
}

/**
 * 规则清单（附当前可用语言）
 * @returns {object} 规则元数据
 */
function describeRules() {
  return {
    total: RULES.length,
    dimensions: Object.values(DIMENSIONS),
    severities: Object.values(SEVERITIES).sort((a, b) => b.order - a.order),
    rules: require('./rules').describeRules(),
  };
}

module.exports = {
  analyze,
  analyzeFile,
  describeRules,
  formatMessage,
  RULES,
};
