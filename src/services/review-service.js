'use strict';

/**
 * 评审服务（业务编排层）
 * ---------------------------------------------------------------------------
 * 一次完整评审的流水线：
 *
 *   ① 静态分析   规则引擎全量扫描（确定性、零成本、始终执行）
 *   ② 语义评审   多角色大模型审查（可选，失败自动降级）
 *   ③ 结果融合   交叉印证去重，统计「被模型印证」的问题数
 *   ④ 评分计分   加权扣分模型生成综合分与五维得分
 *   ⑤ 修复建议   为重点问题生成补丁（大模型优先，内置模板兜底）
 *   ⑥ 结论生成   融合多角色结论为可读汇报
 *   ⑦ 持久化     写入 JSON 记录，返回完整结果
 *
 * 设计原则：任何一步的失败都不应导致整体失败。静态分析是可用性的底线，
 * 大模型相关步骤全部按「可选增强」处理，降级时在 warnings 中明确告知用户。
 */

const path = require('path');
const config = require('../config');
const logger = require('../core/logger');
const { store } = require('../core/storage');
const { ValidationError, NotFoundError } = require('../core/errors');
const { shortId, sha256, round, formatDuration } = require('../core/utils');
const { SEVERITIES, DIMENSIONS } = require('../core/taxonomy');
const { analyze } = require('../analyzers/static-analyzer');
const { LlmClient } = require('../agents/llm-client');
const { ReviewAgent } = require('../agents/review-agent');
const { FixAgent } = require('../agents/fix-agent');
const { computeScore } = require('./score-service');
const { exportReport } = require('./report-service');

const log = logger.child('review-service');

/** 应用版本，写入记录便于结果追溯 */
const APP_VERSION = config.pkg.version;

/** 同一位置、同一维度的模型结论视为对规则结论的印证，不再重复计入 */
const CONFIRM_LINE_WINDOW = 2;

/**
 * 融合静态与模型结论
 * @param {object[]} staticIssues 规则引擎问题
 * @param {object[]} llmIssues 大模型问题
 * @returns {{issues:object[], confirmed:number, llmOnly:number}} 融合结果
 */
function mergeIssues(staticIssues, llmIssues) {
  const merged = [...staticIssues];
  const confirmedIds = new Set();

  for (const candidate of llmIssues) {
    const duplicate = staticIssues.find(
      (issue) =>
        issue.dimension === candidate.dimension &&
        Math.abs(issue.line - candidate.line) <= CONFIRM_LINE_WINDOW,
    );
    if (duplicate) {
      confirmedIds.add(candidate.id);
      // 记录交叉印证次数，体现「双引擎一致」的可信度加成
      duplicate.confirmedBy = (duplicate.confirmedBy || 0) + 1;
      continue;
    }
    merged.push(candidate);
  }

  merged.sort((a, b) => {
    if (b.severityOrder !== a.severityOrder) return b.severityOrder - a.severityOrder;
    return a.line - b.line;
  });

  return {
    issues: merged,
    confirmed: confirmedIds.size,
    llmOnly: llmIssues.length - confirmedIds.size,
  };
}

/** 评审服务 */
class ReviewService {
  /**
   * @param {object} [options] 选项
   * @param {LlmClient} [options.client] 大模型客户端
   * @param {object} [options.store] 存储实例
   */
  constructor(options = {}) {
    this.client = options.client || new LlmClient();
    this.reviewAgent = new ReviewAgent({ client: this.client });
    this.fixAgent = new FixAgent({ client: this.client });
    this.store = options.store || store;
  }

  /**
   * 校验并规范化输入
   * @param {object} input 原始输入
   * @returns {object} 规范化后的输入
   */
  normalizeInput(input = {}) {
    const code = typeof input.code === 'string' ? input.code : '';
    if (!code.trim()) {
      throw new ValidationError('送审代码不能为空', { field: 'code' });
    }

    const MAX_CHARS = 800_000;
    if (code.length > MAX_CHARS) {
      throw new ValidationError(`送审代码过长（${code.length} 字符），上限为 ${MAX_CHARS} 字符`, { field: 'code' });
    }

    const fileName = input.fileName ? path.basename(String(input.fileName)) : null;
    const title = String(input.title || fileName || '未命名代码片段').slice(0, 120);

    const ALLOWED_ROLES = ['security', 'bug', 'performance', 'readability'];
    const roles = Array.isArray(input.roles) && input.roles.length > 0
      ? input.roles.filter((role) => ALLOWED_ROLES.includes(role))
      : ALLOWED_ROLES;

    return {
      code,
      fileName,
      title,
      language: input.language ? String(input.language) : null,
      dimensions: Array.isArray(input.dimensions) && input.dimensions.length > 0
        ? input.dimensions.filter((key) => DIMENSIONS[key])
        : null,
      roles,
      minSeverity: SEVERITIES[input.minSeverity] ? input.minSeverity : null,
      ignoreRules: Array.isArray(input.ignoreRules) ? input.ignoreRules.map(String).slice(0, 100) : [],
      useLlm: input.useLlm === undefined ? config.review.enableLlm : Boolean(input.useLlm),
      includeFixes: input.includeFixes !== false,
      fixLimit: Math.min(Math.max(Number(input.fixLimit) || 5, 0), 15),
      includeSummary: input.includeSummary !== false,
    };
  }

