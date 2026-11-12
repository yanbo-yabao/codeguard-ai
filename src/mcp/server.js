'use strict';

/**
 * MCP 服务器（Model Context Protocol，stdio 传输）
 * ---------------------------------------------------------------------------
 * 把 CodeGuard AI 的能力以 MCP 工具的形式开放给外部 AI（Claude Desktop /
 * Cherry Studio / Cline / Cursor 等），实现「AI 通过 MCP 协议调用外部工具」。
 *
 * 协议：stdio 上的换行分隔 JSON-RPC 2.0（MCP 标准传输方式），零第三方依赖。
 * 暴露 5 个工具：
 *   complete_code  解题与代码补全（讲解 + 代码）
 *   fix_code       错误检查与修复
 *   quiz_code      变式出题（学习检验）
 *   run_code       真实运行 / 判题 / 逐行调试
 *   list_rules     列出全部内置规则
 *
 * 可测试性：协议处理收敛在 handle(message) 纯函数式入口，
 * 单元测试直接调用它，无需拉起子进程。
 */

const config = require('../config');

/** 本服务器实现的 MCP 协议版本 */
const PROTOCOL_VERSION = '2024-11-05';

/** 工具清单（含 JSON Schema，供外部 AI 理解参数） */
const TOOLS = [
  {
    name: 'complete_code',
    description: '解答编程问题并补全/生成代码：返回解题讲解与完整代码（支持从零生成）。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '问题 / 要实现的功能描述' },
        code: { type: 'string', description: '现有代码（可省略，从零生成）' },
        language: { type: 'string', description: '语言键，可省略' },
        useLlm: { type: 'boolean', description: '是否启用 AI 解题，默认 true' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'fix_code',
    description: '检查代码中的错误并修复：返回逐条错误的修改方法与修复后的完整代码。',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '待检查的代码' },
        prompt: { type: 'string', description: '期望行为描述（可选，帮助理解代码用途）' },
        language: { type: 'string', description: '语言键，可省略' },
        useLlm: { type: 'boolean', description: '是否启用 AI 诊断修复，默认 true' },
      },
      required: ['code'],
    },
  },
  {
    name: 'quiz_code',
    description: '在刚学过的题目基础上生成变式题：返回题面、测试用例、起始代码与参考答案。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '刚学过的题目或知识点' },
        code: { type: 'string', description: '用户刚写出的解答（可选，供贴近水平出题）' },
        language: { type: 'string', description: '语言键，可省略' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'run_code',
    description: '真实执行代码：mode=run 单次运行；mode=judge 按测试用例自动判题；mode=debug 逐行跟踪并给出变量快照。',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '要执行的代码' },
        language: { type: 'string', description: 'javascript 或 python' },
        mode: { type: 'string', enum: ['run', 'judge', 'debug'], description: '执行模式，默认 run' },
        stdin: { type: 'string', description: '标准输入内容（run / debug 用）' },
        testCases: {
          type: 'array',
          description: '测试用例（judge 用）：[{input, expected}]',
          items: {
            type: 'object',
            properties: { input: { type: 'string' }, expected: { type: 'string' } },
            required: ['expected'],
          },
        },
      },
      required: ['code', 'language'],
    },
  },
  {
    name: 'list_rules',
    description: '列出全部内置代码规则（ID、维度、严重级别、标题）。',
    inputSchema: { type: 'object', properties: {} },
  },
];

/** MCP 服务器 */
class McpServer {
  /**
   * @param {object} [options] 选项
   * @param {object} [options.completionService] 补全服务（测试注入用）
   * @param {object} [options.runService] 运行服务（测试注入用）
   */
  constructor(options = {}) {
    this.injectedCompletion = options.completionService || null;
    this.injectedRun = options.runService || null;
    this.completionService = options.completionService || null;
    this.runService = options.runService || null;
  }

  /** 延迟创建服务（避免仅列工具时也初始化大模型客户端） */
  ensureServices() {
    if (!this.completionService) {
      // eslint-disable-next-line global-require
      this.completionService = this.injectedCompletion || new (require('../services/completion-service').CompletionService)();
    }
    if (!this.runService) {
      // eslint-disable-next-line global-require
      this.runService = this.injectedRun || new (require('../runners/runner-service').RunService)();
    }
  }

