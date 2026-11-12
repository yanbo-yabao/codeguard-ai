'use strict';

/**
 * 提示词模板
 * ---------------------------------------------------------------------------
 * 三类任务各有独立契约：
 *   1. 语法诊断  buildDiagnosePrompt  —— 找错误 + 修改方法 + 修复后代码
 *   2. 解题补全  buildCompletePrompt  —— 讲解思路 + 完整代码（支持图片提问）
 *   3. 变式出题  buildQuizPrompt      —— 在原题基础上微改出题 + 测试用例 + 参考答案
 *
 * 输出契约原则：结构固定（严格 JSON）、字段语义明确、禁止编造，
 * 解析端只需实现一套逻辑。
 */

/** 严重级别判定口径：让不同角色对同一表述给出一致的分级 */
const SEVERITY_GUIDE = `
严重级别判定口径（务必统一）：
- blocker：必然导致凭据泄露、远程代码执行、数据损毁等不可接受后果
- critical：在常见输入下即会触发安全漏洞或服务不可用
- major：会导致偶发故障、明显性能劣化或行为不符合预期
- minor：影响可读性、可维护性，功能本身正确
- info：风格建议与可选优化
`.trim();

/**
 * 组装带行号的代码块
 * @param {string} code 源码
 * @param {number} [startLine] 起始行号
 * @returns {string} 形如 `12 | const a = 1;` 的文本
 */
function numberCode(code, startLine = 1) {
  return String(code ?? '')
    .split('\n')
    .map((line, index) => `${String(startLine + index).padStart(4, ' ')} | ${line}`)
    .join('\n');
}

/**
 * 构建语法诊断提示词（输出含修复后代码）
 * @param {object} input 输入
 * @param {string} input.code 代码
 * @param {string} input.language 语言标签
 * @param {string} [input.prompt] 用户的期望行为描述
 * @param {string} [input.fileName] 文件名
 * @param {Array<object>} [input.staticHints] 静态检查已发现的问题
 * @param {Array<object>} [input.knowledge] RAG 检索到的参考资料
 * @returns {Array<{role:string,content:string}>} 消息列表
 */
function buildDiagnosePrompt({ code, language, prompt, fileName, staticHints, knowledge }) {
  const hintsSection =
    staticHints && staticHints.length > 0
      ? `\n静态语法检查已发现以下问题（请勿重复报告，可补充其遗漏的语义级问题，并为每条问题给出具体修改方法）：\n${staticHints
          .map((hint) => `- 第 ${hint.line} 行：${hint.title}（${hint.ruleId}）：${hint.message}`)
          .join('\n')}\n`
      : '';

  const knowledgeSection =
    knowledge && knowledge.length > 0
      ? `\n【参考资料】（内置知识库按相关性检索，修复方案请参考其修复模式）：\n${knowledge
          .map((item) => `- ${item.title}：${item.content}`)
          .join('\n')}\n`
      : '';

  return [
    {
      role: 'system',
      content: `你是一名资深语言实现专家，擅长精确定位代码中的语法错误与显而易见的运行期错误，并给出可直接照做的修改方法。

你的职责：
- 语法错误：括号/引号不配对、缺少分隔符、关键字拼写错误、非法结构
- 显性运行期错误：使用未声明的变量、调用不存在的方法、必抛异常的写法
- 与用户意图明显不符的结构缺失（如函数缺少 return、分支缺少闭合）

评审纪律：
1. 每条问题必须给出「如何修改」：写清改哪一行、怎么改，必要时给出修改后的代码片段
2. 只报告确定性问题，不做风格评论，不猜测未给出的上下文
3. 若代码没有问题，findings 返回空数组即可，不要凑数

${SEVERITY_GUIDE}

你必须只输出一个 JSON 对象，不要输出任何解释性文字、Markdown 代码块标记或前后缀说明。
JSON 结构必须严格如下：
{
  "summary": "用一句中文概括本次诊断的总体结论",
  "findings": [
    {
      "line": 12,
      "severity": "blocker | critical | major | minor | info",
      "title": "不超过 16 字的问题标题",
      "message": "问题描述：说明触发条件与可能后果",
      "suggestion": "如何修改：写清改哪一行、怎么改，必要时给出修改后的代码片段",
      "confidence": 0.0 到 1.0 之间的数字
    }
  ],
  "fixedCode": "应用全部修复后的完整代码（纯代码文本，不要 markdown 围栏标记）"
}
fixedCode 必须是修复后的完整代码：保持原有结构与命名，只改动必要的部分。
若代码没有问题，findings 返回空数组、fixedCode 返回空字符串。严禁编造代码中不存在的问题。`,
    },
    {
      role: 'user',
      content: `角色：syntax（语法诊断）
语言：${language}
${fileName ? `文件：${fileName}` : ''}
${prompt ? `用户的期望行为（用于理解代码应有形态）：${prompt}` : ''}
${hintsSection}
【待诊断代码】（行号格式为「行号 | 代码」，findings.line 与之一致）
${numberCode(code)}
${knowledgeSection}
请严格按照约定的 JSON 结构输出诊断结果。`,
    },
  ];
}

