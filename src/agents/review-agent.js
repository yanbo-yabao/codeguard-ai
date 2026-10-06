'use strict';

/**
 * 多角色审查 Agent
 * ---------------------------------------------------------------------------
 * 编排逻辑：
 *   1. 代码分段 —— 超长文件按空行对齐切块，避免超出模型上下文且保持语义完整；
 *   2. 角色并发 —— 安全 / 缺陷 / 性能 / 可维护性四个专家角色并行评审，并发度受配置限制；
 *   3. 结果归一 —— 把各角色的自由文本结论收敛为统一的问题对象，做字段校验与行号校正；
 *   4. 降级容错 —— 任一角色失败不影响其余角色；全部失败时返回明确告警而非抛出异常，
 *      使「静态分析」部分的结果始终可用（这是产品可用性的关键设计）。
 */

const config = require('../config');
const logger = require('../core/logger');
const { shortId, clamp, round, mapWithConcurrency, formatDuration } = require('../core/utils');
const { SEVERITIES, DIMENSIONS, normalizeSeverity, normalizeDimension } = require('../core/taxonomy');
const { ROLES, buildReviewPrompt, buildSummaryPrompt } = require('./prompt-templates');

const log = logger.child('review-agent');

/** 可用的角色键 */
const AVAILABLE_ROLES = Object.keys(ROLES);

/**
 * 把源码切分为若干片段
 * @param {string} code 源码
 * @param {object} [options] 选项
 * @param {number} [options.chunkLines] 单片段行数
 * @param {number} [options.maxLines] 允许送审的最大行数
 * @returns {{chunks:Array<{startLine:number,endLine:number,code:string}>, truncated:boolean}}
 */
function splitIntoChunks(code, options = {}) {
  const chunkLines = options.chunkLines || config.review.chunkLines;
  const maxLines = options.maxLines || config.review.maxLines;
  const lines = String(code ?? '').split('\n');

  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    return {
      chunks: splitIntoChunks(kept.join('\n'), { chunkLines, maxLines: Infinity }).chunks,
      truncated: true,
    };
  }

  if (lines.length <= chunkLines) {
    return { chunks: [{ startLine: 1, endLine: lines.length, code: lines.join('\n') }], truncated: false };
  }

  const chunks = [];
  let start = 0;

  while (start < lines.length) {
    let end = Math.min(start + chunkLines, lines.length);

    // 尽量在空行处切分，保持函数与代码块的完整性（最多前后各回溯/前探 40 行）
    if (end < lines.length) {
      const lower = Math.max(start + Math.floor(chunkLines / 2), end - 40);
      const upper = Math.min(lines.length, end + 40);
      for (let probe = end; probe >= lower; probe -= 1) {
        if (!lines[probe] || !lines[probe].trim()) {
          end = probe;
          break;
        }
      }
      if (end <= start) end = Math.min(start + chunkLines, lines.length);
    }

    chunks.push({
      startLine: start + 1,
      endLine: end,
      code: lines.slice(start, end).join('\n'),
    });
    start = end;
  }

  return { chunks, truncated: false };
}

/**
 * 归一化单个模型返回的问题条目
 * @param {object} raw 模型返回的原始条目
 * @param {object} meta 上下文（角色、片段起始行、语言）
 * @returns {object|null} 标准化问题对象；非法条目返回 null
 */
function normalizeFinding(raw, meta) {
  if (!raw || typeof raw !== 'object') return null;

  const line = Number.parseInt(raw.line, 10);
  const title = String(raw.title || '').trim();
  const message = String(raw.message || '').trim();
  if (!title || !message) return null;

  // 行号可能超出片段范围：夹取到合法区间，避免报告出现指向错误行的情况
  const safeLine = Number.isFinite(line)
    ? clamp(line, meta.startLine, meta.endLine)
    : meta.startLine;

  const severity = normalizeSeverity(raw.severity);
  const dimension = raw.dimension && DIMENSIONS[raw.dimension] ? raw.dimension : ROLES[meta.role].dimension;
  const confidence = Number.isFinite(Number(raw.confidence)) ? clamp(Number(raw.confidence), 0, 1) : 0.7;

  return {
    id: `LLM:${meta.role}:${shortId()}`,
    ruleId: `LLM-${meta.role.toUpperCase().slice(0, 3)}`,
    title: title.slice(0, 60),
    dimension,
    dimensionLabel: DIMENSIONS[dimension].label,
    severity,
    severityLabel: SEVERITIES[severity].label,
    severityOrder: SEVERITIES[severity].order,
    message: message.slice(0, 600),
    line: safeLine,
    column: 1,
    snippet: (meta.lines[safeLine - meta.startLine] || '').trim().slice(0, 200),
    suggestion: String(raw.suggestion || '').trim().slice(0, 800),
    reference: `大模型语义评审 · ${ROLES[meta.role].label}`,
    source: 'llm',
    role: meta.role,
    roleLabel: ROLES[meta.role].label,
    confidence: round(confidence, 2),
    model: meta.model || null,
  };
}

