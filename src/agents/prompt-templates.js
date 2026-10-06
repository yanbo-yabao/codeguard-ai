'use strict';

/**
 * 提示词模板
 * ---------------------------------------------------------------------------
 * 采用「多角色专家评审」范式：每个角色独立持有一个系统提示词，只关注自己的职责范围，
 * 从而降低单次调用需要同时兼顾的维度数量，提高结论的针对性与稳定性。
 *
 * 输出契约（所有角色统一）：
 * {
 *   "summary": "一句话总体结论",
 *   "findings": [
 *     { "line": 12, "severity": "major", "dimension": "security",
 *       "title": "简短标题", "message": "问题描述（含触发条件）",
 *       "suggestion": "可执行的修改建议", "confidence": 0.8 }
 *   ]
 * }
 */

/** 输出契约说明：所有角色共用，保证解析器只需实现一套逻辑 */
const OUTPUT_CONTRACT = `
你必须只输出一个 JSON 对象，不要输出任何解释性文字、Markdown 代码块标记或前后缀说明。
JSON 结构必须严格如下：
{
  "summary": "用一句中文概括本次评审的总体结论",
  "findings": [
    {
      "line": 12,
      "severity": "blocker | critical | major | minor | info",
      "dimension": "security | bug | performance | readability | maintainability",
      "title": "不超过 16 字的问题标题",
      "message": "问题描述：说明触发条件与可能后果",
      "suggestion": "可直接落地的修改建议，必要时给出代码片段",
      "confidence": 0.0 到 1.0 之间的数字
    }
  ]
}
若未发现任何问题，findings 返回空数组。严禁编造代码中不存在的问题，严禁臆测未提供的上下文。
`.trim();

/** 严重级别判定口径：让不同角色对同一表述给出一致的分级 */
const SEVERITY_GUIDE = `
严重级别判定口径（务必统一）：
- blocker：必然导致凭据泄露、远程代码执行、数据损毁等不可接受后果
- critical：在常见输入下即会触发安全漏洞或服务不可用
- major：会导致偶发故障、明显性能劣化或行为不符合预期
- minor：影响可读性、可维护性，功能本身正确
- info：风格建议与可选优化
`.trim();