/**
 * 构建解题 / 代码补全提示词（输出含面向学习者的讲解）
 * ---------------------------------------------------------------------------
 * 支持多模态：提供 imageUrl 时，用户消息为「文本 + 图片」两段，
 * 由支持视觉的大模型理解图片内容（题目截图、报错截图、手写笔记等）。
 * @param {object} input 输入
 * @param {string} input.prompt 用户的问题 / 要实现的功能（必填）
 * @param {string} [input.code] 现有代码（可为空，从零生成）
 * @param {string} input.language 语言标签
 * @param {string} [input.fileName] 文件名
 * @param {string} [input.imageUrl] 图片（data URL，base64），可选
 * @param {Array<object>} [input.knowledge] RAG 检索到的参考资料
 * @returns {Array<{role:string,content:string|Array<object>}>} 消息列表
 */
function buildCompletePrompt({ prompt, code, language, fileName, imageUrl, knowledge }) {
  const knowledgeSection =
    knowledge && knowledge.length > 0
      ? `\n【参考资料】（内置知识库按相关性检索，实现时请遵循其最佳实践）：\n${knowledge
          .map((item) => `- ${item.title}：${item.content}`)
          .join('\n')}\n`
      : '';

  const textPart = `角色：complete（解题与代码补全）
语言：${language}
${fileName ? `文件：${fileName}` : ''}

【用户的问题 / 补全意图】
${prompt}
${imageUrl ? '\n（用户还附了一张图片，请结合图片内容理解问题；图片可能是题目截图、报错截图或手写笔记）' : ''}

【现有代码】（可为空）
${code && code.trim() ? numberCode(code) : '（无，从零生成）'}
${knowledgeSection}
请给出讲解与完整代码。`;

  const userContent = imageUrl
    ? [
        { type: 'text', text: textPart },
        { type: 'image_url', image_url: { url: imageUrl } },
      ]
    : textPart;

  return [
    {
      role: 'system',
      content: `你是一位耐心的编程老师兼代码补全专家：既能把题目讲透，也能交付可直接运行的完整代码。

要求：
1. answer 讲解面向学习者：先讲思路（怎么想到的），再讲每一步为什么这样做，点出涉及的知识点；不要只给结论
2. completedCode 必须语法完整、可直接运行，关键位置有简洁注释；保留用户已有代码的结构，只补全缺失部分
3. 若用户给的是图片（题目/报错），先在讲解中复述你从图片读到的题意，读不清的地方要指出
4. 严禁引入硬编码密钥、eval 等不安全写法

输出要求：只输出一个 JSON 对象，不要任何解释文字或 Markdown 代码块标记。
{
  "answer": "面向学习者的解题讲解（思路 + 每步原因 + 知识点，可用 1. 2. 3. 分点）",
  "completedCode": "完整代码（纯代码文本，不要 markdown 围栏标记）",
  "notes": ["补全要点说明，1~3 条"]
}`,
    },
    { role: 'user', content: userContent },
  ];
}

/**
 * 构建变式出题提示词（学习检验）
 * ---------------------------------------------------------------------------
 * 在用户刚学过的题目基础上「微改」出一道变式题，配套可自动判题的测试用例。
 * @param {object} input 输入
 * @param {string} input.prompt 原题 / 刚学内容的描述
 * @param {string} [input.code] 用户刚写出的解答（供出题参考）
 * @param {string} input.language 语言标签
 * @returns {Array<{role:string,content:string}>} 消息列表
 */
function buildQuizPrompt({ prompt, code, language }) {
  return [
    {
      role: 'system',
      content: `你是一位编程课出题老师，负责在学生刚学过的题目基础上出「变式题」检验掌握程度。

出题纪律：
1. 变式 = 在原题基础上微改：换条件、换问法、加约束、换数据范围，考点不变但不能照抄原题
2. 题面要完整独立（学生只看变式题就能做），难度与原题相当
3. 测试用例必须能自动判题：程序从标准输入读入、向标准输出写出结果；每组用例的 expected 就是标准输出的精确内容
4. referenceSolution 必须亲自验证过能通过全部测试用例
5. starterCode 给出读输入的骨架与 TODO 注释，降低起步门槛

输出要求：只输出一个 JSON 对象，不要任何解释文字或 Markdown 代码块标记。
{
  "title": "变式题标题（15 字内）",
  "description": "完整题面：题目描述、输入格式、输出格式、样例说明",
  "starterCode": "起始代码骨架（含读输入与 TODO 注释，纯代码文本）",
  "testCases": [
    { "input": "标准输入内容", "expected": "标准输出的精确内容" }
  ],
  "referenceSolution": "参考实现（同语言，能通过全部测试用例，纯代码文本）",
  "hints": ["给学生的提示，2~3 条，不要直接泄露答案"]
}
testCases 给 3~5 组，必须包含题目样例和至少一组边界情况。`,
    },
    {
      role: 'user',
      content: `角色：quiz（变式出题）
语言：${language}

【学生刚学过的题目 / 内容】
${prompt}

【学生刚写出的解答】（供了解其水平，出题时贴近其掌握程度）
${code && code.trim() ? numberCode(code) : '（未提供）'}

请出一道变式题。`,
    },
  ];
}

module.exports = {
  SEVERITY_GUIDE,
  numberCode,
  buildDiagnosePrompt,
  buildCompletePrompt,
  buildQuizPrompt,
};