  /**
   * 执行一次完整评审
   * @param {object} input 评审输入
   * @returns {Promise<object>} 评审记录
   */
  async review(input) {
    const normalized = this.normalizeInput(input);
    const startedAt = Date.now();
    const warnings = [];

    // ---------- ① 静态分析 ----------
    const staticResult = analyze({
      code: normalized.code,
      fileName: normalized.fileName,
      language: normalized.language,
      dimensions: normalized.dimensions,
      minSeverity: normalized.minSeverity,
      ignoreRules: normalized.ignoreRules,
    });

    const profile = staticResult.profile;
    const metrics = staticResult.metrics;

    // ---------- ② 语义评审 ----------
    let llmResult = {
      enabled: false,
      issues: [],
      roleSummaries: {},
      roles: [],
      usage: { calls: 0, totalTokens: 0 },
      warnings: [],
      errors: [],
      durationMs: 0,
      model: null,
    };

    if (normalized.useLlm) {
      llmResult = await this.reviewAgent.review({
        code: normalized.code,
        language: profile.label,
        fileName: normalized.fileName,
        roles: normalized.roles,
        staticIssues: staticResult.issues,
        metrics,
      });
      warnings.push(...(llmResult.warnings || []));
    } else {
      warnings.push('大模型评审已关闭，本次仅执行本地规则引擎审查（可离线运行）');
    }

    // 维度过滤同样作用于模型结论
    const llmIssues = normalized.dimensions
      ? llmResult.issues.filter((issue) => normalized.dimensions.includes(issue.dimension))
      : llmResult.issues;

    // ---------- ③ 结果融合 ----------
    const merged = mergeIssues(staticResult.issues, llmIssues);

    // ---------- ④ 评分 ----------
    const score = computeScore({ issues: merged.issues, metrics });

    // ---------- ⑤ 修复建议 ----------
    let fixes = [];
    if (normalized.includeFixes && normalized.fixLimit > 0 && merged.issues.length > 0) {
      try {
        fixes = await this.fixAgent.suggestFixBatch({
          issues: merged.issues,
          code: normalized.code,
          language: profile.label,
          limit: normalized.fixLimit,
          // 离线模式必须走模板，确保「零大模型调用」的承诺不因修复建议而破例
          allowLlm: normalized.useLlm,
        });
      } catch (error) {
        warnings.push(`生成修复建议失败：${error.message}`);
      }
    }

    // ---------- ⑥ 结论生成 ----------
    let summary = null;
    if (normalized.useLlm && normalized.includeSummary && llmResult.enabled) {
      summary = await this.reviewAgent.summarize({ score, issues: merged.issues, metrics });
    }
    if (!summary) {
      // 无大模型时给出确定性的兜底结论，保证报告结构完整
      const blockers = merged.issues.filter((issue) => ['blocker', 'critical'].includes(issue.severity));
      summary = {
        overview: `本次共发现 ${merged.issues.length} 个问题，其中阻断/严重级别 ${blockers.length} 个。综合得分 ${score.overall}（等级 ${score.grade}）。`,
        highlights: metrics.commentRatio >= 0.1 ? [`注释率 ${(metrics.commentRatio * 100).toFixed(1)}%，达到建议水平`] : [],
        blockers: blockers.slice(0, 5).map((issue) => `第 ${issue.line} 行：${issue.title}`),
        actions: score.deductions.slice(0, 5).map((item) => `处理 ${item.ruleId}（${item.title}），预计可挽回约 ${item.applied} 分`),
        offline: true,
      };
    }

    // ---------- ⑦ 组装与持久化 ----------
    const severityCounts = {};
    for (const key of Object.keys(SEVERITIES)) severityCounts[key] = 0;
    const ruleHits = {};
    for (const issue of merged.issues) {
      severityCounts[issue.severity] += 1;
      ruleHits[issue.ruleId] = (ruleHits[issue.ruleId] || 0) + 1;
    }

    const durationMs = Date.now() - startedAt;
    const record = {
      id: shortId('rv'),
      createdAt: new Date().toISOString(),
      source: {
        title: normalized.title,
        fileName: normalized.fileName,
        language: profile.label,
        languageKey: profile.key,
        languageDetectedBy: profile.detectedBy,
        codeHash: sha256(normalized.code),
        totalLines: staticResult.metrics.totalLines,
        /** 仅保留送审代码的前 4000 字符用于历史回溯，避免记录体积膨胀 */
        codePreview: normalized.code.slice(0, 4000),
        codeTruncated: normalized.code.length > 4000,
      },
      options: {
        useLlm: normalized.useLlm,
        roles: normalized.roles,
        dimensions: normalized.dimensions,
        minSeverity: normalized.minSeverity,
        ignoreRules: normalized.ignoreRules,
        includeFixes: normalized.includeFixes,
        fixLimit: normalized.fixLimit,
      },
      engines: {
        static: true,
        llm: Boolean(llmResult.enabled),
        llmRoles: llmResult.roles || [],
      },
      metrics,
      score,
      issues: merged.issues,
      fixes,
      summary,
      llm: {
        enabled: Boolean(llmResult.enabled),
        model: llmResult.model,
        roles: llmResult.roles || [],
        roleSummaries: llmResult.roleSummaries || {},
        usage: llmResult.usage || {},
        durationMs: llmResult.durationMs || 0,
        errors: llmResult.errors || [],
      },
      stats: {
        durationMs,
        staticIssueCount: staticResult.issues.length,
        llmIssueCount: llmIssues.length,
        confirmedCount: merged.confirmed,
        llmOnlyCount: merged.llmOnly,
        issueCount: merged.issues.length,
        severityCounts,
        dimensionCounts: Object.keys(DIMENSIONS).reduce((acc, key) => {
          acc[key] = merged.issues.filter((issue) => issue.dimension === key).length;
          return acc;
        }, {}),
        appliedRuleCount: staticResult.stats.appliedRuleCount,
        ruleCount: staticResult.stats.ruleCount,
        ruleHits,
        estimatedPenalty: staticResult.stats.estimatedPenalty,
      },
      warnings,
      meta: {
        version: APP_VERSION,
        ruleVersion: 'v1',
        engine: 'codeguard-ai',
        scoreModel: score.model.name,
      },
    };

    this.store.save(record);
    log.info(
      `评审完成 ${record.id}：${record.source.language} / ${merged.issues.length} 个问题 / 得分 ${score.overall} / 耗时 ${formatDuration(durationMs)}`,
    );

    return record;
  }

