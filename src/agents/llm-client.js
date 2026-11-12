'use strict';

/**
 * 大模型客户端
 * ---------------------------------------------------------------------------
 * 统一封装 OpenAI 兼容的 /chat/completions 协议，支持三类供应商：
 *   deepseek           DeepSeek 官方接口
 *   openai-compatible  任意兼容协议的服务（Kimi、火山方舟、Ollama、vLLM…）
 *   mock               离线确定性模拟器，用于单元测试与断网演示
 *
 * 关键工程约束：
 *   1. 零第三方依赖 —— 直接使用 Node 内置 fetch；
 *   2. 每次调用都有超时（AbortController），避免服务端挂起拖垮整个审查任务；
 *   3. 失败按指数退避重试，仅对可重试错误（超时、429、5xx）重试；
 *   4. 返回结构统一携带耗时与 token 用量，便于前端展示与成本核算。
 */

const config = require('../config');
const logger = require('../core/logger');
const { LlmError, ConfigError } = require('../core/errors');
const { formatDuration } = require('../core/utils');

const log = logger.child('llm');

/** 可重试的 HTTP 状态码 */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/**
 * 从模型输出中抽取 JSON 对象
 * ---------------------------------------------------------------------------
 * 模型常把 JSON 包在 ```json 代码块里，或在前后添加解释性文字，此处做容错解析：
 * 先直接解析 → 再剥代码块 → 最后用首个 { 到末个 } 的切片兜底。
 * @param {string} text 模型原始输出
 * @returns {object} 解析结果
 * @throws {LlmError} 无法解析时抛出
 */
function parseJsonLoose(text) {
  const raw = String(text ?? '').trim();
  if (!raw) throw new LlmError('模型返回内容为空');

  try {
    return JSON.parse(raw);
  } catch {
    /* 继续尝试其他策略 */
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      /* 继续兜底 */
    }
  }

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      /* 落到最终抛错 */
    }
  }

  throw new LlmError('模型输出不是合法 JSON，无法解析为结构化结果', { preview: raw.slice(0, 200) });
}