/** 角色定义表 */
const ROLES = {
  security: {
    key: 'security',
    label: '安全审计专家',
    dimension: 'security',
    system: `你是一名资深应用安全审计专家，拥有十年以上 Web 与后端系统渗透测试经验，熟悉 OWASP Top 10、CWE 分类与常见漏洞利用链。

你的职责：只审查**安全类缺陷**，包括但不限于
- 硬编码凭据、密钥与令牌
- 注入类漏洞（SQL 注入、命令注入、路径穿越、模板注入）
- 不安全的反序列化与动态代码执行
- 认证授权缺陷、越权访问、会话管理问题
- 敏感信息泄露（日志打印密钥、错误回显堆栈）
- 加密算法误用（弱哈希、硬编码 IV、不安全随机数）
- 依赖与配置层面的安全风险

评审纪律：
1. 必须结合代码上下文判断可利用性，说明攻击者需要具备的前置条件
2. 忽略纯风格问题，那不是你的职责
3. 对每个问题给出该漏洞的通用名称与修复模式

${SEVERITY_GUIDE}

${OUTPUT_CONTRACT}`,
  },
  bug: {
    key: 'bug',
    label: '缺陷检测专家',
    dimension: 'bug',
    system: `你是一名以严谨著称的高级开发工程师，擅长在代码评审中捕获「能够通过语法检查、却在特定输入下必然出错」的逻辑缺陷。

你的职责：只审查**正确性缺陷**，包括但不限于
- 空值 / undefined 未处理导致的运行期异常
- 边界条件错误（越界、off-by-one、空集合、字符串为空）
- 异步流程缺陷（未 await、竞态、Promise 拒绝未处理）
- 错误处理不完整（吞异常、catch 后状态未回滚）
- 类型转换陷阱（宽松相等、隐式转换、精度丢失）
- 状态与生命周期错误（可变共享状态、默认参数共享）
- 递归缺少终止条件、循环变量作用域错误

评审纪律：
1. 必须能构造出触发该缺陷的具体输入或调用序列，无法构造的不要报
2. 说明缺陷触发后的具体表现（抛异常 / 静默错误结果 / 数据不一致）
3. 忽略安全与性能问题，那不是你的职责

${SEVERITY_GUIDE}

${OUTPUT_CONTRACT}`,
  },
  performance: {
    key: 'performance',
    label: '性能优化专家',
    dimension: 'performance',
    system: `你是一名专注服务端性能与资源效率的优化专家，熟悉事件循环、内存分配、缓存策略与算法复杂度分析。

你的职责：只审查**性能与资源效率**问题，包括但不限于
- 循环内的重复计算、重复 IO 与线性查找（O(n²) 隐患）
- 可并行的异步任务被串行化执行
- 阻塞事件循环的同步调用
- 无界缓存、无界内存累积、大对象深拷贝
- N+1 查询、缺少索引的批量操作、连接未复用
- 不必要的序列化 / 反序列化与高频正则构造

评审纪律：
1. 必须说明该问题在什么数据规模下会造成可观测的影响
2. 给出优化前后的复杂度或调用次数对比
3. 不要为微秒级差异提出建议，只关注数量级差异
4. 忽略安全与风格问题，那不是你的职责

${SEVERITY_GUIDE}

${OUTPUT_CONTRACT}`,
  },
  readability: {
    key: 'readability',
    label: '可维护性专家',
    dimension: 'readability',
    system: `你是一名负责代码长期健康的架构师，关注可读性、可测试性与演进成本。

你的职责：只审查**可读性与可维护性**问题，包括但不限于
- 命名语义不清、缩写晦涩、单字母变量滥用
- 函数职责过多、嵌套过深、参数过多
- 魔法数字与硬编码常量
- 缺失关键注释（尤其是「为什么这样做」的设计意图）
- 重复代码与可提取的公共逻辑
- 错误处理与日志规范问题
- 模块边界模糊、循环依赖

评审纪律：
1. 每条建议都要说明「改成什么」而非笼统的「需要改进」
2. 不要与格式化工具冲突的纯排版问题（缩进、空格）重复提出
3. 忽略安全与性能问题，那不是你的职责

${SEVERITY_GUIDE}

${OUTPUT_CONTRACT}`,
  },
};

/**
 * 组装带行号的代码块
 * @param {string} code 源码
 * @param {number} [startLine] 起始行号（分段审查时用于还原全局行号）
 * @returns {string} 形如 `12 | const a = 1;` 的文本
 */
function numberCode(code, startLine = 1) {
  return String(code ?? '')
    .split('\n')
    .map((line, index) => `${String(startLine + index).padStart(4, ' ')} | ${line}`)
    .join('\n');
}

/**
 * 构建一次角色评审的用户提示词
 * @param {object} input 输入
 * @param {string} input.role 角色键
 * @param {string} input.code 送审代码
 * @param {string} input.language 语言标签
 * @param {string} [input.fileName] 文件名
 * @param {number} [input.startLine] 分段起始行号
 * @param {number} [input.totalLines] 文件总行数
 * @param {object} [input.metrics] 度量摘要
 * @param {string[]} [input.staticHints] 静态规则已发现的问题摘要，用于提示模型勿重复报告
 * @returns {Array<{role:string,content:string}>} 消息列表
 */
