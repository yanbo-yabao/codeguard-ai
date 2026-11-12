'use strict';

/**
 * 真编译器语法检查（SYN006）
 * ---------------------------------------------------------------------------
 * 用本机真实的编译器 / 解释器对代码做「只查不跑」的语法检查，把编译器诊断
 * 转换为标准问题对象，让离线模式也能给出**编译器级**的准确错误（哪一行、
 * 为什么错、怎么改）。这补上了纯启发式检查的盲区（例如 C 代码里的 `reut}`
 * 这类拼写/缺分号错误，gcc 一行就能指出）。
 *
 * 覆盖：
 *   c          gcc -fsyntax-only
 *   cpp        g++ -fsyntax-only
 *   java       javac（编译到临时目录，不运行）
 *   python     python -m py_compile（只编译字节码，不运行）
 *   （JavaScript 已由 syntax-checker 内置 vm 编译检查覆盖）
 *
 * 无编译器时静默跳过（issues 为空、checkedBy.realCompiler=false），
 * 由启发式检查兜底，绝不报错。
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { SEVERITIES } = require('../core/taxonomy');
const { RunService } = require('../runners/runner-service');

/** 单次编译检查的诊断数量上限（编译器级联报错会刷屏，取最有价值的前几条） */
const MAX_DIAGNOSTICS = 8;
/** 编译超时（毫秒） */
const COMPILE_TIMEOUT_MS = 15000;

/**
 * 构造标准问题对象（与 syntax-checker 的问题结构保持一致）
 * @param {object} fields 问题字段
 * @returns {object} 问题对象
 */
function compilerIssue(fields) {
  const severity = fields.severity || 'major';
  return {
    id: `SYN006:${fields.line}:${fields.column || 1}:${fields.index || 0}`,
    ruleId: 'SYN006',
    title: fields.title || '编译错误',
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
    reference: fields.reference || '编译器诊断',
    source: 'static',
    confidence: 1,
  };
}

/**
 * 解析 gcc / g++ / javac 的诊断输出
 * @param {string} stderr 编译器输出
 * @param {string[]} lines 源码行（用于 snippet）
 * @param {string} toolName 工具名（用于 reference）
 * @returns {object[]} 问题列表
 */
function parseDiagnostics(stderr, lines, toolName) {
  const issues = [];
  const seen = new Set();
  const text = String(stderr ?? '');

  // gcc/g++:   main.c:4:5: error: expected ';' before '}'
  // javac:     Main.java:4: error: ';' expected（中文系统输出「错误:」）
  const patterns = [
    /^(?:[A-Za-z]:)?[^\r\n:]*?:(\d+):(\d+):\s*(?:error|错误)\s*:\s*(.+)$/gm,
    /^(?:[A-Za-z]:)?[^\r\n:]*?:(\d+):\s*(?:error|错误)\s*:\s*(.+)$/gm,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (issues.length >= MAX_DIAGNOSTICS) break;
      const line = Number(match[1]);
      const hasColumn = match.length === 4;
      const column = hasColumn ? Number(match[2]) : 1;
      const message = (hasColumn ? match[3] : match[2]).trim();
      const key = `${line}:${message.slice(0, 40)}`;
      if (!Number.isFinite(line) || line < 1 || seen.has(key)) continue;
      seen.add(key);
      issues.push(
        compilerIssue({
          line,
          column,
          index: issues.length,
          title: /expected|expected symbol|缺少|应为/i.test(message) ? '缺少符号 / 语法结构错误' : '编译错误',
          message: `${toolName} 报错：${message}`,
          suggestion: suggestionFor(message),
          snippet: (lines[line - 1] || '').trim().slice(0, 120),
          reference: `${toolName} 诊断`,
        }),
      );
    }
  }
  return issues;
}

/**
 * 按编译器报错内容给出可执行的修改建议
 * @param {string} message 编译器报错
 * @returns {string} 修改建议
 */
function suggestionFor(message) {
  const text = String(message);
  if (/undeclared|not declared|未声明/i.test(text)) {
    return '该标识符未声明：检查是否拼写错误（如 reut → return、变量名打错），或在使用前先声明。';
  }
  if (/expected/i.test(text) && /';'/.test(text)) {
    return '缺少分号「;」：在上一条语句末尾补上分号。';
  }
  if (/expected/i.test(text)) {
    return '语法结构不完整：按编译器提示补上缺少的符号（分号、括号、冒号等）。';
  }
  if (/return type|must return/i.test(text)) {
    return '函数返回类型问题：确认声明与 return 语句一致（如 int main 应 return 0;）。';
  }
  return '按编译器提示逐条修正后重新检查；报错行即问题所在行。';
}

/**
 * 解析 Python py_compile 的报错
 * @param {string} stderr 输出
 * @param {string[]} lines 源码行
 * @returns {object[]} 问题列表
 */
