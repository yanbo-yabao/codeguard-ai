'use strict';

/**
 * 确定性语法检查器（零依赖、离线可用）
 * ---------------------------------------------------------------------------
 * 为「AI 代码补全与语法诊断」流水线提供静态语法检查能力，与大模型诊断形成
 * 双引擎交叉印证：静态结论确定性可复现，大模型结论覆盖语义级问题。
 *
 * 三层检查策略（宁可漏报、不可误报）：
 *   SYN001 括号匹配   基于三通道词法（注释/字符串内的括号不计），适用于大多数语言；
 *   SYN002 字符串闭合 基于同一词法扫描，检测未闭合的引号/三引号；
 *   SYN003 编译验证   仅 JavaScript：用 Node 内置 vm 真实编译，结论权威；
 *                     对 ESM（import/export）、顶层 await、JSX 等合法语法做
 *                     抑制处理，避免把「vm 不支持的语法」误报成语法错误。
 *
 * 标记类语言（HTML/XML/Markdown）的尖括号与文本符号不是运算符，
 * 启发式检查必然误报，因此整类跳过。
 */

const vm = require('vm');
const { detectLanguage, splitCodeAndComments, blankStrings } = require('./languages');
const { SEVERITIES } = require('../core/taxonomy');

/** 不做启发式括号检查的语言（文本/标记语言中括号出现在正文里是常态） */
const HEURISTIC_SKIP_KEYS = new Set(['html', 'xml', 'markdown', 'plain', 'text', 'svg']);

/** 括号配对表 */
const OPENERS = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = { ')': '(', ']': '[', '}': '{' };

/** 语言无关的常见拼写错误（这些拼写几乎不可能是合法标识符） */
const TYPO_WORDS_COMMON = [
  'fuction', 'funtion', 'functon', 'funtcion',
  'retrn', 'reutrn', 'retrun', 'rutrn', 'reut', 'retrun',
  'pritn', 'pirnt', 'prnit',
  'whlie', 'wihle', 'contiune', 'contine', 'breka',
  'swtich', 'swithc', 'esle', 'eles',
  'ture', 'flase',
];

/** 各语言特有的拼写错误 */
const TYPO_WORDS_BY_KEY = {
  python: [
    'deif', 'calss', 'imprt', 'imrpot', 'lamda', 'lmbda',
    'yeild', 'yiled', 'asert', 'assrt', 'glboal',
    'exept', 'excpet', 'finaly', 'finnaly', 'ellif',
    'isntance', 'tpye', 'slef', 'Nnoe',
  ],
  java: ['pubilc', 'privte', 'protecetd', 'statci', 'voif', 'viod', 'itn', 'flaot', 'Strnig', 'stirng', 'boolen', 'fianl'],
  c: ['incldue', 'inclde', 'pritnf', 'maloc', 'memst', 'strln'],
  cpp: ['incldue', 'inclde', 'nmaespace', 'coutn', 'vectro', 'srding'],
  csharp: ['nmaespace', 'pubilc', 'privte', 'statci', 'itn', 'Strnig'],
  go: ['fucntion', 'prnit'],
};

/** 常见「属性 / 方法名」拼写错误（紧跟在 . 之后出现，几乎必然是笔误） */
const PROPERTY_TYPOS = ['lenght', 'mappper', 'forech', 'fliter', 'reducce', 'subtring', 'toLowwer', 'toUpeer', 'concatt'];

/** Python 需要以冒号结尾的复合语句关键字 */
const PYTHON_HEADERS = /^(?:[ \t]*)(?:async[ \t]+)?(?:def|class|if|elif|else|for|while|try|except|finally|with)\b/;

/**
 * 由字符偏移计算行列号
 * @param {number[]} lineStarts 每行起始偏移
 * @param {number} offset 字符偏移
 * @returns {{line:number, column:number}} 行列号
 */
function positionAt(lineStarts, offset) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (lineStarts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low + 1, column: offset - lineStarts[low] + 1 };
}

/**
 * 构造标准问题对象（与静态规则引擎的问题结构保持一致）
 * @param {object} fields 问题字段
 * @returns {object} 问题对象
 */
