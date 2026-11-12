'use strict';

/**
 * 代码补全服务（业务编排层）
 * ---------------------------------------------------------------------------
 * 提供三个相互独立的功能，通过 feature 参数区分：
 *
 * 【功能 A：AI 解题与补全】feature = 'complete'
 *   输入问题 / 提示词（可附代码、可附图片）→ 解题讲解 + 完整代码
 *   流水线：大模型解题补全（多模态）→ 结果语法自检 → 产出安全复检
 *
 * 【功能 B：错误检查与修复】feature = 'fix'
 *   输入代码（可附期望行为描述）→ 逐条错误的修改方法 + 修复后的完整代码
 *   流水线：静态语法检查（确定性）→ 大模型诊断（含修复）→ 修复结果语法自检
 *           → 静态与大模型结论交叉印证
 *
 * 【功能 C：变式出题】feature = 'quiz'
 *   输入刚学过的题目 / 知识点 → 在原题基础上微改的变式题 + 测试用例 + 参考答案
 *   （配合 /api/run 判题与调试，形成「学 → 练 → 调」闭环）
 *
 * 设计原则与评审流水线一致：静态检查是可用性底线，大模型阶段全部按
 * 「可选增强」处理，任一环节失败都在 warnings 中明确告知，绝不整体失败。
 */

const config = require('../config');
const logger = require('../core/logger');
const { ValidationError } = require('../core/errors');
const { formatDuration } = require('../core/utils');
const { checkSyntax } = require('../analyzers/syntax-checker');
const { compileCheck } = require('../analyzers/compile-checker');
const { analyze } = require('../analyzers/static-analyzer');
const { detectLanguage } = require('../analyzers/languages');
const { LlmClient } = require('../agents/llm-client');
const { CompletionAgent } = require('../agents/completion-agent');
const { matchTemplate } = require('./code-templates');
const { retrieve } = require('../rag/retriever');

const log = logger.child('completion-service');

/** 同一位置的大模型结论视为对静态结论的印证（与评审服务保持一致） */
const CONFIRM_LINE_WINDOW = 2;

/** 输入体积上限（复用评审流水线的配置口径） */
const MAX_LINES = config.review.maxLines;

/**
 * 融合静态与大模型诊断结论
 * @param {object[]} staticIssues 静态语法问题
 * @param {object[]} llmIssues 大模型诊断问题
 * @returns {{issues:object[], confirmed:number}} 融合结果
 */
function mergeDiagnosis(staticIssues, llmIssues) {
  const merged = [...staticIssues];
  let confirmed = 0;

  for (const candidate of llmIssues) {
    const duplicate = staticIssues.find(
      (issue) => Math.abs(issue.line - candidate.line) <= CONFIRM_LINE_WINDOW,
    );
    if (duplicate) {
      duplicate.confirmedBy = (duplicate.confirmedBy || 0) + 1;
      confirmed += 1;
      continue;
    }
    merged.push(candidate);
  }

  merged.sort((a, b) => {
    if (b.severityOrder !== a.severityOrder) return b.severityOrder - a.severityOrder;
    return a.line - b.line;
  });

  return { issues: merged, confirmed };
}

/** 代码补全服务 */
class CompletionService {
  /**
   * @param {object} [options] 选项
   * @param {LlmClient} [options.client] 大模型客户端（测试注入用；缺省时按当前配置创建）
   */
  constructor(options = {}) {
    this.injectedClient = options.client || null;
    this.client = options.client || new LlmClient();
    this.agent = new CompletionAgent({ client: this.client });
  }

  /**
   * 用当前配置重建大模型客户端（网页「设置」保存后调用，立即生效）
   * 若客户端为测试注入则保持不变。
   * @returns {LlmClient} 当前生效的客户端
   */
  rebuildLlm() {
    if (this.injectedClient) return this.client;
    this.client = new LlmClient();
    this.agent = new CompletionAgent({ client: this.client });
    return this.client;
  }