function parsePythonDiagnostics(stderr, lines) {
  const text = String(stderr ?? '');
  const lineMatch = /File "[^"]+", line (\d+)/.exec(text);
  const messageMatch = /(?:SyntaxError|IndentationError|TabError):\s*(.+)/.exec(text) || /(?:语法错误|缩进错误)[:：]\s*(.+)/.exec(text);
  if (!lineMatch) return [];
  const line = Number(lineMatch[1]);
  const message = messageMatch ? messageMatch[1].trim() : 'Python 语法错误';
  return [
    compilerIssue({
      line,
      index: 0,
      title: /indent|tab/i.test(message) ? '缩进错误' : 'Python 语法错误',
      message: `Python 解析报错：${message}`,
      suggestion: /indent|tab/i.test(message)
        ? '统一使用空格缩进（推荐 4 个空格），不要混用 Tab 与空格。'
        : /expected/i.test(message)
          ? '按提示补上缺少的符号（冒号、括号、引号等）。'
          : '对照报错行修正语法后重新检查。',
      snippet: (lines[line - 1] || '').trim().slice(0, 120),
      reference: 'Python 解析器诊断',
    }),
  ];
}

/**
 * 对一段代码做真编译器语法检查
 * @param {object} input 输入
 * @param {string} input.code 源码
 * @param {string} input.language 语言键
 * @param {string} [input.fileName] 文件名（用于 snippet 与临时文件命名）
 * @returns {{issues:object[], checkedBy:object}} 检查结果
 */
function compileCheck({ code, language, fileName } = {}) {
  const source = String(code ?? '');
  const lines = source.split('\n');
  const lang = String(language || '').toLowerCase();
  const issues = [];
  const checkedBy = { realCompiler: false, tool: null };

  if (!source.trim() || source.length > 200000) return { issues, checkedBy };

  const tools = RunService.detect();
  const tempDir = path.join(os.tmpdir(), `codeguard-compile-${crypto.randomBytes(5).toString('hex')}`);

  try {
    fs.mkdirSync(tempDir, { recursive: true });

    /** 同步执行编译器并解析诊断 */
    const runTool = (cmd, args, opts = {}) => {
      const result = spawnSync(cmd, args, {
        cwd: tempDir,
        encoding: 'utf8',
        timeout: COMPILE_TIMEOUT_MS,
        windowsHide: true,
        ...opts,
      });
      return `${result.stdout || ''}${result.stderr || ''}`;
    };

    if (lang === 'c' && tools.c) {
      fs.writeFileSync(path.join(tempDir, 'main.c'), source, 'utf8');
      const output = runTool(tools.c.cmd, [...tools.c.args, '-fsyntax-only', '-std=c17', 'main.c']);
      checkedBy.realCompiler = true;
      checkedBy.tool = 'gcc';
      issues.push(...parseDiagnostics(output, lines, 'gcc'));
    } else if (lang === 'cpp' && tools.cpp) {
      fs.writeFileSync(path.join(tempDir, 'main.cpp'), source, 'utf8');
      const output = runTool(tools.cpp.cmd, [...tools.cpp.args, '-fsyntax-only', '-std=c++17', 'main.cpp']);
      checkedBy.realCompiler = true;
      checkedBy.tool = 'g++';
      issues.push(...parseDiagnostics(output, lines, 'g++'));
    } else if (lang === 'java' && tools.java) {
      const classMatch = /public\s+(?:final\s+|abstract\s+)?class\s+(\w+)/.exec(source) || /\bclass\s+(\w+)/.exec(source);
      const className = classMatch ? classMatch[1] : 'Main';
      fs.writeFileSync(path.join(tempDir, `${className}.java`), source, 'utf8');
      // -J-Duser.language=en：强制 javac 输出英文诊断（中文 Windows 的 GBK 输出无法可靠解析）
      const output = runTool(tools.java.javacArgs[0], [
        ...tools.java.javacArgs.slice(1),
        '-J-Duser.language=en', '-J-Duser.country=US',
        '-encoding', 'UTF-8', '-d', tempDir, `${className}.java`,
      ]);
      checkedBy.realCompiler = true;
      checkedBy.tool = 'javac';
      issues.push(...parseDiagnostics(output, lines, 'javac'));
    } else if (lang === 'python' && tools.python) {
      fs.writeFileSync(path.join(tempDir, '__check__.py'), source, 'utf8');
      const output = runTool(tools.python.cmd, [...tools.python.args, '-m', 'py_compile', '__check__.py']);
      checkedBy.realCompiler = true;
      checkedBy.tool = 'python';
      issues.push(...parsePythonDiagnostics(output, lines));
    }

    // fileName 信息回填到 snippet 上下文（保持问题对象可读）
    for (const issue of issues) {
      if (fileName) issue.reference = `${issue.reference}（${fileName}）`;
    }
    return { issues, checkedBy };
  } catch {
    // 任何异常都静默降级：返回空结果，由启发式检查兜底
    return { issues, checkedBy: { realCompiler: false, tool: null } };
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch { /* 清理失败不影响结果 */ }
  }
}

module.exports = { compileCheck };