function syntaxIssue(fields) {
  const severity = fields.severity || 'major';
  return {
    id: `${fields.ruleId}:${fields.line}:${fields.column || 1}`,
    ruleId: fields.ruleId,
    title: fields.title,
    dimension: 'bug',
    dimensionLabel: '缺陷风险',
    severity,
    severityLabel: SEVERITIES[severity]?.label || severity,
    severityOrder: SEVERITIES[severity]?.order || 3,
    line: fields.line,
    column: fields.column || 1,
    message: fields.message,
    suggestion: fields.suggestion,
    snippet: fields.snippet || '',
    reference: fields.reference || '语法检查',
    source: 'static',
    confidence: fields.confidence ?? 0.95,
  };
}

/**
 * 词法扫描：一次遍历同时完成括号匹配与字符串闭合检测
 * ---------------------------------------------------------------------------
 * 与 languages.js 的三通道预处理同源：注释、字符串内的符号一律跳过，
 * 因此 `div / 2` 不会被误判，字符串里的 `(` 也不会被计入。
 * @param {string} source 源码
 * @param {object} profile 语言画像
 * @returns {{brackets:object[], strings:object[]}} 原始检测事件
 */
function lexAudit(source, profile) {
  const bracketEvents = [];
  const stringEvents = [];
  const stack = [];
  /** 当前字符串状态：{ opener, closeSeq, line, col } 或 null */
  let inString = null;
  let i = 0;
  let line = 1;
  let col = 1;

  const lineComments = profile.lineComments || [];
  const blockComments = profile.blockComments || [];
  const stringPairs = profile.strings || [];
  const tripleQuotes = profile.tripleQuotes || [];
  const escapeChar = profile.escapeChar || null;

  /** 跳过一段文本并同步行/列位置 */
  const advance = (count) => {
    for (let k = 0; k < count; k += 1) {
      if (source[i] === '\n') {
        line += 1;
        col = 1;
      } else {
        col += 1;
      }
      i += 1;
    }
  };

  while (i < source.length) {
    const rest = source.slice(i);

    // —— 字符串内部 ——
    if (inString) {
      if (escapeChar && source[i] === escapeChar) {
        advance(2);
        continue;
      }
      if (rest.startsWith(inString.closeSeq)) {
        advance(inString.closeSeq.length);
        inString = null;
        continue;
      }
      advance(1);
      continue;
    }

    // —— 行注释 ——
    const lineComment = lineComments.find((token) => rest.startsWith(token));
    if (lineComment) {
      const end = source.indexOf('\n', i);
      advance(end === -1 ? source.length - i : end - i);
      continue;
    }

    // —— 块注释 ——
    const block = blockComments.find(([open]) => rest.startsWith(open));
    if (block) {
      const [open, close] = block;
      const end = source.indexOf(close, i + open.length);
      advance(end === -1 ? source.length - i : end + close.length - i);
      continue;
    }

    // —— 三引号字符串（Python 文档字符串等） ——
    const triple = tripleQuotes.find((token) => rest.startsWith(token));
    if (triple) {
      const end = source.indexOf(triple, i + triple.length);
      if (end === -1) {
        stringEvents.push({ line, col, opener: triple });
        advance(source.length - i);
      } else {
        advance(end + triple.length - i);
      }
      continue;
    }

    // —— 普通字符串 ——
    const pair = stringPairs.find(([open]) => rest.startsWith(open));
    if (pair) {
      const [open, close] = pair;
      inString = { closeSeq: close, line, col, opener: open };
      advance(open.length);
      continue;
    }

    // —— 括号 ——
    const char = source[i];
    if (OPENERS[char]) {
      stack.push({ char, line, col });
    } else if (CLOSERS[char]) {
      const top = stack[stack.length - 1];
      if (!top) {
        bracketEvents.push({ type: 'extra', char, line, col });
      } else if (OPENERS[top.char] !== char) {
        bracketEvents.push({ type: 'mismatch', char, expected: OPENERS[top.char], opener: top, line, col });
        stack.pop();
      } else {
        stack.pop();
      }
    }
    advance(1);
  }

  // 文件结束时仍未闭合的字符串 / 括号
  if (inString) {
    stringEvents.push({ line: inString.line, col: inString.col, opener: inString.opener, unterminated: true });
  }
  for (const opener of stack) {
    bracketEvents.push({ type: 'unclosed', opener, line: opener.line, col: opener.col });
  }

  return { brackets: bracketEvents, strings: stringEvents };
}

/**
 * JavaScript 真实编译检查（Node 内置 vm，结论权威）
 * ---------------------------------------------------------------------------
 * 对 vm 语义不支持但合法的语法做抑制：
 *   - ESM 的 import / export（vm.Script 按脚本语义编译）；
 *   - 顶层 await（合法于模块与异步上下文）；
 *   - JSX（React 代码在 .js 中是常见实践）。
 * @param {string} code 源码
 * @param {string[]} lines 源码行数组
 * @returns {object[]} 问题列表（0 或 1 个）
 */
