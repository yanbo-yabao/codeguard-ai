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
    const userContent = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    // 总结类请求的辨识依据写在 system 提示词里，因此需要连同 system 一起判断
    const allContent = messages.map((m) => m.content).join('\n');

    // 总结类请求：返回汇报结构，保证离线模式下报告结构同样完整
    if (/"overview"/.test(allContent) || /技术负责人/.test(allContent)) {
      const listed = [...userContent.matchAll(/-\s*\[(\w+)\]\s*第\s*(\d+)\s*行\s*(.+)/g)].map((match) => ({
        severity: match[1],
        line: Number(match[2]),
        title: match[3].trim(),
      }));
      const blockers = listed
        .filter((item) => ['blocker', 'critical'].includes(item.severity))
        .slice(0, 5)
        .map((item) => `第 ${item.line} 行：${item.title}`);
      await sleep(5);
      return {
        content: JSON.stringify({
          overview: `离线模拟汇报：共梳理 ${listed.length} 项重点问题，其中必须在上线前解决 ${blockers.length} 项。本结论由内置模拟器生成，未调用外部大模型。`,
          highlights: [],
          blockers,
          actions: listed.slice(0, 5).map((item) => `修复 ${item.title}（第 ${item.line} 行）`),
        }),
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        model: 'codeguard-mock',
        latencyMs: Date.now() - startedAt,
        attempt: 0,
        mock: true,
      };
    }

    const role = /角色：(security|performance|readability|bug)/.exec(userContent)?.[1] || 'security';
    const codeLines = userContent
      .split('\n')
      .map((line) => /^\s*(\d+)\s*\|\s?(.*)$/.exec(line))
      .filter(Boolean)
      .map((match) => ({ line: Number(match[1]), text: match[2] }));

    const findings = [];
    const push = (line, severity, dimension, title, message, suggestion) => {
      findings.push({ line, severity, dimension, title, message, suggestion, confidence: 0.75 });
    };

    for (const { line, text } of codeLines) {
      if (role === 'security') {
        if (/\b(?:eval|exec)\s*\(/.test(text)) {
          push(line, 'critical', 'security', '动态代码执行', 'eval/exec 会把外部输入当作代码执行，存在远程代码执行风险', '改用显式解析逻辑，或使用 ast.literal_eval 等受限求值方式');
        }
        if (/(?:password|secret|token|api[_-]?key)\s*[:=]\s*["'][^"']{6,}["']/i.test(text)) {
          push(line, 'blocker', 'security', '凭据硬编码', '敏感凭据直接写入源码，随版本库永久留存', '改为从环境变量注入，并轮换已泄露的凭据');
        }
      }
      if (role === 'performance' && /\bawait\b/.test(text)) {
        push(line, 'major', 'performance', '串行等待', '循环或连续调用中的 await 会造成串行阻塞，可改为 Promise.all 并行', '无依赖的异步任务使用 Promise.all 并发执行');
      }
      if (role === 'bug' && /==[^=]/.test(text) && !/===/.test(text)) {
        push(line, 'major', 'bug', '松散相等', '== 会触发隐式类型转换，产生难以预期的结果', '统一改用 === 进行严格比较');
      }
      if (role === 'readability' && /\/\/\s*(?:TODO|FIXME)/i.test(text)) {
        push(line, 'info', 'readability', '待办标记', '存在未处理的 TODO / FIXME 标记', '补充负责人与期限，或尽快收敛该事项');
      }
    }

    const summary = findings.length
      ? `离线模拟评审发现 ${findings.length} 处可疑写法，以上结论由内置规则推导，未调用外部大模型。`
      : '离线模拟评审未发现该角色职责范围内的可疑写法。';

    await sleep(5);

    return {
      content: JSON.stringify({ summary, findings }),
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      model: 'codeguard-mock',
      latencyMs: Date.now() - startedAt,
      attempt: 0,
      mock: true,
    };
  }
}

module.exports = { LlmClient, parseJsonLoose, createLlmClient: (options) => new LlmClient(options) };
