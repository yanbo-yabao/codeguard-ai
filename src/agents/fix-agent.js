'use strict';

/**
 * 修复建议 Agent
 * ---------------------------------------------------------------------------
 * 把「问题描述 + 代码上下文」转化为可直接落地的补丁。两层策略：
 *   1. 优先调用大模型生成带上下文感知的 diff 与测试建议；
 *   2. 大模型不可用或失败时，退化为规则内置的修复模板（离线可用，保证功能不中断）。
 */

const logger = require('../core/logger');
const { buildFixPrompt } = require('./prompt-templates');
const { escapeHtml } = require('../core/utils');

const log = logger.child('fix-agent');

/** 规则 ID → 离线修复模板（大模型不可用时的兜底） */
const OFFLINE_TEMPLATES = {
  SEC001: {
    rationale: '把硬编码凭据改为从环境变量读取，并同步补充 .env.example 占位符。',
    before: 'const API_KEY = "sk-xxxxxxxx";',
    after: 'const API_KEY = process.env.API_KEY;\nif (!API_KEY) throw new Error("缺少环境变量 API_KEY");',
    tests: ['缺失环境变量时启动应抛出明确错误', '配置环境变量后能正常完成鉴权调用'],
  },
  SEC002: {
    rationale: '用显式解析替代动态执行，消除代码注入通道。',
    before: 'const result = eval(userExpression);',
    after: 'const result = JSON.parse(userExpression); // 或改用白名单表达式求值器',
    tests: ['非法表达式应返回解析错误而非执行', '合法输入解析结果与预期一致'],
  },
  SEC003: {
    rationale: '改为参数化查询，让数据库驱动负责转义，从根本上消除 SQL 注入。',
    before: 'const sql = "SELECT * FROM users WHERE name = \'" + name + "\'";',
    after: 'const sql = "SELECT * FROM users WHERE name = ?";\nawait db.query(sql, [name]);',
    tests: ['输入包含单引号时不报错且不改变查询语义', '输入 \' OR 1=1 -- 时返回空结果'],
  },
  SEC004: {
    rationale: '改用参数数组直接执行程序，绕开 shell 解析。',
    before: 'exec("git log " + branch);',
    after: 'execFile("git", ["log", branch]); // 不经过 shell，参数不会被解释为命令',
    tests: ['分支名包含 ; rm -rf / 时不会执行额外命令'],
  },
  SEC005: {
    rationale: '改用密码学安全随机源生成凭据。',
    before: 'const token = Math.random().toString(36).slice(2);',
    after: 'const token = crypto.randomBytes(32).toString("hex");',
    tests: ['连续生成 1000 个令牌无重复', '令牌长度与熵值满足预期'],
  },
  SEC007: {
    rationale: '恢复证书校验，通过 CA 配置解决自签证书信任问题。',
    before: 'httpsAgent: new https.Agent({ rejectUnauthorized: false })',
    after: 'httpsAgent: new https.Agent({ ca: fs.readFileSync(process.env.CA_BUNDLE) })',
    tests: ['使用受信任证书时请求成功', '使用无效证书时应拒绝连接'],
  },
  BUG001: {
    rationale: '改为严格相等，避免隐式类型转换带来的判定偏差。',
    before: 'if (count == "0") { ... }',
    after: 'if (count === 0) { ... }',
    tests: ['count 为字符串 "0" 时不进入分支', 'count 为数字 0 时进入分支'],
  },
  BUG002: {
    rationale: '为异常处理补充具体处置动作，让故障可观测、可回溯。',
    before: 'try { await save(data); } catch (e) {}',
    after: 'try {\n  await save(data);\n} catch (error) {\n  logger.error("保存失败", { error, data });\n  throw error;\n}',
    tests: ['保存失败时应记录日志并向上抛出', '保存成功时不应产生错误日志'],
  },
  BUG005: {
    rationale: '在除法前显式校验除数，避免 Infinity / NaN 向下游传播。',
    before: 'const rate = total / count;',
    after: 'const rate = count === 0 ? 0 : total / count;',
    tests: ['count 为 0 时返回 0', 'count 非 0 时返回正确商值'],
  },
  PERF001: {
    rationale: '把串行的逐个 await 改为 Promise.all 并行执行。',
    before: 'for (const id of ids) {\n  await fetchItem(id);\n}',
    after: 'await Promise.all(ids.map((id) => fetchItem(id))); // 需要限流时可分批处理',
    tests: ['批量请求总耗时接近单个请求耗时量级', '任一请求失败时应整体拒绝并保留上下文'],
  },
  PERF002: {
    rationale: '把同步阻塞 IO 换成异步版本，避免阻塞事件循环。',
    before: 'const content = fs.readFileSync(file, "utf8");',
    after: 'const content = await fs.promises.readFile(file, "utf8");',
    tests: ['并发读取多个文件时互不阻塞'],
  },
  MNT002: {
    rationale: '用卫语句消除深层分支，把圈复杂度降到可测试范围。',
    before: 'function f(u) {\n  if (u) {\n    if (u.active) {\n      if (u.role === "admin") { return doAdmin(); }\n    }\n  }\n  return null;\n}',
    after: 'function f(user) {\n  if (!user) return null;\n  if (!user.active) return null;\n  if (user.role !== "admin") return null;\n  return doAdmin();\n}',
    tests: ['各卫语句分支均被覆盖', '圈复杂度降至 5 以下'],
  },
};

