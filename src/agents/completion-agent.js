'use strict';

/**
 * 代码补全 Agent（双专家工作流）
 * ---------------------------------------------------------------------------
 * 把「输入提示词 + 代码 → 补全代码并指出语法错误如何修改」拆解为两个职责单一
 * 的专家角色，串行/并行编排：
 *
 *   ① 语法诊断专家   定位语法错误与显性运行期错误，给出可照做的修改方法
 *                    （静态语法检查结论作为提示注入，形成双引擎交叉印证）
 *   ② 代码补全专家   按用户意图补全/生成代码，输出完整可运行实现
 *
 * 两个阶段相互独立、可单独降级：任一阶段失败不影响另一阶段产出，
 * 失败原因写入 warnings，整体流程绝不因大模型故障而失败。
 */

const logger = require('../core/logger');
const { SEVERITIES } = require('../core/taxonomy');
const { buildDiagnosePrompt, buildCompletePrompt, buildQuizPrompt } = require('./prompt-templates');

const log = logger.child('completion-agent');

/**
 * 把模型输出的 finding 归一化为标准问题对象
 * @param {object} raw 模型输出的 finding
 * @param {number} index 序号
 * @returns {object|null} 标准问题对象（无法归一时返回 null）
 */
function normalizeFinding(raw, index) {
  const line = Number(raw?.line);
  if (!raw || !Number.isFinite(line) || line < 1) return null;

  const severityKey = SEVERITIES[raw.severity] ? raw.severity : 'major';
  const severity = SEVERITIES[severityKey];
  return {
    id: `LLM-SYN:${line}:${index}`,
    ruleId: 'LLM-SYN',
    title: String(raw.title || '语法问题').slice(0, 40),
    dimension: 'bug',
    dimensionLabel: '缺陷风险',
    severity: severityKey,
    severityLabel: severity.label,
    severityOrder: severity.order,
    line,
    message: String(raw.message || ''),
    suggestion: String(raw.suggestion || ''),
    snippet: String(raw.snippet || ''),
    reference: '大模型诊断',
    source: 'llm',
    roleLabel: '语法诊断专家',
    confidence: Math.min(Math.max(Number(raw.confidence) || 0.8, 0), 1),
  };
}

/** 代码补全 Agent */
class CompletionAgent {
  /**
   * @param {object} [options] 选项
   * @param {import('./llm-client').LlmClient} [options.client] 大模型客户端
   */
  constructor(options = {}) {
    this.client = options.client;
  }

  /** 当前生效的客户端（延迟创建，保证网页设置保存后立即生效） */
  get activeClient() {
    return this.client;
  }

  /**
   * 语法诊断（含修复后代码）
   * @param {object} input 输入
   * @param {string} input.code 代码
   * @param {string} input.language 语言标签
   * @param {string} [input.prompt] 用户开发意图
   * @param {string} [input.fileName] 文件名
   * @param {Array<object>} [input.staticHints] 静态检查已发现的问题
   * @returns {Promise<{summary:string, findings:object[], fixedCode:string, _meta:object}>} 诊断结果
   */
  async diagnose(input) {
    const messages = buildDiagnosePrompt(input);
    const data = await this.client.chatJson({ messages, temperature: 0.1 });

    const findings = (Array.isArray(data.findings) ? data.findings : [])
      .map(normalizeFinding)
      .filter(Boolean);

    // 防御：模型偶尔会把代码包进 ``` 围栏，剥掉后再返回
    let fixedCode = String(data.fixedCode ?? '').trim();
    const fenced = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(fixedCode);
    if (fenced) fixedCode = fenced[1];

    return {
      summary: String(data.summary || ''),
      findings,
      fixedCode,
      _meta: data._meta,
    };
  }

  /**
   * 解题与代码补全（支持图片提问）
   * @param {object} input 输入
   * @param {string} input.prompt 补全意图 / 问题
   * @param {string} [input.code] 现有代码
   * @param {string} input.language 语言标签
   * @param {string} [input.fileName] 文件名
   * @param {string} [input.imageUrl] 图片（data URL，题目截图/报错截图）
   * @param {Array<object>} [input.knowledge] RAG 参考资料
   * @returns {Promise<{answer:string, completedCode:string, notes:string[], _meta:object}>} 解题结果
   */
  async complete(input) {
    const messages = buildCompletePrompt(input);
    const data = await this.client.chatJson({ messages, temperature: 0.2 });

    // 防御：模型偶尔会把代码包进 ``` 围栏，剥掉后再返回
    let completedCode = String(data.completedCode ?? '');
    const fenced = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(completedCode.trim());
    if (fenced) completedCode = fenced[1];

    return {
      answer: String(data.answer || ''),
      completedCode,
      notes: Array.isArray(data.notes) ? data.notes.map((item) => String(item)) : [],
      _meta: data._meta,
    };
  }

  /**
   * 变式出题（学习检验）
   * @param {object} input 输入
   * @param {string} input.prompt 刚学过的题目 / 内容
   * @param {string} [input.code] 用户刚写出的解答
   * @param {string} input.language 语言标签
   * @returns {Promise<{quiz:object, _meta:object}>} 变式题
   */
  async quiz(input) {
    const messages = buildQuizPrompt(input);
    const data = await this.client.chatJson({ messages, temperature: 0.4 });

    // 防御：参考代码/起始代码可能被包进 ``` 围栏
    const stripFence = (text) => {
      const value = String(text ?? '');
      const fenced = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(value.trim());
      return fenced ? fenced[1] : value;
    };

    const testCases = (Array.isArray(data.testCases) ? data.testCases : [])
      .filter((item) => item && typeof item === 'object' && typeof item.expected === 'string')
      .slice(0, 10)
      .map((item) => ({ input: String(item.input ?? ''), expected: String(item.expected) }));

    return {
      quiz: {
        title: String(data.title || '变式练习'),
        description: String(data.description || ''),
        starterCode: stripFence(data.starterCode),
        testCases,
        referenceSolution: stripFence(data.referenceSolution),
        hints: Array.isArray(data.hints) ? data.hints.map((item) => String(item)) : [],
      },
      _meta: data._meta,
    };
  }
}

module.exports = { CompletionAgent, normalizeFinding };
