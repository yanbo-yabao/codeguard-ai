'use strict';

/**
 * 代码度量引擎
 * ---------------------------------------------------------------------------
 * 采用「按语言画像驱动的启发式解析」计算可量化指标，为评分卡与可维护性维度提供依据。
 * 指标清单：
 *   - 规模类：总行数、代码行、注释行、空行、注释率、最长行、超长行数
 *   - 结构类：函数数量、最长函数、参数过多函数、最大嵌套深度
 *   - 复杂度：圈复杂度（总/平均/最大），基于 V(G) = 1 + 判定节点数 的标准定义
 *
 * 说明：圈复杂度按 McCabe 定义计算判定节点（if/for/while/case/catch/&&/|| 等），
 * 在纯词法层无法区分嵌套判定与顺序判定，因此该值属于**上界估计**，
 * 用于横向比较同一项目内不同函数的相对复杂度是可靠的。
 */

const { clamp, round } = require('../core/utils');

/** 预计算换行位置，用于快速回算行号 */
function buildLineIndex(text) {
  const positions = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') positions.push(i);
  }
  return positions;
}

/**
 * 保留字黑名单
 * 函数识别模式为兼顾词边界会写成「可选空白 + 标识符 + 参数列表 + 花括号」的宽松形式，
 * 因此控制流语句（if/for/while/catch…）会落入匹配范围，必须显式排除，
 * 否则会把它们当成函数，污染「函数数量/最长函数/复杂度」等全部结构指标。
 */
const RESERVED_FUNCTION_NAMES = new Set([
  'if', 'else', 'elseif', 'for', 'foreach', 'while', 'do', 'switch', 'case', 'default',
  'try', 'catch', 'finally', 'return', 'throw', 'new', 'delete', 'typeof', 'instanceof',
  'in', 'of', 'with', 'await', 'yield', 'async', 'function', 'class', 'interface', 'enum',
  'struct', 'namespace', 'union', 'select', 'when', 'unless', 'loop', 'match', 'let', 'const',
  'var', 'import', 'export', 'use', 'then', 'and', 'or', 'not', 'assert', 'synchronized',
]);

/**
 * 由字符偏移换算行号（1 基）
 * @param {number[]} lineIndex 换行位置数组
 * @param {number} offset 字符偏移
 * @returns {number} 行号
 */
function lineOf(lineIndex, offset) {
  let low = 0;
  let high = lineIndex.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (lineIndex[mid] < offset) low = mid + 1;
    else high = mid;
  }
  return low + 1;
}

/**
 * 计算文本的代码嵌套深度（按语句块花括号计）
 * ---------------------------------------------------------------------------
 * 只统计 `{` / `}`，**有意忽略圆括号与方括号**：
 * 调用链 `Promise.all(urls.map(x => ...))` 与数组字面量 `[[1,2],[3,4]]` 会产生
 * 很深的括号层数，但它们并不增加阅读者的条件上下文负担。若一并计入，
 * 规范代码（大量链式调用）会被系统性误判为「嵌套过深」。
 * 局限：对象字面量 `{ a: { b: 1 } }` 仍会被计入，属于保守偏差。
 * @param {string} text 代码片段
 * @returns {number} 最大深度
 */
function maxBraceDepth(text) {
  let depth = 0;
  let max = 0;
  for (const char of text) {
    if (char === '{') {
      depth += 1;
      if (depth > max) max = depth;
    } else if (char === '}') {
      depth = Math.max(0, depth - 1);
    }
  }
  return max;
}

/**
 * 计算缩进式语言的嵌套深度（按缩进层级估算）
 * @param {string[]} lines 代码行
 * @param {number} baseIndent 基准缩进宽度
 * @param {number} indentUnit 单层缩进宽度
 * @returns {number} 最大嵌套层数
 */
function maxIndentDepth(lines, baseIndent, indentUnit) {
  let max = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const indent = line.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length;
    max = Math.max(max, Math.floor((indent - baseIndent) / indentUnit));
  }
  return Math.max(0, max);
}

/**
 * 统计括号内的参数个数（按顶层逗号切分）
 * @param {string} paramsText 括号内容
 * @returns {number} 参数数量
 */
function countParams(paramsText) {
  const text = String(paramsText || '').trim();
  if (!text) return 0;
  let depth = 0;
  let count = 1;
  for (const char of text) {
    if ('([{<'.includes(char)) depth += 1;
    else if (')]}>'.includes(char)) depth = Math.max(0, depth - 1);
    else if (char === ',' && depth === 0) count += 1;
  }
  return count;
}

/**
 * 计算圈复杂度：1 + 判定节点命中次数
 * @param {string} body 函数体文本
 * @param {object} profile 语言画像
 * @returns {number} 圈复杂度
 */
function cyclomaticComplexity(body, profile) {
  let count = 1;
  for (const pattern of profile.decisionKeywords || []) {
    const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    const matched = body.match(re);
    if (matched) count += matched.length;
  }
  return count;
}