  /**
   * 处理一条 JSON-RPC 消息
   * @param {object} message JSON-RPC 请求/通知
   * @returns {object|null} 响应（通知返回 null）
   */
  async handle(message) {
    const id = message && message.id !== undefined ? message.id : null;
    const method = String((message && message.method) || '');

    const reply = (result) => ({ jsonrpc: '2.0', id, result });
    const fail = (code, msg) => ({ jsonrpc: '2.0', id, error: { code, message: msg } });

    switch (method) {
      case 'initialize':
        return reply({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'codeguard-ai', version: config.pkg.version },
        });

      case 'notifications/initialized':
      case 'initialized':
        return null;

      case 'ping':
        return reply({});

      case 'tools/list':
        return reply({ tools: TOOLS });

      case 'tools/call':
        return reply(await this.callTool(message.params || {}));

      default:
        // 通知（无 id）静默忽略；未知请求返回 Method not found
        if (id === null) return null;
        return fail(-32601, `Method not found: ${method}`);
    }
  }

  /**
   * 执行工具调用
   * @param {object} params { name, arguments }
   * @returns {object} MCP 工具结果 { content:[{type:'text',text}], isError? }
   */
  async callTool(params) {
    const name = String(params.name || '');
    const args = (params.arguments && typeof params.arguments === 'object') ? params.arguments : {};
    const text = (value) => ({ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) });

    try {
      this.ensureServices();

      if (name === 'list_rules') {
        // eslint-disable-next-line global-require
        const { describeRules } = require('../analyzers/static-analyzer');
        return { content: [text(describeRules())] };
      }

      if (name === 'review_code') {
        return { content: [text('代码审查功能已下线；请改用 fix_code（错误检查与修复）或 complete_code（解题与补全）')], isError: true };
      }

      if (name === 'fix_code' || name === 'complete_code') {
        const result = await this.completionService.complete({
          feature: name === 'fix_code' ? 'fix' : 'complete',
          prompt: String(args.prompt || ''),
          code: String(args.code || ''),
          language: args.language || undefined,
          useLlm: args.useLlm !== false,
        });
        return {
          content: [text({
            feature: result.feature,
            summary: result.summary,
            answer: result.answer,
            completedCode: result.completedCode,
            fixedCode: result.fixedCode,
            issues: result.issues.slice(0, 15),
            warnings: result.warnings,
            ragHits: result.rag?.hits || [],
            safetyCheck: result.safetyCheck,
          })],
        };
      }

      if (name === 'quiz_code') {
        const result = await this.completionService.complete({
          feature: 'quiz',
          prompt: String(args.prompt || ''),
          code: String(args.code || ''),
          language: args.language || undefined,
        });
        return { content: [text({ quiz: result.quiz, warnings: result.warnings })] };
      }

      if (name === 'run_code') {
        const mode = ['run', 'judge', 'debug'].includes(args.mode) ? args.mode : 'run';
        const input = {
          language: String(args.language || 'javascript'),
          code: String(args.code || ''),
          stdin: String(args.stdin || ''),
        };
        let result;
        if (mode === 'judge') {
          result = await this.runService.judge({ ...input, testCases: Array.isArray(args.testCases) ? args.testCases : [] });
        } else if (mode === 'debug') {
          result = await this.runService.debug(input);
        } else {
          result = await this.runService.run(input);
        }
        return { content: [text(result)] };
      }

      return { content: [text(`未知工具：${name}`)], isError: true };
    } catch (error) {
      return { content: [text(`执行失败：${error && error.message ? error.message : String(error)}`)], isError: true };
    }
  }
}

/**
 * 以 stdio 传输运行 MCP 服务器（供 `codeguard mcp` 命令使用）
 * @param {object} [options] 透传 McpServer 构造参数
 */
function runStdio(options = {}) {
  const server = new McpServer(options);
  const readline = require('readline');

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
      return;
    }

    const response = await server.handle(message);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  });
}

module.exports = { McpServer, TOOLS, PROTOCOL_VERSION, runStdio };