/** 多角色审查 Agent */
class ReviewAgent {
  /**
   * @param {object} options 选项
   * @param {import('./llm-client').LlmClient} options.client 大模型客户端
   */
  constructor({ client }) {
    this.client = client;
  }

  /**
   * 执行多角色评审
   * @param {object} input 输入
   * @param {string} input.code 源码
   * @param {string} [input.language] 语言标签
   * @param {string} [input.fileName] 文件名
   * @param {string[]} [input.roles] 启用的角色
   * @param {Array<object>} [input.staticIssues] 静态规则已发现的问题（用于提示模型避免重复）
   * @param {object} [input.metrics] 度量结果
   * @returns {Promise<object>} 评审结果
   */
  async review(input) {
    const startedAt = Date.now();
    const roles = (input.roles && input.roles.length ? input.roles : AVAILABLE_ROLES).filter((role) =>
      AVAILABLE_ROLES.includes(role),
    );

    const warnings = [];
    if (!this.client.available) {
      return {
        enabled: false,
        issues: [],
        roleSummaries: {},
        roles: [],
        usage: { calls: 0, totalTokens: 0 },
        warnings: ['大模型未配置或调用不可用，本次仅执行本地规则引擎审查'],
        errors: [],
        durationMs: 0,
        model: null,
      };
    }

    const { chunks, truncated } = splitIntoChunks(input.code);
    if (truncated) {
      warnings.push(`代码行数超过 ${config.review.maxLines} 行上限，已截断后送审，超长部分仅由规则引擎覆盖`);
    }

    /** 构造全部「角色 × 片段」任务 */
    const tasks = [];
    for (const role of roles) {
      for (const chunk of chunks) {
        tasks.push({ role, chunk });
      }
    }

    const staticHints = (input.staticIssues || []).slice(0, 40).map((issue) => ({
      line: issue.line,
      title: issue.title,
      ruleId: issue.ruleId,
    }));

    const settled = await mapWithConcurrency(tasks, config.review.concurrency, async (task) => {
      const messages = buildReviewPrompt({
        role: task.role,
        code: task.chunk.code,
        language: input.language || 'text',
        fileName: input.fileName,
        startLine: task.chunk.startLine,
        totalLines: input.metrics?.totalLines,
        metrics: input.metrics,
        staticHints,
      });
      const payload = await this.client.chatJson({ messages });
      return { ...task, payload };
    });

    const issues = [];
    const roleSummaries = {};
    const errors = [];
    const usedRoles = new Set();
    let model = null;

    settled.forEach((outcome) => {
      if (!outcome.ok) {
        errors.push(outcome.error?.message || '未知错误');
        return;
      }
      const { role, chunk, payload } = outcome.value;
      usedRoles.add(role);
      if (payload._meta?.model) model = payload._meta.model;

      if (payload.summary) {
        roleSummaries[role] = roleSummaries[role]
          ? `${roleSummaries[role]} ${payload.summary}`
          : String(payload.summary);
      }

      const findings = Array.isArray(payload.findings) ? payload.findings : [];
      const chunkLines = chunk.code.split('\n');
      for (const raw of findings.slice(0, 20)) {
        const normalized = normalizeFinding(raw, {
          role,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          lines: chunkLines,
          model: payload._meta?.model,
        });
        if (normalized) issues.push(normalized);
      }
    });

    if (errors.length > 0) {
      warnings.push(
        `${errors.length} 次大模型调用失败，已自动降级：${[...new Set(errors)].slice(0, 2).join('；')}`,
      );
    }

    const durationMs = Date.now() - startedAt;
    log.info(
      `多角色评审完成：角色 ${usedRoles.size}/${roles.length}，问题 ${issues.length} 条，耗时 ${formatDuration(durationMs)}`,
    );

    return {
      enabled: true,
      issues,
      roleSummaries,
      roles: [...usedRoles],
      usage: { ...this.client.usage },
      warnings,
      errors,
      durationMs,
      model,
      chunks: chunks.length,
    };
  }

  /**
   * 生成整体结论（把多角色结论融合为可读汇报）
   * @param {object} input 输入
   * @returns {Promise<object|null>} 结论对象；不可用时返回 null
   */
  async summarize({ score, issues, metrics }) {
    if (!this.client.available) return null;
    try {
      const payload = await this.client.chatJson({
        messages: buildSummaryPrompt({ score, issues, metrics }),
        temperature: 0.3,
      });
      const overview = String(payload.overview || '').trim();
      // 模型未按要求返回 overview 时交由调用方走确定性兜底，避免报告出现空白结论
      if (!overview) return null;
      return {
        overview,
        highlights: Array.isArray(payload.highlights) ? payload.highlights.slice(0, 3) : [],
        blockers: Array.isArray(payload.blockers) ? payload.blockers.slice(0, 5) : [],
        actions: Array.isArray(payload.actions) ? payload.actions.slice(0, 5) : [],
      };
    } catch (error) {
      log.warn(`生成整体结论失败：${error.message}`);
      return null;
    }
  }
}

module.exports = { ReviewAgent, splitIntoChunks, normalizeFinding, AVAILABLE_ROLES };