  /**
   * 校验并规范化输入
   * ---------------------------------------------------------------------------
   * 功能判定：显式 feature 优先；缺省时按输入推断（有提示词→补全，仅代码→修复）。
   * @param {object} input 原始输入
   * @returns {object} 规范化后的输入（含 feature 与 mode 判定）
   */
  normalizeInput(input = {}) {
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    const code = typeof input.code === 'string' ? input.code : '';
    const image = typeof input.image === 'string' ? input.image.trim() : '';

    if (!prompt && !code.trim() && !image) {
      throw new ValidationError('提示词、代码、图片至少填写一项', { field: 'prompt' });
    }
    if (code.split('\n').length > MAX_LINES) {
      throw new ValidationError(`代码超过 ${MAX_LINES} 行上限，请拆分后再提交`, { field: 'code' });
    }
    if (image) {
      if (!/^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/i.test(image)) {
        throw new ValidationError('image 必须是 data URL（png / jpeg / gif / webp）', { field: 'image' });
      }
      if (image.length > 8000000) {
        throw new ValidationError('图片过大（约 6MB 上限），请压缩后再上传', { field: 'image' });
      }
    }

    // —— 功能判定 ——
    let feature = input.feature;
    if (feature !== undefined && feature !== null && feature !== '') {
      if (!['complete', 'fix', 'quiz'].includes(feature)) {
        throw new ValidationError('feature 仅支持 complete（解题补全）/ fix（错误修复）/ quiz（变式出题）', { field: 'feature' });
      }
    } else {
      feature = code.trim() && !prompt && !image ? 'fix' : 'complete';
    }
    if (feature === 'complete' && !prompt && !image) {
      throw new ValidationError('解题与补全功能需要填写问题（或附上图片）', { field: 'prompt' });
    }
    if (feature === 'fix' && !code.trim()) {
      throw new ValidationError('错误检查与修复功能需要提供待检查的代码', { field: 'code' });
    }
    if (feature === 'quiz' && !prompt) {
      throw new ValidationError('变式出题需要填写刚学过的题目或知识点', { field: 'prompt' });
    }
    if (image && feature !== 'complete') {
      throw new ValidationError('图片提问仅用于解题与补全功能（complete）', { field: 'image' });
    }

    // mode 是对外展示口径：补全 / 从零生成 / 错误修复 / 变式出题
    const mode = feature === 'fix' ? 'fix' : feature === 'quiz' ? 'quiz' : code.trim() ? 'complete' : 'generate';

    const profile = detectLanguage({
      fileName: input.fileName || undefined,
      code,
      language: input.language || undefined,
    });

    return {
      prompt,
      code,
      image,
      feature,
      mode,
      fileName: typeof input.fileName === 'string' ? input.fileName : null,
      languageKey: profile.key,
      languageLabel: profile.label,
      useLlm: input.useLlm !== false,
    };
  }

