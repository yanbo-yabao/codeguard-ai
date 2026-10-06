'use strict';

/**
 * 语言画像与词法预处理
 * ---------------------------------------------------------------------------
 * 本模块解决静态分析的第一道工序：**在不引入任何语法解析器（AST）的前提下**，
 * 把源码切分为「代码区」与「注释区」两份等长文本：
 *
 *   code     —— 注释被替换为等量空格，换行符原样保留；
 *   comments —— 代码被替换为等量空格，换行符原样保留。
 *
 * 这样做的两个关键收益：
 *   1. 字符偏移与行号在预处理前后严格一一对应，规则命中后可直接回溯原始行；
 *   2. 规则既不会把被注释掉的代码误判为缺陷，也不会漏掉字符串字面量中的硬编码密钥。
 *
 * 已知局限（已在文档中声明）：正则字面量 `/.../` 与除号无法在纯词法层区分，
 * 因此形如 `a / b / c` 的表达式可能被误判为字符串，属于可接受的保守偏差。
 */

const path = require('path');

/** 语言画像表：新增语言只需补充一条画像与扩展名 */
const LANGUAGES = {
  javascript: {
    key: 'javascript',
    label: 'JavaScript',
    extensions: ['.js', '.mjs', '.cjs', '.jsx'],
    lineComments: ['//'],
    blockComments: [['/*', '*/']],
    strings: [['"', '"'], ["'", "'"], ['`', '`']],
    escapeChar: '\\',
    tripleQuoteAsComment: false,
    /** 函数定义识别模式（含命名捕获 name） */
    functionPatterns: [
      /(?:^|\s)(?:async\s+)?function\s+(?<name>[A-Za-z_$][\w$]*)\s*\(/g,
      /(?:^|\s)(?<name>[A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?(?:function\s*)?\([^)]*\)\s*=>/g,
      /(?:^|\s)(?:async\s+)?(?<name>[A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g,
    ],
    /** 复杂度判定关键字（每命中一次 +1） */
    decisionKeywords: [/\bif\b/g, /\belse\s+if\b/g, /\bfor\b/g, /\bwhile\b/g, /\bcase\b/g, /\bcatch\b/g, /&&/g, /\|\|/g, /\?\?/g, /\?\./g],
    /** 变量声明关键字，供命名规范规则使用 */
    declarationKeywords: ['const', 'let', 'var'],
  },
  typescript: {
    key: 'typescript',
    label: 'TypeScript',
    extensions: ['.ts', '.tsx', '.mts', '.cts'],
    lineComments: ['//'],
    blockComments: [['/*', '*/']],
    strings: [['"', '"'], ["'", "'"], ['`', '`']],
    escapeChar: '\\',
    tripleQuoteAsComment: false,
    functionPatterns: [
      /(?:^|\s)(?:export\s+)?(?:async\s+)?function\s+(?<name>[A-Za-z_$][\w$]*)\s*[(<]/g,
      /(?:^|\s)(?:public|private|protected|static|async|\s)*\s*(?<name>[A-Za-z_$][\w$]*)\s*\([^)]*\)\s*:\s*[\w<>[\]|.\s]+?\s*\{/g,
      /(?:^|\s)(?<name>[A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/g,
    ],
    decisionKeywords: [/\bif\b/g, /\belse\s+if\b/g, /\bfor\b/g, /\bwhile\b/g, /\bcase\b/g, /\bcatch\b/g, /&&/g, /\|\|/g, /\?\?/g, /\?\./g],
    declarationKeywords: ['const', 'let', 'var'],
  },
  python: {
    key: 'python',
    label: 'Python',
    extensions: ['.py', '.pyw'],
    lineComments: ['#'],
    blockComments: [],
    strings: [['"', '"'], ["'", "'"]],
    tripleQuotes: ['"""', "'''"],
    escapeChar: '\\',
    tripleQuoteAsComment: true,
    functionPatterns: [/^[ \t]*(?:async\s+)?def\s+(?<name>[A-Za-z_]\w*)\s*\(/gm],
    decisionKeywords: [/\bif\b/g, /\belif\b/g, /\bfor\b/g, /\bwhile\b/g, /\bexcept\b/g, /\bwith\b/g, /\band\b/g, /\bor\b/g, /\bassert\b/g],
    declarationKeywords: [],
    indentationBased: true,
  },
  java: {
    key: 'java',
    label: 'Java',
    extensions: ['.java'],
    lineComments: ['//'],
    blockComments: [['/*', '*/']],
    strings: [['"', '"'], ["'", "'"]],
    escapeChar: '\\',
    tripleQuoteAsComment: false,
    functionPatterns: [
      /(?:public|private|protected|static|final|synchronized|abstract|native|\s)+\s*(?:<[^>]+>\s*)?[\w<>[\],.\s?]+\s+(?<name>[A-Za-z_]\w*)\s*\([^)]*\)\s*(?:throws\s+[\w.,\s]+)?\s*\{/g,
    ],
    decisionKeywords: [/\bif\b/g, /\belse\s+if\b/g, /\bfor\b/g, /\bwhile\b/g, /\bcase\b/g, /\bcatch\b/g, /&&/g, /\|\|/g],
    declarationKeywords: [],
  },
  go: {
    key: 'go',
    label: 'Go',
    extensions: ['.go'],
    lineComments: ['//'],
    blockComments: [['/*', '*/']],
    strings: [['"', '"'], ['`', '`']],
    escapeChar: '\\',
    tripleQuoteAsComment: false,
    functionPatterns: [/^func\s+(?:\([^)]*\)\s*)?(?<name>[A-Za-z_]\w*)\s*\(/gm],
    decisionKeywords: [/\bif\b/g, /\bfor\b/g, /\bcase\b/g, /\bselect\b/g, /&&/g, /\|\|/g],
    declarationKeywords: ['var', 'const'],
  },
  c: {
    key: 'c',
    label: 'C',
    extensions: ['.c', '.h'],
    lineComments: ['//'],
    blockComments: [['/*', '*/']],
    strings: [['"', '"'], ["'", "'"]],
    escapeChar: '\\',
    tripleQuoteAsComment: false,
    functionPatterns: [/^[A-Za-z_][\w\s*]*\s+(?<name>[A-Za-z_]\w*)\s*\([^;]*\)\s*\{/gm],
    decisionKeywords: [/\bif\b/g, /\belse\s+if\b/g, /\bfor\b/g, /\bwhile\b/g, /\bcase\b/g, /&&/g, /\|\|/g, /\?/g],
    declarationKeywords: [],
  },
  cpp: {
    key: 'cpp',
    label: 'C++',
    extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hh'],
    lineComments: ['//'],
    blockComments: [['/*', '*/']],
    strings: [['"', '"'], ["'", "'"]],
    escapeChar: '\\',
    tripleQuoteAsComment: false,
    functionPatterns: [/^[A-Za-z_][\w:<>*&\s]*\s+(?<name>[A-Za-z_]\w*)\s*\([^;]*\)\s*(?:const)?\s*\{/gm],
    decisionKeywords: [/\bif\b/g, /\bfor\b/g, /\bwhile\b/g, /\bcase\b/g, /\bcatch\b/g, /&&/g, /\|\|/g, /\?/g],
    declarationKeywords: [],
  },
  csharp: {
    key: 'csharp',
    label: 'C#',
    extensions: ['.cs'],
    lineComments: ['//'],
    blockComments: [['/*', '*/']],
    strings: [['"', '"'], ["'", "'"]],
    escapeChar: '\\',
    tripleQuoteAsComment: false,
    functionPatterns: [
      /(?:public|private|protected|internal|static|virtual|override|async|sealed|\s)+\s*[\w<>[\],.\s?]+\s+(?<name>[A-Za-z_]\w*)\s*\([^)]*\)\s*\{/g,
    ],
    decisionKeywords: [/\bif\b/g, /\bfor\b/g, /\bforeach\b/g, /\bwhile\b/g, /\bcase\b/g, /\bcatch\b/g, /&&/g, /\|\|/g, /\?\?/g],
    declarationKeywords: [],
  },
  php: {
    key: 'php',
    label: 'PHP',
    extensions: ['.php'],
    lineComments: ['//', '#'],
    blockComments: [['/*', '*/']],
    strings: [['"', '"'], ["'", "'"]],
    escapeChar: '\\',
    tripleQuoteAsComment: false,
    functionPatterns: [/(?:public|private|protected|static|\s)*function\s+(?<name>[A-Za-z_]\w*)\s*\(/g],
    decisionKeywords: [/\bif\b/g, /\belseif\b/g, /\bfor\b/g, /\bforeach\b/g, /\bwhile\b/g, /\bcase\b/g, /\bcatch\b/g, /&&/g, /\|\|/g],
    declarationKeywords: [],
  },
  ruby: {
    key: 'ruby',
    label: 'Ruby',
    extensions: ['.rb'],
    lineComments: ['#'],
    blockComments: [],
    strings: [['"', '"'], ["'", "'"]],
    escapeChar: '\\',
    tripleQuoteAsComment: false,
    functionPatterns: [/^[ \t]*def\s+(?<name>[A-Za-z_]\w*[?!]?)/gm],
    decisionKeywords: [/\bif\b/g, /\belsif\b/g, /\bunless\b/g, /\bwhile\b/g, /\bwhen\b/g, /\brescue\b/g, /&&/g, /\|\|/g],
    declarationKeywords: [],
    indentationBased: true,
  },
  shell: {
    key: 'shell',
    label: 'Shell',
    extensions: ['.sh', '.bash', '.zsh'],
    lineComments: ['#'],
    blockComments: [],
    strings: [['"', '"'], ["'", "'"]],
    escapeChar: '\\',
    tripleQuoteAsComment: false,
    functionPatterns: [/^[ \t]*(?:function\s+)?(?<name>[A-Za-z_]\w*)\s*\(\)\s*\{/gm],
    decisionKeywords: [/\bif\b/g, /\belif\b/g, /\bfor\b/g, /\bwhile\b/g, /\bcase\b/g, /&&/g, /\|\|/g],
    declarationKeywords: [],
  },
  sql: {
    key: 'sql',
    label: 'SQL',
    extensions: ['.sql'],
    lineComments: ['--'],
    blockComments: [['/*', '*/']],
    strings: [["'", "'"]],
    escapeChar: '\\',
    tripleQuoteAsComment: false,
    functionPatterns: [],
    decisionKeywords: [/\bcase\b/gi, /\bwhen\b/gi, /\bif\b/gi],
    declarationKeywords: [],
  },
  json: {
    key: 'json',
    label: 'JSON',
    extensions: ['.json'],
    lineComments: [],
    blockComments: [],
    strings: [['"', '"']],
    escapeChar: '\\',
    tripleQuoteAsComment: false,
    functionPatterns: [],
    decisionKeywords: [],
    declarationKeywords: [],
  },
  yaml: {
    key: 'yaml',
    label: 'YAML',
    extensions: ['.yml', '.yaml'],
    lineComments: ['#'],
    blockComments: [],
    strings: [['"', '"'], ["'", "'"]],
    escapeChar: '\\',
    tripleQuoteAsComment: false,
    functionPatterns: [],
    decisionKeywords: [],
    declarationKeywords: [],
  },
  html: {
    key: 'html',
    label: 'HTML',
    extensions: ['.html', '.htm'],
    lineComments: [],
    blockComments: [['<!--', '-->']],
    strings: [['"', '"'], ["'", "'"]],
    escapeChar: '\\',
    tripleQuoteAsComment: false,
    functionPatterns: [],
    decisionKeywords: [],
    declarationKeywords: [],
  },
  css: {
    key: 'css',
    label: 'CSS',
    extensions: ['.css', '.scss', '.less'],
    lineComments: ['//'],
    blockComments: [['/*', '*/']],
    strings: [['"', '"'], ["'", "'"]],
    escapeChar: '\\',
    tripleQuoteAsComment: false,
    functionPatterns: [],
    decisionKeywords: [],
    declarationKeywords: [],
  },
  markdown: {
    key: 'markdown',
    label: 'Markdown',
    extensions: ['.md', '.markdown'],
    lineComments: [],
    blockComments: [['<!--', '-->']],
    strings: [],
    escapeChar: '\\',
    tripleQuoteAsComment: false,
    functionPatterns: [],
    decisionKeywords: [],
    declarationKeywords: [],
  },
};

/** 通用兜底画像：未知语言时不做注释剥离，仅保留基础度量能力 */
const PLAIN_PROFILE = {
  key: 'text',
  label: '纯文本',
  extensions: [],
  lineComments: [],
  blockComments: [],
  strings: [],
  escapeChar: '\\',
  tripleQuoteAsComment: false,
  functionPatterns: [],
  decisionKeywords: [],
  declarationKeywords: [],
};

/** 扩展名 → 语言键 索引 */
const EXTENSION_INDEX = (() => {
  const index = new Map();
  for (const profile of Object.values(LANGUAGES)) {
    for (const ext of profile.extensions) index.set(ext, profile.key);
  }
  return index;
})();

/**
 * 依据文件名与内容推断语言
 * @param {object} input 输入
 * @param {string} [input.fileName] 文件名（含扩展名）
 * @param {string} [input.code] 源码内容
 * @param {string} [input.language] 显式指定语言，优先级最高
 * @returns {object} 语言画像对象
 */
function detectLanguage({ fileName, code, language } = {}) {
  // 1) 显式指定优先
  if (language) {
    const key = String(language).toLowerCase();
    const alias = {
      js: 'javascript', node: 'javascript', ts: 'typescript', py: 'python',
      python3: 'python', golang: 'go', sh: 'shell', bash: 'shell', cxx: 'cpp',
      'c++': 'cpp', cs: 'csharp', csharp: 'csharp', yml: 'yaml', md: 'markdown',
      text: 'text', plain: 'text',
    };
    if (LANGUAGES[key]) return { ...LANGUAGES[key], detectedBy: 'explicit' };
    if (alias[key] && LANGUAGES[alias[key]]) return { ...LANGUAGES[alias[key]], detectedBy: 'explicit' };
  }

  // 2) 扩展名推断
  if (fileName) {
    const ext = path.extname(String(fileName)).toLowerCase();
    const key = EXTENSION_INDEX.get(ext);
    if (key) return { ...LANGUAGES[key], detectedBy: 'extension' };
  }

  // 3) 内容特征推断（常见场景保守判断）
  const sample = String(code || '').slice(0, 4000);
  if (/^\s*[{[][\s\S]*[}\]]\s*$/.test(sample) && /"\s*:/.test(sample)) {
    return { ...LANGUAGES.json, detectedBy: 'content' };
  }
  if (/^\s*(?:from|import)\s+[\w.]+|^\s*def\s+\w+\s*\(|:\s*$/m.test(sample) && /print\s*\(/.test(sample)) {
    return { ...LANGUAGES.python, detectedBy: 'content' };
  }
  if (/(?:const|let|var)\s+\w+\s*=|=>|function\s+\w+\s*\(|require\s*\(/.test(sample)) {
    return { ...LANGUAGES.javascript, detectedBy: 'content' };
  }
  if (/public\s+class\s+\w+|System\.out\.println/.test(sample)) {
    return { ...LANGUAGES.java, detectedBy: 'content' };
  }
  if (/^\s*package\s+\w+|func\s+\w+\s*\(/.test(sample)) {
    return { ...LANGUAGES.go, detectedBy: 'content' };
  }
  if (/^\s*#!.*\b(?:bash|sh)\b/.test(sample)) {
    return { ...LANGUAGES.shell, detectedBy: 'content' };
  }

  return { ...PLAIN_PROFILE, detectedBy: 'default' };
}

/**
 * 逐字符扫描源码，分离代码区与注释区
 * @param {string} code 源码
 * @param {object} profile 语言画像
 * @returns {{code:string, comments:string}} 两份等长文本
 */
function splitCodeAndComments(code, profile) {
  const source = String(code ?? '');
  const length = source.length;
  const codeChars = new Array(length);
  const commentChars = new Array(length);

  /** 按类别写入字符 */
  const put = (index, char, asComment) => {
    // 换行符始终同时写入两侧，以保证行号与偏移完全对齐
    if (char === '\n' || char === '\r') {
      codeChars[index] = char;
      commentChars[index] = char;
      return;
    }
    if (asComment) {
      codeChars[index] = ' ';
      commentChars[index] = char;
    } else {
      codeChars[index] = char;
      commentChars[index] = ' ';
    }
  };

  // 按 token 长度预排序，保证长 token（如 `"""`）先于短 token（如 `"`）匹配
  const blockPairs = [...(profile.blockComments || [])].sort((a, b) => b[0].length - a[0].length);
  const tripleQuotes = profile.tripleQuotes || [];
  const stringPairs = [...(profile.strings || [])].sort((a, b) => b[0].length - a[0].length);
  const lineTokens = [...(profile.lineComments || [])].sort((a, b) => b.length - a.length);

  let i = 0;
  let mode = 'code';          // code | lineComment | blockComment | string
  let closing = null;         // 结束标记
  let commentLike = false;    // 字符串是否按注释统计（Python 文档字符串）
  let escaped = false;

  while (i < length) {
    const char = source[i];

    if (mode === 'lineComment') {
      if (char === '\n') {
        mode = 'code';
        put(i, char, false);
        i += 1;
        continue;
      }
      put(i, char, true);
      i += 1;
      continue;
    }

    if (mode === 'blockComment') {
      if (source.startsWith(closing, i)) {
        for (let k = 0; k < closing.length; k += 1) put(i + k, source[i + k], true);
        i += closing.length;
        mode = 'code';
        closing = null;
        continue;
      }
      put(i, char, true);
      i += 1;
      continue;
    }

    if (mode === 'string') {
      if (escaped) {
        put(i, char, commentLike);
        escaped = false;
        i += 1;
        continue;
      }
      if (char === profile.escapeChar) {
        put(i, char, commentLike);
        escaped = true;
        i += 1;
        continue;
      }
      if (char === '\n' && closing !== '`' && !closing.startsWith('"""') && !closing.startsWith("'''")) {
        // 普通字符串不跨行：遇到换行视为字面量提前结束，避免整文件被吞
        mode = 'code';
        put(i, char, false);
        i += 1;
        continue;
      }
      if (source.startsWith(closing, i)) {
        for (let k = 0; k < closing.length; k += 1) put(i + k, source[i + k], commentLike);
        i += closing.length;
        mode = 'code';
        closing = null;
        commentLike = false;
        continue;
      }
      put(i, char, commentLike);
      i += 1;
      continue;
    }

    // mode === 'code'：依次尝试匹配块注释、行注释、三引号、普通字符串
    let matched = false;

    for (const [open, close] of blockPairs) {
      if (source.startsWith(open, i)) {
        for (let k = 0; k < open.length; k += 1) put(i + k, source[i + k], true);
        i += open.length;
        mode = 'blockComment';
        closing = close;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    for (const token of lineTokens) {
      if (source.startsWith(token, i)) {
        for (let k = 0; k < token.length; k += 1) put(i + k, source[i + k], true);
        i += token.length;
        mode = 'lineComment';
        matched = true;
        break;
      }
    }
    if (matched) continue;

    for (const triple of tripleQuotes) {
      if (source.startsWith(triple, i)) {
        const asComment = Boolean(profile.tripleQuoteAsComment);
        for (let k = 0; k < triple.length; k += 1) put(i + k, source[i + k], asComment);
        i += triple.length;
        mode = 'string';
        closing = triple;
        commentLike = asComment;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    for (const [open, close] of stringPairs) {
      if (source.startsWith(open, i)) {
        put(i, source[i], false);
        i += open.length;
        mode = 'string';
        closing = close;
        commentLike = false;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    put(i, char, false);
    i += 1;
  }

  return { code: codeChars.join(''), comments: commentChars.join('') };
}

/**
 * 按行切分，统一去除行尾 \r
 * @param {string} text 文本
 * @returns {string[]} 行数组
 */
function splitLines(text) {
  return String(text ?? '').split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

/**
 * 将字符串字面量替换为等量空格，得到「纯语法」文本
 * ---------------------------------------------------------------------------
 * 用途：面向运算符与关键字的规则（松散相等、浮点比较、花括号配对等）必须在
 * **不含字符串内容** 的文本上匹配，否则 `if (a === "==")` 之类的写法会被误报。
 * 设计：先由 splitCodeAndComments 抹掉注释，再调用本函数抹掉字符串，两阶段互不干扰。
 * @param {string} code 已剥离注释的代码
 * @param {object} profile 语言画像
 * @returns {string} 换行保留、字符串被空格替换的文本
 */
function blankStrings(code, profile) {
  const source = String(code ?? '');
  const out = source.split('');
  const pairs = [...(profile.strings || [])].sort((a, b) => b[0].length - a[0].length);
  const triples = profile.tripleQuotes || [];

  /** 把指定区间替换为空格（换行保留） */
  const blankRange = (start, end) => {
    for (let k = start; k < end; k += 1) {
      if (source[k] !== '\n' && source[k] !== '\r') out[k] = ' ';
    }
  };

  let i = 0;
  while (i < source.length) {
    let opening = null;
    let closing = null;

    for (const triple of triples) {
      if (source.startsWith(triple, i)) {
        opening = triple;
        closing = triple;
        break;
      }
    }
    if (!opening) {
      for (const [open, close] of pairs) {
        if (source.startsWith(open, i)) {
          opening = open;
          closing = close;
          break;
        }
      }
    }

    if (!opening) {
      i += 1;
      continue;
    }

    blankRange(i, i + opening.length);
    let j = i + opening.length;
    let escaped = false;
    const multiline = closing === '`' || closing.startsWith('"""') || closing.startsWith("'''");

    while (j < source.length) {
      const char = source[j];

      if (escaped) {
        if (char !== '\n') out[j] = ' ';
        escaped = false;
        j += 1;
        continue;
      }
      if (char === profile.escapeChar) {
        out[j] = ' ';
        escaped = true;
        j += 1;
        continue;
      }
      // 普通字符串不跨行：遇到换行即视为字面量提前闭合，避免吞掉后续代码
      if (char === '\n' && !multiline) break;
      if (source.startsWith(closing, j)) {
        blankRange(j, j + closing.length);
        j += closing.length;
        break;
      }
      if (char !== '\n' && char !== '\r') out[j] = ' ';
      j += 1;
    }

    i = j;
  }

  return out.join('');
}

module.exports = {
  LANGUAGES,
  PLAIN_PROFILE,
  EXTENSION_INDEX,
  detectLanguage,
  splitCodeAndComments,
  blankStrings,
  splitLines,
};