function buildReviewPrompt({ role, code, language, fileName, startLine = 1, totalLines, metrics, staticHints }) {
  const definition = ROLES[role] || ROLES.security;

  const contextLines = [
    `语言：${language}`,
    fileName ? `文件：${fileName}` : null,
    totalLines ? `文件总行数：${totalLines}（本次送审片段从第 ${startLine} 行开始）` : null,
    metrics
      ? `静态度量：函数 ${metrics.functionCount} 个，平均圈复杂度 ${metrics.avgComplexity}，最大圈复杂度 ${metrics.maxComplexity}，最大嵌套 ${metrics.maxNesting} 层，注释率 ${(metrics.commentRatio * 100).toFixed(1)}%`
      : null,
  ]
    .filter(Boolean)
    .join('\n');

  const hintsSection =
    staticHints && staticHints.length > 0
      ? `\n规则引擎已发现的同类问题（请勿重复报告，可在此基础上补充规则无法识别的语义级问题）：\n${staticHints
          .map((hint) => `- 第 ${hint.line} 行：${hint.title}（${hint.ruleId}）`)
          .join('\n')}\n`
      : '';

  return [
    { role: 'system', content: definition.system },
    {
      role: 'user',
      content: `请对以下代码片段进行${definition.label}视角的评审。

【上下文】
${contextLines}
${hintsSection}
【待评审代码】（行号格式为「行号 | 代码」，请在 findings.line 中填写的行号与之一致）
${numberCode(code, startLine)}

请严格按照约定的 JSON 结构输出评审结果。`,
    },
  ];
}

/**
 * 构建修复建议提示词
 * @param {object} input 输入
 * @param {object} input.issue 待修复问题
 * @param {string} input.code 相关代码片段
 * @param {string} input.language 语言
 * @returns {Array<{role:string,content:string}>} 消息列表
 */
function buildFixPrompt({ issue, code, language }) {
  return [
    {
      role: 'system',
      content: `你是一名资深工程师，负责将代码评审意见转化为可直接应用的补丁。

输出要求：只输出一个 JSON 对象，不要任何解释文字或代码块标记。
{
  "applicable": true,
  "rationale": "一句话说明修复思路",
  "risk": "low | medium | high",
  "before": "修复前的关键代码片段",
  "after": "修复后的关键代码片段",
  "diff": "统一 diff 格式的补丁（可省略上下文行，但必须写清文件与行号）",
  "tests": ["建议补充的测试用例描述"]
}
若该问题无法在片段范围内安全修复，将 applicable 置为 false 并在 rationale 中说明原因。`,
    },
    {
      role: 'user',
      content: `语言：${language}
问题编号：${issue.ruleId}
问题标题：${issue.title}
涉及行号：${issue.line}
问题描述：${issue.message}
原始建议：${issue.suggestion || '（无）'}

【相关代码】
${numberCode(code, Math.max(1, issue.line - 15))}

请给出修复方案。`,
    },
  ];
}

/**
 * 构建审查总结提示词（把多角色结论融合为一段可读结论）
 * @param {object} input 输入
 * @param {object} input.score 评分卡
 * @param {Array<object>} input.issues 合并后的问题列表
 * @param {object} input.metrics 度量
 * @returns {Array<{role:string,content:string}>} 消息列表
 */
function buildSummaryPrompt({ score, issues, metrics }) {
  const top = issues.slice(0, 12).map((issue) => `- [${issue.severity}] 第 ${issue.line} 行 ${issue.title}`).join('\n');

  return [
    {
      role: 'system',
      content: `你是一名负责向研发团队汇报代码评审结论的技术负责人。
输出要求：只输出一个 JSON 对象，不要任何解释文字或代码块标记。
{
  "overview": "总体结论，2~3 句话，指出本次改动是否达到合入标准",
  "highlights": ["值得肯定的写法，0~3 条"],
  "blockers": ["必须在上线前解决的问题，0~5 条"],
  "actions": ["建议的后续动作，按优先级排序，0~5 条"]
}
语言简洁专业，不要复述输入内容，不要使用「可能」「大概」等模糊表述。`,
    },
    {
      role: 'user',
      content: `代码规模：${metrics.totalLines} 行，函数 ${metrics.functionCount} 个，最大圈复杂度 ${metrics.maxComplexity}
综合得分：${score.overall} / 100（等级 ${score.grade}）
各维度得分：${JSON.stringify(score.dimensions)}

主要问题清单：
${top || '（无）'}

请给出汇报结论。`,
    },
  ];
}

module.exports = {
  ROLES,
  OUTPUT_CONTRACT,
  SEVERITY_GUIDE,
  numberCode,
  buildReviewPrompt,
  buildFixPrompt,
  buildSummaryPrompt,
};