  /**
   * 执行功能流水线
   * @param {object} input 原始输入（feature / prompt / code / language / fileName / useLlm）
   * @returns {Promise<object>} 执行结果
   */
  async complete(input = {}) {
    const startedAt = Date.now();
    // 非注入场景下按最新配置刷新客户端，保证网页「设置」保存后立即生效
    if (!this.injectedClient) this.rebuildLlm();
    const normalized = this.normalizeInput(input);
    const { prompt, code, image, feature, mode, fileName, languageKey, languageLabel, useLlm } = normalized;
    const warnings = [];

    const isFix = feature === 'fix';

    // —— 功能 C：变式出题（学习检验） ——
    if (feature === 'quiz') {
      let quiz = null;
      let quizMeta = null;
      let llmUsed = false;
      if (!useLlm) {
        warnings.push('已关闭大模型，无法生成变式题。');
      } else if (!this.client.available) {
        warnings.push('大模型未配置，变式出题需要大模型；在「设置大模型」中填写密钥，或选择离线模拟器查看演示流程。');
      } else {
        try {
          const produced = await this.agent.quiz({ prompt, code, language: languageLabel });
          quiz = produced.quiz;
          quizMeta = produced._meta || null;
          llmUsed = true;
          if (this.client.isMock) {
            warnings.push('离线模拟器生成的是固定示例题，仅用于演示流程；配置大模型后为按原题微改的真实变式题。');
          }
        } catch (error) {
          const reason = error?.message || '未知错误';
          log.warn('变式出题阶段失败', { reason });
          warnings.push(`变式出题失败：${reason}（已自动降级，不影响其他结果）`);
        }
      }

      const quizResult = {
        feature,
        mode,
        prompt,
        language: languageLabel,
        languageKey,
        fileName,
        code,
        quiz,
        answer: null,
        completedCode: null,
        fixedCode: null,
        completionSource: quiz ? (llmUsed && !this.client.isMock ? 'llm' : 'mock') : 'none',
        notes: [],
        issues: [],
        syntaxOk: true,
        summary: {
          text: quiz
            ? `已生成变式题「${quiz.title}」，共 ${quiz.testCases.length} 组测试用例，可在「练习与调试」中作答并自动判题。`
            : '未生成变式题。',
          offline: !llmUsed,
        },
        engines: { static: false, llm: llmUsed, confirmed: 0, checkedBy: {} },
        selfCheck: null,
        safetyCheck: null,
        rag: { query: '', hits: [] },
        llm: llmUsed ? { model: this.client.model, quiz: quizMeta } : null,
        warnings,
        stats: {
          issueCount: 0,
          staticIssueCount: 0,
          llmIssueCount: 0,
          confirmedCount: 0,
          durationMs: Date.now() - startedAt,
        },
      };
      log.info(`完成（quiz）：${quiz ? quiz.title : '未出题'}，耗时 ${formatDuration(quizResult.stats.durationMs)}`);
      return quizResult;
    }

    // —— 静态语法检查（确定性）：启发式检查 + 真编译器诊断，仅「错误修复」功能检查输入代码 ——
    const syntax = isFix && code.trim()
      ? checkSyntax({ code, language: languageKey, fileName: fileName || undefined })
      : { issues: [], checkedBy: {} };
    const compile = isFix && code.trim()
      ? compileCheck({ code, language: languageKey, fileName: fileName || undefined })
      : { issues: [], checkedBy: {} };
    const staticIssues = [...syntax.issues, ...compile.issues];

    // —— RAG 检索：按查询从内置知识库召回相关修复模式/最佳实践 ——
    const knowledgeQuery = isFix
      ? [prompt, ...staticIssues.map((issue) => `${issue.title} ${issue.message}`)].filter(Boolean).join('\n')
      : prompt;
    const knowledge = retrieve(knowledgeQuery, { limit: 3 });

    // —— 大模型阶段（可选增强，失败降级） ——
    let diagnosis = null;
    let completion = null;
    let llmUsed = false;
    let templateHit = null;

    if (useLlm) {
      if (!this.client.available) {
        warnings.push(
          isFix
            ? '大模型未配置，仅返回静态语法检查结果；在「设置大模型」中填写密钥可启用 AI 诊断与修复。'
            : '大模型未配置；已尝试内置离线模板库补全。',
        );
      } else if (isFix || !this.client.isMock) {
        // 离线模拟器不直接产出补全：优先走内置模板库（真实代码），未命中再用占位演示
        try {
          if (isFix) {
            diagnosis = await this.agent.diagnose({
              code,
              language: languageLabel,
              prompt,
              fileName,
              knowledge,
              staticHints: staticIssues.map((issue) => ({
                line: issue.line,
                title: issue.title,
                ruleId: issue.ruleId,
                message: issue.message,
              })),
            });
          } else {
            completion = await this.agent.complete({
              prompt, code, language: languageLabel, fileName, knowledge, imageUrl: image || undefined,
            });
          }
          llmUsed = true;
        } catch (error) {
          const reason = error?.message || '未知错误';
          log.warn(`大模型${isFix ? '诊断修复' : '补全'}阶段失败`, { reason });
          warnings.push(`大模型${isFix ? '语法诊断与修复' : '代码补全'}失败：${reason}（已自动降级，不影响其他结果）`);
        }
      }
    } else {
      warnings.push(isFix ? '已关闭大模型，仅返回静态语法检查结果。' : '已关闭大模型；已尝试内置离线模板库补全。');
    }

    // —— 内置离线模板库兜底（不调用任何 API，为常见功能给出真实可用代码） ——
    if (!isFix && !completion) {
      templateHit = matchTemplate({ prompt, languageKey, code });
      if (templateHit) {
        warnings.push('本次补全来自内置离线模板库（未调用大模型，仅覆盖常见功能）；任意功能补全请配置大模型或本地 Ollama。');
      } else if (useLlm && this.client.available && this.client.isMock) {
        // 模板未命中且处于演示模式：交给离线模拟器生成占位代码，保证流程完整
        try {
          completion = await this.agent.complete({
            prompt, code, language: languageLabel, fileName, imageUrl: image || undefined,
          });
          llmUsed = true;
          warnings.push('离线模拟器生成的是占位代码，仅用于演示流程，不是真实补全结果。');
        } catch {
          /* 演示模式失败不影响整体 */
        }
      }
    }

    // —— 结果组装（按功能分流） ——
    let issues;
    let confirmed = 0;
    let producedCode = null;
    let selfCheck = null;

    if (isFix) {
      const llmFindings = diagnosis?.findings || [];
      const merged = mergeDiagnosis(staticIssues, llmFindings);
      issues = merged.issues;
      confirmed = merged.confirmed;
      producedCode = diagnosis?.fixedCode || null;

      // 修复结果自检：对修复后的代码复跑语法检查（含真编译器），保证交付代码自身无语法问题
      if (producedCode) {
        const verified = checkSyntax({ code: producedCode, language: languageKey, fileName: fileName || undefined });
        const verifiedCompile = compileCheck({ code: producedCode, language: languageKey, fileName: fileName || undefined });
        const verifiedIssues = [...verified.issues, ...verifiedCompile.issues];
        selfCheck = { target: 'fixedCode', issueCount: verifiedIssues.length, issues: verifiedIssues };
        if (verifiedIssues.length > 0) {
          warnings.push(`修复结果自身仍存在 ${verifiedIssues.length} 处可疑语法问题，建议人工复核后再使用。`);
        }
      }
    } else {
      producedCode = completion?.completedCode || templateHit?.code || null;
      issues = [];

      // 补全结果自检：启发式 + 真编译器，发现的问题计入 issues，提示用户复核
      if (producedCode) {
        const verified = checkSyntax({ code: producedCode, language: languageKey, fileName: fileName || undefined });
        const verifiedCompile = compileCheck({ code: producedCode, language: languageKey, fileName: fileName || undefined });
        const verifiedIssues = [...verified.issues, ...verifiedCompile.issues];
        selfCheck = { target: 'completedCode', issueCount: verifiedIssues.length, issues: verifiedIssues };
        issues = verifiedIssues;
        if (verifiedIssues.length > 0) {
          warnings.push(`补全结果自身存在 ${verifiedIssues.length} 处可疑语法问题，建议人工复核后再使用。`);
        }
      }
    }

    // —— 产出安全复检（AI 安全与可控）：对交付代码复跑安全规则，防止生成带风险的代码 ——
    let safetyCheck = null;
    if (producedCode) {
      const scanned = analyze({
        code: producedCode,
        fileName: fileName || (isFix ? 'fixed-code.js' : 'completed-code.js'),
        dimensions: ['security'],
      });
      safetyCheck = { issueCount: scanned.issues.length, issues: scanned.issues.slice(0, 5) };
      if (scanned.issues.length > 0) {
        warnings.push(`产出代码经安全复检发现 ${scanned.issues.length} 处安全风险（如硬编码凭据 / 注入写法），请谨慎使用。`);
      }
    }

    const offlineSummary = isFix
      ? (issues.length
          ? `静态语法检查发现 ${issues.length} 处问题${confirmed ? `（其中 ${confirmed} 处被大模型诊断印证）` : ''}，请按建议逐条修改。`
          : '静态语法检查未发现语法问题。')
      : (templateHit
          ? `已由内置离线模板库生成「${templateHit.title}」的补全代码（未调用大模型，仅覆盖常见功能）。`
          : producedCode ? '已生成补全代码（离线占位，未调用外部大模型）。' : '未生成补全代码。');

    /** 补全来源：llm 真实大模型 | template 内置模板库 | mock 离线占位 | none 未生成 */
    const completionSource = isFix ? 'none' : completion ? (llmUsed && !this.client.isMock ? 'llm' : 'mock') : templateHit ? 'template' : 'none';

    const result = {
      feature,
      mode,
      prompt,
      language: languageLabel,
      languageKey,
      fileName,
      code,
      completedCode: isFix ? null : producedCode,
      fixedCode: isFix ? producedCode : null,
      answer: isFix ? null : (completion?.answer || null),
      quiz: null,
      completionSource,
      notes: completion?.notes || templateHit?.notes || [],
      issues,
      syntaxOk: issues.length === 0,
      summary: {
        text: (llmUsed && isFix && diagnosis?.summary) || offlineSummary,
        offline: !llmUsed,
      },
      engines: {
        static: isFix,
        llm: llmUsed,
        confirmed,
        checkedBy: { ...syntax.checkedBy, ...compile.checkedBy },
      },
      selfCheck,
      safetyCheck,
      rag: {
        query: knowledgeQuery.slice(0, 120),
        hits: knowledge.map((item) => ({ id: item.id, title: item.title, score: item.score })),
      },
      llm: llmUsed
        ? {
            model: this.client.model,
            diagnosis: diagnosis?._meta || null,
            completion: completion?._meta || null,
          }
        : null,
      warnings,
      stats: {
        issueCount: issues.length,
        staticIssueCount: staticIssues.length,
        llmIssueCount: isFix ? (diagnosis?.findings || []).length : 0,
        confirmedCount: confirmed,
        durationMs: Date.now() - startedAt,
      },
    };

    log.info(`完成（${feature}/${mode}）：问题 ${issues.length} 项，耗时 ${formatDuration(result.stats.durationMs)}`);
    return result;
  }
}

module.exports = { CompletionService, mergeDiagnosis };