function compileCheckJavaScript(code, lines) {
  try {
    // eslint-disable-next-line no-new
    new vm.Script(code, { filename: 'input.js' });
    return [];
  } catch (error) {
    if (!(error instanceof SyntaxError)) return [];

    const message = error.message || '';
    const stack = error.stack || '';

    // —— 抑制规则：vm 不支持的合法语法不当作语法错误 ——
    if (/(?:^|\W)(?:import|export)(?:\W|$)/m.test(code) && /import|export/i.test(message)) return [];
    if (/\bawait\b/.test(code) && /await/i.test(message)) return [];
    if (/<\/?[A-Za-z][^>]*>/.test(code) && /Unexpected token '<'|Unexpected token "<"/.test(message)) return [];
    // 模板字符串、可选链等新语法在极老内核上的误报（正常内核不会进入此分支）
    if (/Unexpected token '\?'|Invalid or unexpected token/.test(message) && /\?\.|\?\?|`/.test(code)) return [];

    // —— 提取行号：vm 的语法错误堆栈首行即 input.js:<line> ——
    const match = /input\.js:(\d+)/.exec(stack);
    const errorLine = match ? Number(match[1]) : lines.length;

    return [
      syntaxIssue({
        ruleId: 'SYN003',
        title: 'JavaScript 语法错误（编译验证）',
        severity: 'critical',
        line: Math.min(Math.max(errorLine, 1), lines.length),
        message: `Node 解析该代码时报语法错误：${message.replace(/\s+at input\.js[\s\S]*$/, '').trim()}`,
        suggestion:
          '按报错行号修正语法。常见原因：括号/引号不配对、缺少分号或逗号、关键字拼写错误。' +
          '修正后可再次提交验证。',
        snippet: (lines[Math.min(Math.max(errorLine, 1), lines.length) - 1] || '').trim().slice(0, 120),
        reference: 'ECMA-262 语法',
        confidence: 1,
      }),
    ];
  }
}

/**
 * 常见拼写错误检查（SYN004）
 * ---------------------------------------------------------------------------
 * 在语法通道（注释/字符串已置空）上匹配拼写错误词，因此注释与字符串里的
 * 示例文字不会误报。词表全部选用「几乎不可能是合法标识符」的拼写，
 * 宁可漏报、不可误报。
 * @param {string} source 源码
 * @param {object} profile 语言画像
 * @param {string[]} lines 源码行数组
 * @returns {object[]} 问题列表
 */
function typoAudit(source, profile, lines) {
  const issues = [];
  const { code: codeOnly } = splitCodeAndComments(source, profile);
  const syntaxOnly = blankStrings(codeOnly, profile);
  const lineStarts = [0];
  for (let i = 0; i < syntaxOnly.length; i += 1) {
    if (syntaxOnly[i] === '\n') lineStarts.push(i + 1);
  }

  const push = (index, word, message, suggestion) => {
    const { line, column } = positionAt(lineStarts, index);
    issues.push(
      syntaxIssue({
        ruleId: 'SYN004',
        title: '疑似拼写错误',
        line,
        column,
        message: message(word),
        suggestion: suggestion(word),
        snippet: (lines[line - 1] || '').trim().slice(0, 120),
        confidence: 0.9,
      }),
    );
  };

  // —— 关键字 / 常见词拼写 ——
  const words = [...new Set([...TYPO_WORDS_COMMON, ...(TYPO_WORDS_BY_KEY[profile.key] || [])])];
  if (words.length > 0) {
    const pattern = new RegExp(`(?<![\\w$])(?:${words.join('|')})(?![\\w$])`, 'g');
    let match;
    while ((match = pattern.exec(syntaxOnly)) !== null) {
      push(
        match.index,
        match[0],
        (word) => `「${word}」看起来是拼写错误，会导致解析失败或运行时报错`,
        (word) => `请核对并改写为正确的关键字 / 标识符拼写（例如 retrn → return、fuction → function）。`,
      );
    }
  }

  // —— 属性 / 方法名拼写（紧跟 . 之后） ——
  const propertyPattern = new RegExp(`\\.(?:${PROPERTY_TYPOS.join('|')})(?![\\w$])`, 'g');
  let propertyMatch;
  while ((propertyMatch = propertyPattern.exec(syntaxOnly)) !== null) {
    const word = propertyMatch[0].slice(1);
    push(
      propertyMatch.index + 1,
      word,
      (w) => `调用了不存在的方法 / 属性「.${w}」，运行时会抛出 TypeError / undefined`,
      (w) => `请核对 API 拼写，例如 .lenght → .length、.mappper → .map、.forech → .forEach、.fliter → .filter。`,
    );
  }

  // —— Python 小写 true / false / none ——
  if (profile.key === 'python') {
    const literalPattern = /(?<![\w$.])(?:true|false|none)(?![\w$])/g;
    let literalMatch;
    while ((literalMatch = literalPattern.exec(syntaxOnly)) !== null) {
      const word = literalMatch[0];
      const expected = { true: 'True', false: 'False', none: 'None' }[word];
      push(
        literalMatch.index,
        word,
        (w) => `Python 中应写「${expected}」，小写的「${w}」不是内置常量，运行时会抛出 NameError`,
        (w) => `改写为「${expected}」。`,
      );
    }
  }

  return issues;
}

/**
 * Python 结构检查（SYN005）
 * ---------------------------------------------------------------------------
 * 两类确定性错误：
 *   1. 复合语句（def / if / for / with …）缺少冒号 —— 必然 SyntaxError；
 *   2. Tab 与空格混用缩进 —— 两行缩进「展开宽度相同但组成不同」时，
 *      代码含义取决于 Tab 的宽度，Python 3 必然抛 TabError。
 * 检查在语法通道上进行：字符串 / 注释中的伪代码不会误报。
 * @param {string} source 源码
 * @returns {object[]} 问题列表
 */
function pythonStructureAudit(source) {
  const issues = [];
  const profile = detectLanguage({ code: source, language: 'python' });
  const { code: codeOnly } = splitCodeAndComments(source, profile);
  const syntaxOnly = blankStrings(codeOnly, profile);
  const lines = syntaxOnly.split('\n');
  const original = source.split('\n');
  const lineStarts = [0];
  for (let i = 0; i < syntaxOnly.length; i += 1) {
    if (syntaxOnly[i] === '\n') lineStarts.push(i + 1);
  }

  // —— 1. 复合语句缺少冒号 ——
  let depth = 0;
  let spanStart = -1;
  let spanText = '';
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const isHeader = depth === 0 && spanStart === -1 && PYTHON_HEADERS.test(line);

    for (const char of line) {
      if (OPENERS[char]) depth += 1;
      else if (CLOSERS[char]) depth = Math.max(0, depth - 1);
    }

    if (isHeader) {
      spanStart = i;
      spanText = line;
    } else if (spanStart >= 0) {
      spanText += `\n${line}`;
    }

    if (spanStart >= 0 && depth === 0) {
      if (!/:/.test(spanText)) {
        issues.push(
          syntaxIssue({
            ruleId: 'SYN005',
            title: 'Python 复合语句缺少冒号',
            line: spanStart + 1,
            message: `第 ${spanStart + 1} 行的语句以「${(spanText.trim().split(/\s+/)[0])}」开头，但结尾缺少冒号「:」，Python 解析时会报 SyntaxError`,
            suggestion: '在该语句结尾补上冒号「:」，例如 def add(a, b): / if x > 0:。',
            snippet: (original[spanStart] || '').trim().slice(0, 120),
            confidence: 0.95,
          }),
        );
      }
      spanStart = -1;
      spanText = '';
    }
  }

  // —— 2. Tab 与空格混用导致缩进歧义 ——
  /** 展开宽度 → 首次出现的原始缩进 */
  const indentSeen = new Map();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    const rawIndent = /^[ \t]*/.exec(line)[0];
    if (!rawIndent) continue;

    let width = 0;
    for (const char of rawIndent) {
      width = char === '\t' ? (Math.floor(width / 8) + 1) * 8 : width + 1;
    }

    const previous = indentSeen.get(width);
    if (previous && previous.raw !== rawIndent) {
      issues.push(
        syntaxIssue({
          ruleId: 'SYN005',
          title: 'Tab 与空格混用（缩进歧义）',
          line: i + 1,
          message:
            `第 ${i + 1} 行的缩进与第 ${previous.line} 行宽度相同，但 Tab / 空格组成不同` +
            `（「${rawIndent.replace(/\t/g, '\\t').replace(/ /g, '·')}」vs「${previous.raw.replace(/\t/g, '\\t').replace(/ /g, '·')}」），` +
            'Python 3 会因 Tab 与空格混用而报 TabError',
          suggestion: '统一缩进风格：推荐全部用 4 个空格（编辑器里开启「将 Tab 转为空格」），或全部用 Tab，不要混用。',
          snippet: (original[i] || '').replace(/\t/g, '\\t').trim().slice(0, 120),
          confidence: 0.95,
        }),
      );
    } else if (!previous) {
      indentSeen.set(width, { raw: rawIndent, line: i + 1 });
    }
  }

  return issues;
}

/**
 * 执行语法检查
 * @param {object} input 输入
 * @param {string} input.code 源码
 * @param {string} [input.language] 语言键（可选，默认按文件名/内容识别）
 * @param {string} [input.fileName] 文件名
 * @returns {{issues:object[], checkedBy:object}} 检查结果
 */
function checkSyntax({ code, language, fileName } = {}) {
  const source = String(code ?? '');
  const lines = source.split('\n');
  const profile = detectLanguage({ fileName, code: source, language });
  const issues = [];
  const checkedBy = { heuristic: false, compiler: false };

  // —— 启发式检查：括号匹配 + 字符串闭合 ——
  if (!HEURISTIC_SKIP_KEYS.has(profile.key) && profile.strings) {
    checkedBy.heuristic = true;
    const audit = lexAudit(source, profile);

    for (const event of audit.brackets) {
      if (event.type === 'extra') {
        issues.push(
          syntaxIssue({
            ruleId: 'SYN001',
            title: '括号不匹配',
            line: event.line,
            column: event.col,
            message: `第 ${event.line} 行出现了没有对应左括号的「${event.char}」`,
            suggestion: `删除多余的「${event.char}」，或补上与之配对的左括号「${CLOSERS[event.char]}」。`,
            snippet: (lines[event.line - 1] || '').trim().slice(0, 120),
          }),
        );
      } else if (event.type === 'mismatch') {
        issues.push(
          syntaxIssue({
            ruleId: 'SYN001',
            title: '括号不匹配',
            line: event.line,
            column: event.col,
            message:
              `第 ${event.line} 行的「${event.char}」与第 ${event.opener.line} 行的「${event.opener.char}」不配对` +
              `（此处应为「${event.expected}」）`,
            suggestion: `将第 ${event.line} 行的「${event.char}」改为「${event.expected}」，或检查第 ${event.opener.line} 行的括号类型。`,
            snippet: (lines[event.line - 1] || '').trim().slice(0, 120),
          }),
        );
      } else if (event.type === 'unclosed') {
        issues.push(
          syntaxIssue({
            ruleId: 'SYN001',
            title: '括号未闭合',
            line: event.line,
            column: event.col,
            message: `第 ${event.line} 行的「${event.opener.char}」直到文件结束都没有闭合`,
            suggestion: `在合适位置补上闭合括号「${OPENERS[event.opener.char]}」。`,
            snippet: (lines[event.line - 1] || '').trim().slice(0, 120),
          }),
        );
      }
    }

    for (const event of audit.strings) {
      issues.push(
        syntaxIssue({
          ruleId: 'SYN002',
          title: '字符串未闭合',
          line: event.line,
          column: event.col,
          message: `第 ${event.line} 行以 ${event.opener} 开始的字符串直到文件结束都没有闭合`,
          suggestion: `补上结束引号 ${event.opener}；若内容中包含引号，请使用转义（\\${event.opener}）或改用其他引号包裹。`,
          snippet: (lines[event.line - 1] || '').trim().slice(0, 120),
        }),
      );
    }
  }

  // —— 常见拼写错误（SYN004）：关键字与属性名笔误 ——
  if (!HEURISTIC_SKIP_KEYS.has(profile.key) && profile.strings) {
    issues.push(...typoAudit(source, profile, lines));
  }

  // —— Python 结构检查（SYN005）：缺冒号 / Tab 空格混用 ——
  if (profile.key === 'python') {
    checkedBy.pythonStructure = true;
    issues.push(...pythonStructureAudit(source));
  }

  // —— 编译级检查：JavaScript ——
  if (profile.key === 'javascript') {
    checkedBy.compiler = true;
    issues.push(...compileCheckJavaScript(source, lines));
  }

  return { issues, checkedBy };
}

module.exports = { checkSyntax, lexAudit, compileCheckJavaScript, HEURISTIC_SKIP_KEYS };