/**
 * 定位函数体的起止偏移（花括号语言）
 * @param {string} code 代码文本
 * @param {RegExpExecArray} match 函数定义匹配结果
 * @returns {{start:number,end:number}|null} 函数体偏移区间
 */
function locateBraceBody(code, match) {
  // 优先在匹配文本内寻找左花括号；否则在其后方有限的窗口内寻找
  let braceOffset = match[0].lastIndexOf('{');
  let braceIndex = braceOffset >= 0 ? match.index + braceOffset : -1;

  if (braceIndex < 0) {
    const searchFrom = match.index + match[0].length;
    const window = code.slice(searchFrom, searchFrom + 300);
    const relative = window.indexOf('{');
    if (relative < 0) return null;
    braceIndex = searchFrom + relative;
  }

  let depth = 0;
  for (let i = braceIndex; i < code.length; i += 1) {
    const char = code[i];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return { start: braceIndex, end: i };
    }
  }
  return null;
}

/**
 * 提取括号内的参数文本
 * @param {string} code 代码文本
 * @param {number} beforeIndex 函数体起始偏移
 * @returns {string} 参数文本
 */
function extractParamText(code, beforeIndex) {
  const openIndex = code.lastIndexOf('(', beforeIndex);
  if (openIndex < 0) return '';
  let depth = 0;
  for (let i = openIndex; i < beforeIndex; i += 1) {
    if (code[i] === '(') depth += 1;
    else if (code[i] === ')') {
      depth -= 1;
      if (depth === 0) return code.slice(openIndex + 1, i);
    }
  }
  return '';
}

/**
 * 识别所有函数及其规模与复杂度
 * @param {string} code 已剥离注释的代码
 * @param {object} profile 语言画像
 * @returns {Array<object>} 函数信息列表
 */