  /**
   * 读取评审记录
   * @param {string} id 记录 ID
   * @returns {object} 记录
   */
  get(id) {
    return this.store.get(id);
  }

  /**
   * 分页查询记录
   * @param {object} [options] 查询条件
   * @returns {object} 分页结果
   */
  list(options) {
    return this.store.list(options);
  }

  /**
   * 删除记录
   * @param {string} id 记录 ID
   * @returns {boolean} 是否成功
   */
  remove(id) {
    const record = this.store.get(id);
    if (!record) throw new NotFoundError(`评审记录不存在：${id}`);
    return this.store.remove(id);
  }

  /**
   * 导出报告
   * @param {string} id 记录 ID
   * @param {string} format 格式
   * @returns {{content:string, contentType:string, fileName:string}} 导出结果
   */
  exportReport(id, format) {
    const record = this.store.get(id);
    return exportReport(record, format);
  }

  /**
   * 汇总统计（用于首页概览）
   * @returns {object} 统计信息
   */
  overview() {
    const { items, total } = this.store.list({ limit: 200 });
    const scored = items.filter((item) => typeof item.score === 'number');
    const averageScore = scored.length
      ? round(scored.reduce((sum, item) => sum + item.score, 0) / scored.length, 1)
      : null;
    const totalIssues = items.reduce((sum, item) => sum + (item.issueCount || 0), 0);

    return {
      totalReviews: total,
      averageScore,
      totalIssues,
      languageDistribution: items.reduce((acc, item) => {
        const key = item.language || 'text';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {}),
      recent: items.slice(0, 10),
      llm: {
        provider: config.llm.provider,
        model: config.llm.model,
        available: this.client.available,
      },
    };
  }
}

module.exports = { ReviewService, mergeIssues, APP_VERSION };