/** 延时工具 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 大模型客户端 */
class LlmClient {
  /**
   * @param {object} [options] 覆盖配置项
   * @param {string} [options.provider] 供应商
   * @param {string} [options.apiKey] 密钥
   * @param {string} [options.baseUrl] 接口根地址
   * @param {string} [options.model] 模型名
   * @param {number} [options.timeoutMs] 单次请求超时
   * @param {number} [options.maxRetries] 最大重试次数
   */
  constructor(options = {}) {
    const llm = config.llm;
    this.provider = options.provider || llm.provider;
    this.apiKey = options.apiKey ?? llm.apiKey;
    this.baseUrl = String(options.baseUrl ?? llm.baseUrl ?? '').replace(/\/+$/, '');
    this.model = options.model || llm.model;
    this.timeoutMs = options.timeoutMs || config.review.timeoutMs;
    this.maxRetries = Number.isFinite(options.maxRetries) ? options.maxRetries : config.review.maxRetries;
    /** 累计用量统计 */
    this.usage = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, failures: 0 };
  }

  /** 是否为离线模拟模式 */
  get isMock() {
    return this.provider === 'mock';
  }

  /** 当前客户端是否具备可用条件 */
  get available() {
    if (this.isMock) return true;
    return Boolean(this.apiKey && this.baseUrl && this.model);
  }

  /**
   * 发起对话补全请求
   * @param {object} options 请求参数
   * @param {Array<{role:string,content:string}>} options.messages 消息列表
   * @param {number} [options.temperature] 采样温度
   * @param {number} [options.maxTokens] 最大输出 token
   * @param {boolean} [options.jsonMode] 是否要求返回 JSON 对象
   * @returns {Promise<{content:string, usage:object, model:string, latencyMs:number, attempt:number}>} 响应
   */
  async chat({ messages, temperature, maxTokens, jsonMode = false }) {
    if (!this.available) {
      throw new ConfigError(
        `大模型客户端不可用：provider=${this.provider}，请检查 .env 中的 API Key / Base URL / 模型名`,
      );
    }

    if (this.isMock) {
      return this.mockChat({ messages, jsonMode });
    }

    const body = {
      model: this.model,
      messages,
      temperature: temperature ?? config.review.temperature,
      max_tokens: maxTokens ?? config.review.maxTokens,
      stream: false,
    };
    if (jsonMode) body.response_format = { type: 'json_object' };

    const url = `${this.baseUrl}/chat/completions`;
    let lastError = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const startedAt = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
            'User-Agent': 'CodeGuard-AI/1.0',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          const retryable = RETRYABLE_STATUS.has(response.status);
          lastError = new LlmError(`大模型接口返回 ${response.status}`, {
            status: response.status,
            detail: errorText.slice(0, 300),
          });
          if (!retryable) break;
          log.warn(`调用失败（${response.status}），准备第 ${attempt + 2} 次尝试`, { url });
          await sleep(500 * 2 ** attempt);
          continue;
        }

        const payload = await response.json();
        const choice = payload?.choices?.[0];
        const content = choice?.message?.content ?? '';
        const finishReason = choice?.finish_reason || null;
        const usage = payload?.usage || {};
        const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens || 0;

        this.usage.calls += 1;
        this.usage.promptTokens += usage.prompt_tokens || 0;
        this.usage.completionTokens += usage.completion_tokens || 0;
        this.usage.totalTokens += usage.total_tokens || 0;
        this.usage.reasoningTokens = (this.usage.reasoningTokens || 0) + reasoningTokens;

        // 思维链模型（如 DeepSeek-V4-Flash）会把推理过程计入 completion 预算，
        // 若 max_tokens 偏小，正文会被截断或直接为空。此处给出可操作的精确诊断，
        // 而不是让调用方在「JSON 解析失败」这类模糊信息里排查。
        const truncated = finishReason === 'length';
        if (!content.trim() || truncated) {
          throw new LlmError(
            truncated || reasoningTokens > 0
              ? `模型输出被 max_tokens（${body.max_tokens}）截断（推理占用 ${reasoningTokens} token）。` +
                '该模型含思维链，推理过程会消耗输出预算，请调大 REVIEW_MAX_TOKENS（建议不低于 16000）'
              : '模型返回内容为空',
            { finishReason, reasoningTokens, maxTokens: body.max_tokens, preview: content.slice(-200) },
          );
        }

        return {
          content,
          usage: {
            promptTokens: usage.prompt_tokens || 0,
            completionTokens: usage.completion_tokens || 0,
            totalTokens: usage.total_tokens || 0,
            reasoningTokens,
          },
          model: payload?.model || this.model,
          latencyMs: Date.now() - startedAt,
          attempt,
        };
      } catch (error) {
        clearTimeout(timer);

        // 语义类错误（输出截断、内容为空）重试大概率复现，直接上抛以免浪费额度与时间
        if (error instanceof LlmError) {
          lastError = error;
          break;
        }

        const isAbort = error?.name === 'AbortError';
        lastError = new LlmError(
          isAbort ? `大模型请求超时（${formatDuration(this.timeoutMs)}）` : `大模型请求异常：${error.message}`,
          { cause: error?.name },
        );
        if (attempt >= this.maxRetries) break;
        log.warn(`调用异常（${error.message}），准备第 ${attempt + 2} 次尝试`);
        await sleep(500 * 2 ** attempt);
      }
    }

    this.usage.failures += 1;
    throw lastError || new LlmError('大模型调用失败（未知原因）');
  }

  /**
   * 请求并解析为 JSON 对象
   * @param {object} options 同 chat
   * @returns {Promise<object>} 解析后的对象（附加 _meta 字段）
   */
  async chatJson(options) {
    const response = await this.chat({ ...options, jsonMode: true });
    const data = parseJsonLoose(response.content);
    return {
      ...data,
      _meta: {
        model: response.model,
        latencyMs: response.latencyMs,
        usage: response.usage,
        attempt: response.attempt,
      },
    };
  }

  /**
   * 离线模拟响应
   * ---------------------------------------------------------------------------
   * 依据提示词中携带的代码特征生成**确定性**结论，保证同一输入产出同一结果，
   * 使单元测试与断网演示均可复现，且无需任何外部依赖。
   * @param {object} options 请求参数
   * @returns {Promise<object>} 与真实接口同构的响应
   */
  async mockChat({ messages, jsonMode }) {
    const startedAt = Date.now();
    // content 可能是字符串或多模态数组（文本 + 图片），统一提取文本
    const textOf = (content) => (Array.isArray(content)
      ? content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
      : String(content ?? ''));
    const userContent = messages.filter((m) => m.role === 'user').map((m) => textOf(m.content)).join('\n');
    const hasImage = messages.some(
      (m) => Array.isArray(m.content) && m.content.some((part) => part.type === 'image_url'),
    );

    // 变式出题请求：返回确定性示例题（离线演示用；配置大模型后为真实变式题）
    if (/角色：quiz/.test(userContent)) {
      const langLabel = /语言：(\S+)/.exec(userContent)?.[1] || '';
      const isPython = /python/i.test(langLabel);
      const starterCode = isPython
        ? '# 从标准输入读取两个整数，输出它们的和\nimport sys\n\na, b = map(int, sys.stdin.read().split())\n# TODO: 计算并输出 a + b\n'
        : "// 从标准输入读取两个整数，输出它们的和\nconst data = require('fs').readFileSync(0, 'utf8').trim().split(/\\s+/).map(Number);\nconst [a, b] = data;\n// TODO: 计算并输出 a + b\n";
      const referenceSolution = isPython
        ? 'import sys\n\na, b = map(int, sys.stdin.read().split())\nprint(a + b)\n'
        : "const data = require('fs').readFileSync(0, 'utf8').trim().split(/\\s+/).map(Number);\nconsole.log(data[0] + data[1]);\n";
      await sleep(5);
      return {
        content: JSON.stringify({
          title: '变式题：两数之和',
          description: '给定两个整数 a 和 b，输出它们的和。\n\n输入格式：一行两个整数 a、b。\n输出格式：一个整数，表示 a + b。\n\n（离线模拟出题，题面与测试用例为固定示例；配置大模型后为按原题微改的真实变式题）',
          starterCode,
          testCases: [
            { input: '1 2\n', expected: '3\n' },
            { input: '-5 5\n', expected: '0\n' },
            { input: '0 0\n', expected: '0\n' },
          ],
          referenceSolution,
          hints: ['用标准输入读入两个整数', '注意负数也能正确相加'],
        }),
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        model: 'codeguard-mock',
        latencyMs: Date.now() - startedAt,
        attempt: 0,
        mock: true,
      };
    }

    // 解题与代码补全请求：返回确定性占位讲解与代码
    if (/角色：complete/.test(userContent)) {
      const codeLines = userContent
        .split('\n')
        .map((line) => /^\s*(\d+)\s*\|\s?(.*)$/.exec(line))
        .filter(Boolean)
        .map((match) => match[2]);
      const base = codeLines.join('\n');
      const filler = '// [离线模拟补全] 未调用外部大模型，此处为占位实现；配置 API Key 后可获得真实补全结果。';
      const answer = hasImage
        ? '离线模拟讲解：已收到你的图片，但离线模拟器无法真正理解图片内容（配图提问需要支持视觉的大模型，如 Kimi K3、GLM-4V 系列）。以下代码为占位实现。'
        : '离线模拟讲解：未调用外部大模型，此处仅演示输出结构。配置 API Key 后可获得真实的解题思路讲解与代码。';
      await sleep(5);
      return {
        content: JSON.stringify({
          answer,
          completedCode: base ? `${base}\n\n${filler}\n` : `${filler}\n`,
          notes: ['离线模拟器生成的占位补全，仅用于验证流水线可用性'],
        }),
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        model: 'codeguard-mock',
        latencyMs: Date.now() - startedAt,
        attempt: 0,
        mock: true,
      };
    }

    // 语法诊断请求：基于确定性语法检查器给出模拟结论（与静态引擎同源，结论可靠）
    if (/角色：syntax/.test(userContent)) {
      const codeLines = userContent
        .split('\n')
        .map((line) => /^\s*(\d+)\s*\|\s?(.*)$/.exec(line))
        .filter(Boolean)
        .map((match) => ({ line: Number(match[1]), text: match[2] }));
      const joined = codeLines.map((item) => item.text).join('\n');
      let findings = [];
      try {
        // 复用真实语法检查能力（括号/字符串闭合、拼写错误、Python 结构、JS 编译验证）
        // 语言从提示词上下文解析，避免纯内容推断漏判
        const { checkSyntax } = require('../analyzers/syntax-checker');
        const { LANGUAGES } = require('../analyzers/languages');
        const langLabel = /语言：(\S+)/.exec(userContent)?.[1] || '';
        const langProfile = Object.values(LANGUAGES).find(
          (item) => item.label === langLabel || item.key === langLabel.toLowerCase(),
        );
        findings = checkSyntax({ code: joined, language: langProfile?.key }).issues.map((issue) => ({
          line: codeLines[issue.line - 1]?.line ?? issue.line,
          severity: issue.severity,
          dimension: 'bug',
          title: issue.title,
          message: issue.message,
          suggestion: issue.suggestion,
          confidence: 0.7,
        }));
      } catch {
        // 检查器异常时保守回退：仅做括号数量统计
        const count = (char) => (joined.split(char).length - 1);
        if (count('{') !== count('}') || count('(') !== count(')') || count('[') !== count(']')) {
          findings = [{
            line: codeLines.length ? codeLines[codeLines.length - 1].line : 1,
            severity: 'major',
            dimension: 'bug',
            title: '括号配对可疑',
            message: '代码中括号数量不配对（启发式统计），可能存在未闭合或多余的括号',
            suggestion: '逐个核对括号配对，或借助编辑器的括号匹配功能定位',
            confidence: 0.7,
          }];
        }
      }
      const summary = findings.length
        ? `离线模拟诊断发现 ${findings.length} 处语法问题，以上结论由内置语法检查器推导，未调用外部大模型。`
        : '离线模拟诊断未发现语法问题，本结论由内置模拟器生成，未调用外部大模型。';
      const fixedCode = findings.length
        ? `${joined}\n// [离线模拟修复] 以上问题的修复需人工核对；配置 API Key 后可获得真实修复代码。`
        : '';
      await sleep(5);
      return {
        content: JSON.stringify({ summary, findings, fixedCode }),
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        model: 'codeguard-mock',
        latencyMs: Date.now() - startedAt,
        attempt: 0,
        mock: true,
      };
    }

    // 兜底：离线模拟器只覆盖 quiz / complete / syntax 三类任务，其余返回空结果
    await sleep(5);
    return {
      content: JSON.stringify({ summary: '离线模拟器未识别该任务类型，返回空结果。', findings: [] }),
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      model: 'codeguard-mock',
      latencyMs: Date.now() - startedAt,
      attempt: 0,
      mock: true,
    };
  }
}

module.exports = { LlmClient, parseJsonLoose, createLlmClient: (options) => new LlmClient(options) };