function findFunctions(code, profile) {
  const functions = [];
  const seen = new Set();
  const lineIndex = buildLineIndex(code);

  if (profile.indentationBased) {
    // 缩进式语言：以 def/function 行为起点，向后取同级缩进之前的行作为函数体
    const lines = code.split('\n');
    for (const pattern of profile.functionPatterns || []) {
      const re = new RegExp(pattern.source, pattern.flags.includes('m') ? pattern.flags : `${pattern.flags}m`);
      let match;
      while ((match = re.exec(code)) !== null) {
        if (match[0].length === 0) {
          re.lastIndex += 1;
          continue;
        }
        const startOffset = match.index + (match[0].length - match[0].trimStart().length);
        const startLineNo = lineOf(lineIndex, startOffset);
        const defLine = lines[startLineNo - 1] ?? '';
        const baseIndent = defLine.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length;
        const name = (match.groups && match.groups.name) || '（匿名）';
        if (RESERVED_FUNCTION_NAMES.has(name)) continue;
        const key = `${name}:${startLineNo}`;
        if (seen.has(key)) continue;
        seen.add(key);

        let endLineNo = startLineNo;
        for (let i = startLineNo; i < lines.length; i += 1) {
          const line = lines[i];
          if (!line.trim()) continue;
          const indent = line.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length;
          if (indent <= baseIndent) break;
          endLineNo = i + 1;
        }

        const bodyLines = lines.slice(startLineNo - 1, endLineNo);
        const body = bodyLines.join('\n');
        functions.push({
          name,
          startLine: startLineNo,
          endLine: endLineNo,
          lines: endLineNo - startLineNo + 1,
          complexity: cyclomaticComplexity(body, profile),
          nesting: maxIndentDepth(bodyLines.slice(1), baseIndent, 4),
          params: countParams((defLine.match(/\(([\s\S]*)\)/) || [])[1] || ''),
        });
      }
    }
    return functions.sort((a, b) => a.startLine - b.startLine);
  }

  for (const pattern of profile.functionPatterns || []) {
    const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    let match;
    while ((match = re.exec(code)) !== null) {
      if (match[0].length === 0) {
        re.lastIndex += 1;
        continue;
      }
      const name = (match.groups && match.groups.name) || '（匿名）';
      if (RESERVED_FUNCTION_NAMES.has(name)) continue;

      const body = locateBraceBody(code, match);
      if (!body) continue;

      // 匹配模式带有前置空白（用于锚定词边界），换算行号时必须先剔除，否则会少算一行
      const startOffset = match.index + (match[0].length - match[0].trimStart().length);
      const startLine = lineOf(lineIndex, startOffset);
      const endLine = lineOf(lineIndex, body.end);
      const key = `${name}:${body.start}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const bodyText = code.slice(body.start, body.end + 1);
      functions.push({
        name,
        startLine,
        endLine,
        lines: endLine - startLine + 1,
        complexity: cyclomaticComplexity(bodyText, profile),
        nesting: maxBraceDepth(bodyText),
        params: countParams(extractParamText(code, body.start)),
      });
    }
  }

  return functions.sort((a, b) => a.startLine - b.startLine);
}

/**
 * 计算全部度量指标
 * @param {object} input 输入
 * @param {string} input.code 原始源码
 * @param {string} input.codeOnly 已剥离注释的代码
 * @param {string} input.commentOnly 仅含注释的文本
 * @param {object} input.profile 语言画像
 * @returns {object} 度量结果
 */
function computeMetrics({ code, codeOnly, commentOnly, profile }) {
  const sourceLines = String(code ?? '').split('\n');
  const codeLines = String(codeOnly ?? '').split('\n');
  const commentLines = String(commentOnly ?? '').split('\n');

  let blankLines = 0;
  let pureCommentLines = 0;
  let pureCodeLines = 0;
  let maxLineLength = 0;
  let longLineCount = 0;
  let trailingWhitespaceCount = 0;
  const MAX_LINE = 120;

  for (let i = 0; i < sourceLines.length; i += 1) {
    const original = sourceLines[i];
    const text = original.replace(/\r$/, '');
    const hasCode = Boolean((codeLines[i] ?? '').trim());
    const hasComment = Boolean((commentLines[i] ?? '').trim());

    if (!text.trim()) blankLines += 1;
    else if (hasComment && !hasCode) pureCommentLines += 1;
    else if (hasCode) pureCodeLines += 1;

    if (text.length > maxLineLength) maxLineLength = text.length;
    if (text.length > MAX_LINE) longLineCount += 1;
    if (/[ \t]+$/.test(text)) trailingWhitespaceCount += 1;
  }

  const totalLines = sourceLines.length;
  const nonBlankLines = totalLines - blankLines;
  const commentRatio = nonBlankLines > 0 ? pureCommentLines / nonBlankLines : 0;

  const functions = findFunctions(String(codeOnly ?? ''), profile);
  const complexityList = functions.map((fn) => fn.complexity);
  const totalComplexity = complexityList.reduce((sum, value) => sum + value, 0);
  const maxComplexity = complexityList.length ? Math.max(...complexityList) : 0;
  const maxFunctionLength = functions.length ? Math.max(...functions.map((fn) => fn.lines)) : 0;
  const maxNesting = functions.length ? Math.max(...functions.map((fn) => fn.nesting)) : 0;
  const longFunctions = functions.filter((fn) => fn.lines > 80);
  const complexFunctions = functions.filter((fn) => fn.complexity > 15);
  const manyParamFunctions = functions.filter((fn) => fn.params > 5);

  const todoCount = (String(commentOnly ?? '').match(/\b(TODO|FIXME|XXX|HACK)\b/gi) || []).length;

  /**
   * 简化可维护性指数（0~100，越高越好）
   * 参考 Halstead 版 MI 的形态：规模与复杂度为负向因子，注释率为正向因子。
   * 注意：每一项都必须显式加括号 —— 三元运算符优先级低于加减，漏括号会使整个
   * 表达式退化为「三选一」，从而输出与规模无关的固定值。
   */
  const maintainabilityIndex = clamp(
    round(
      100
        - Math.log2(Math.max(totalLines, 1)) * 5.5
        - (complexityList.length ? totalComplexity / complexityList.length : 0) * 2.2
        + commentRatio * 30
        - (commentRatio < 0.05 ? 8 : 0),
      1,
    ),
    0,
    100,
  );

  return {
    totalLines,
    nonBlankLines,
    blankLines,
    codeLines: pureCodeLines,
    commentLines: pureCommentLines,
    commentRatio: round(commentRatio, 3),
    maxLineLength,
    avgLineLength: totalLines ? round(sourceLines.join('').length / totalLines, 1) : 0,
    longLineCount,
    longLineThreshold: MAX_LINE,
    trailingWhitespaceCount,
    functionCount: functions.length,
    maxFunctionLength,
    avgFunctionLength: functions.length
      ? round(functions.reduce((sum, fn) => sum + fn.lines, 0) / functions.length, 1)
      : 0,
    longFunctions: longFunctions.map((fn) => ({ name: fn.name, lines: fn.lines, startLine: fn.startLine })),
    complexFunctions: complexFunctions.map((fn) => ({
      name: fn.name,
      complexity: fn.complexity,
      startLine: fn.startLine,
    })),
    manyParamFunctions: manyParamFunctions.map((fn) => ({
      name: fn.name,
      params: fn.params,
      startLine: fn.startLine,
    })),
    totalComplexity,
    maxComplexity,
    avgComplexity: complexityList.length ? round(totalComplexity / complexityList.length, 2) : 0,
    maxNesting,
    todoCount,
    maintainabilityIndex,
    functions,
  };
}

module.exports = {
  computeMetrics,
  findFunctions,
  cyclomaticComplexity,
  maxBraceDepth,
  lineOf,
  buildLineIndex,
  countParams,
};