/**
 * 生成离线修复方案
 * @param {object} issue 问题对象
 * @param {string} code 相关代码片段
 * @returns {object} 修复方案
 */
function buildOfflineFix(issue, code) {
  const template = OFFLINE_TEMPLATES[issue.ruleId];
  if (!template) {
    return {
      applicable: false,
      offline: true,
      rationale: `该问题（${issue.ruleId} ${issue.title}）暂无内置修复模板，建议参考问题描述中的建议手工处理，或配置大模型以获取上下文感知的补丁。`,
      risk: 'medium',
      before: issue.snippet || '',
      after: '',
      diff: '',
      tests: [],
    };
  }

  return {
    applicable: true,
    offline: true,
    rationale: template.rationale,
    risk: 'low',
    before: template.before,
    after: template.after,
    diff: buildUnifiedDiff(template.before, template.after, issue.line),
    tests: template.tests || [],
    note: '本方案由内置修复模板生成（离线可用）。配置大模型后可获得结合完整上下文的差异化补丁。',
  };
}

/**
 * 生成简化版统一 diff 文本
 * @param {string} before 修复前
 * @param {string} after 修复后
 * @param {number} startLine 起始行号
 * @returns {string} diff 文本
 */
function buildUnifiedDiff(before, after, startLine = 1) {
  const beforeLines = String(before).split('\n');
  const afterLines = String(after).split('\n');
  const header = `@@ -${startLine},${beforeLines.length} +${startLine},${afterLines.length} @@`;
  const removed = beforeLines.map((line) => `-${line}`);
  const added = afterLines.map((line) => `+${line}`);
  return [header, ...removed, ...added].join('\n');
}

/** 修复建议 Agent */
class FixAgent {
  /**
   * @param {object} options 选项
   * @param {import('./llm-client').LlmClient} options.client 大模型客户端
   */
  constructor({ client }) {
    this.client = client;
  }

  /**
   * 为单个问题生成修复方案
   * @param {object} input 输入
   * @param {object} input.issue 问题对象
   * @param {string} input.code 完整源码
   * @param {string} input.language 语言标签
   * @returns {Promise<object>} 修复方案
   */
  async suggestFix({ issue, code, language }) {
    const lines = String(code ?? '').split('\n');
    const from = Math.max(1, issue.line - 15);
    const to = Math.min(lines.length, issue.line + 15);
    const context = lines.slice(from - 1, to).join('\n');

    if (!this.client.available) {
      return { ...buildOfflineFix(issue, context), source: 'template' };
    }

    try {
      const payload = await this.client.chatJson({
        messages: buildFixPrompt({ issue, code: context, language }),
        temperature: 0.1,
      });

      const applicable = payload.applicable !== false;
      const result = {
        applicable,
        offline: false,
        source: 'llm',
        rationale: String(payload.rationale || '').trim(),
        risk: ['low', 'medium', 'high'].includes(payload.risk) ? payload.risk : 'medium',
        before: String(payload.before || '').trim(),
        after: String(payload.after || '').trim(),
        diff: String(payload.diff || '').trim(),
        tests: Array.isArray(payload.tests) ? payload.tests.slice(0, 6).map(String) : [],
        model: payload._meta?.model || null,
      };

      // 模型未给出有效补丁时，用内置模板补齐，避免前端出现空白面板
      if (!applicable || (!result.after && !result.diff)) {
        return { ...buildOfflineFix(issue, context), source: 'template', fallbackReason: '模型未返回可用补丁' };
      }
      return result;
    } catch (error) {
      log.warn(`生成修复方案失败，改用内置模板：${error.message}`);
      return { ...buildOfflineFix(issue, context), source: 'template', fallbackReason: error.message };
    }
  }

  /**
   * 批量生成修复方案（按严重级别优先，限制总数以控制成本）
   * @param {object} input 输入
   * @param {Array<object>} input.issues 问题列表
   * @param {string} input.code 源码
   * @param {string} input.language 语言
   * @param {number} [input.limit] 最多生成几条
   * @returns {Promise<Array<object>>} 修复方案列表（含 issueId）
   */
  async suggestFixBatch({ issues, code, language, limit = 8 }) {
    const targets = issues.slice(0, limit);
    const output = [];
    for (const issue of targets) {
      const fix = await this.suggestFix({ issue, code, language });
      output.push({ issueId: issue.id, ruleId: issue.ruleId, title: issue.title, line: issue.line, ...fix });
    }
    return output;
  }
}

module.exports = { FixAgent, buildOfflineFix, buildUnifiedDiff, OFFLINE_TEMPLATES };
