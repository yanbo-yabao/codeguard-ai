'use strict';

/**
 * 代码运行服务（RunService）
 * ---------------------------------------------------------------------------
 * 在服务端真实执行用户代码（独立子进程 + 超时熔断），支撑三大能力：
 *   run   单次执行：喂入标准输入，返回标准输出 / 报错 / 耗时
 *   judge 自动判题：对多组测试用例逐一执行（编译型语言只编译一次），比对输出
 *   debug 调试跟踪：逐行记录实际执行顺序与变量快照
 *
 * 语言与执行方式：
 *   javascript  Node 直接执行（调试：行探针 + 变量快照）
 *   python      Python 解释执行（调试：sys.settrace + 变量快照）
 *   c / cpp     gcc/g++ 编译后执行（调试：行探针执行轨迹，编译型语言无变量快照）
 *   java        javac 编译后执行（调试：行探针执行轨迹，编译型语言无变量快照）
 *
 * 工具链探测（不修改系统 PATH）：环境变量覆盖 → PATH → 本机已知安装位置。
 *
 * 安全边界：
 *   - 每次执行都是独立子进程，超时强杀，不影响主服务
 *   - 跟踪数据走独立临时文件（环境变量指定路径），不污染用户的标准输出
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/** 可运行语言清单 */
const RUNNABLE = ['javascript', 'python', 'c', 'cpp', 'java'];

/** 项目根目录（用于探测便携工具链） */
const REPO_ROOT = path.join(__dirname, '..', '..');

/**
 * 便携工具链候选位置（绝对路径，按顺序探测）
 * ---------------------------------------------------------------------------
 * 部署给他人时，把工具链文件夹拷进项目 tools\ 目录即可被自动探测到（免安装）：
 *   tools\w64devkit\bin\gcc.exe / g++.exe   （w64devkit 解压后的整个文件夹）
 *   tools\jdk\bin\javac.exe / java.exe      （JDK 解压后改名为 jdk）
 */
const PORTABLE_TOOL_PATHS = {
  c: [
    path.join(REPO_ROOT, 'tools', 'w64devkit', 'bin', 'gcc.exe'),
    path.join(REPO_ROOT, 'tools', 'mingw64', 'bin', 'gcc.exe'),
    path.join(REPO_ROOT, 'tools', 'gcc', 'bin', 'gcc.exe'),
  ],
  cpp: [
    path.join(REPO_ROOT, 'tools', 'w64devkit', 'bin', 'g++.exe'),
    path.join(REPO_ROOT, 'tools', 'mingw64', 'bin', 'g++.exe'),
    path.join(REPO_ROOT, 'tools', 'gcc', 'bin', 'g++.exe'),
  ],
  java: [
    path.join(REPO_ROOT, 'tools', 'jdk', 'bin'),
    path.join(REPO_ROOT, 'tools', 'jdk-21', 'bin'),
    path.join(REPO_ROOT, 'tools', 'java', 'bin'),
  ],
};

/** 默认单次执行超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 5000;
/** 单次执行超时上限 */
const MAX_TIMEOUT_MS = 30000;
/** 编译超时（毫秒） */
const COMPILE_TIMEOUT_MS = 30000;
/** 单次判题的测试用例数量上限 */
const MAX_TEST_CASES = 20;
/** 输出截断长度（防止爆内存） */
const MAX_OUTPUT_CHARS = 64 * 1024;

/**
 * 归一化输出用于判题比对：统一换行符、去掉行尾空白与末尾空行（保留行首空白）
 * @param {string} text 输出文本
 * @returns {string} 归一化后的文本
 */
function normalizeOutput(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
}

/**
 * 从报错文本中提取行号（JS / Python / gcc / javac 的常见格式）
 * @param {string} text stderr 文本
 * @returns {number|null} 行号
 */
function parseErrorLine(text) {
  const patterns = [
    /evalmachine[^:]*:(\d+)/, // vm
    /[\w./\\-]+\.(?:js|mjs|cjs):(\d+)/, // node 文件栈
    /[\w./\\-]+\.(?:c|cpp|cc|cxx|java):(\d+)/, // gcc / javac 诊断
    /File "[^"]+", line (\d+)/, // Python
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(String(text ?? ''));
    if (match) return Number(match[1]);
  }
  return null;
}

/**
 * 提取 JS 代码中声明的变量 / 函数名（用于调试探针的变量快照）
 * @param {string} code 源码
 * @returns {string[]} 名称列表
 */
function extractVarNames(code) {
  const names = new Set();
  const pattern = /\b(?:let|const|var|function)\s+([A-Za-z_$][\w$]*)/g;
  let match = pattern.exec(code);
  while (match) {
    names.add(match[1]);
    match = pattern.exec(code);
  }
  ['__cg_dbg__', '__cg_fmt__', '__cg_trace__'].forEach((item) => names.delete(item));
  return [...names].slice(0, 40);
}

/** 各语言「不插探针」的行首模式（声明 / 注释 / 纯闭合 / 预处理） */
const PROBE_SKIP = {
  _common: /^(?:[}.)\]]|else\b|catch\b|case\b|default\b|try\b|finally\b|\/\/|\/\*|\*|[+\-*/,.?:&|@#]|<)/,
  javascript: /^$/,
  c: /^(?:#|typedef\b|struct\b|enum\b|union\b|extern\b|static\s+.*\(|void\s+\w+\s*\(|[\w*]+\s+[\w*]+\s*\(.*\)\s*(?:;|\{)?$)/,
  cpp: /^(?:#|using\b|typedef\b|struct\b|class\b|enum\b|namespace\b|template\b|public:|private:|protected:|[\w:<>~*&]+\s+[\w:~]+\s*\(.*\)\s*(?:const\s*)?(?:;|\{)?$)/,
  java: /^(?:import\b|package\b|@|public\b|private\b|protected\b|static\s+(?:final\s+)?[\w<>\[\]]+\s+\w+\s*[=(]|class\b|interface\b|enum\b|record\b|[\w<>\[\]]+\s+\w+\s*\(.*\)\s*(?:throws\b[\w,\s]+)?\s*\{?\s*$)/,
};

/**
 * 通用行探针插桩：为每个可执行行插入一次 trace 调用
 * @param {string} code 源码
 * @param {string} language 语言
 * @param {(line:number)=>string} probe 生成探针语句（含分号）
 * @returns {string} 插桩后的代码
 */
function instrumentLines(code, language, probe) {
  const skip = PROBE_SKIP[language] || PROBE_SKIP._common;
  const lines = String(code ?? '').split('\n');
  return lines.map((rawLine, index) => {
    const trimmed = rawLine.trim();
    const isCode = trimmed !== ''
      && !trimmed.startsWith('//')
      && !PROBE_SKIP._common.test(trimmed)
      && !skip.test(trimmed);
    if (!isCode) return rawLine;
    const indent = rawLine.slice(0, rawLine.length - rawLine.trimStart().length);
    return `${indent}${probe(index + 1)} ${rawLine.trim()}`;
  }).join('\n');
}

/**
 * 为 JS 代码插入逐行调试探针（含变量快照）
 * @param {string} code 源码
 * @returns {{code:string, varNames:string[]}} 插桩结果
 */
function instrumentJs(code) {
  const varNames = extractVarNames(code);
  const varBlock = varNames
    .map((name) => `try { __v[${JSON.stringify(name)}] = __cg_fmt__(${name}); } catch {}`)
    .join(' ');
  return {
    code: instrumentLines(code, 'javascript', (n) =>
      `__cg_dbg__(${n}, () => { const __v = {}; ${varBlock} return __v; });`),
    varNames,
  };
}

/** JS 插桩前置代码：定义探针、格式化与跟踪落盘 */
const JS_PROLOGUE = `'use strict';
const __cg_fs__ = require('fs');
globalThis.__cg_trace__ = [];
globalThis.__cg_fmt__ = (v) => {
  try {
    if (v === null) return 'null';
    const t = typeof v;
    if (t === 'string') return v.length > 200 ? v.slice(0, 200) + '\\u2026' : v;
    if (t === 'number' || t === 'boolean' || t === 'undefined' || t === 'bigint') return String(v);
    if (t === 'function') return '\\u0192 ' + (v.name || 'anonymous');
    const s = JSON.stringify(v);
    return s && s.length > 300 ? s.slice(0, 300) + '\\u2026' : (s || String(v));
  } catch { return '[unserializable]'; }
};
globalThis.__cg_dbg__ = (line, fn) => {
  let vars = {};
  try { vars = fn(); } catch { vars = {}; }
  globalThis.__cg_trace__.push({ line, vars });
};
process.on('exit', () => {
  try {
    if (process.env.CODEGUARD_TRACE) {
      __cg_fs__.writeFileSync(process.env.CODEGUARD_TRACE, JSON.stringify(globalThis.__cg_trace__));
    }
  } catch {}
});
`;

/** Python 调试包装器：sys.settrace 逐行跟踪 + 变量快照 */
const PY_TRACE_WRAPPER = `import sys, json, os

__cg_trace__ = []

def __cg_fmt__(v):
    try:
        s = repr(v)
        return s if len(s) <= 300 else s[:300] + '\\u2026'
    except Exception:
        return '[unserializable]'

def __cg_tracer__(frame, event, arg):
    if event == 'line' and frame.f_code.co_filename == '__cg_main__.py':
        vars = {}
        for k, v in list(frame.f_locals.items())[:40]:
            if k.startswith('__') and k.endswith('__'):
                continue
            vars[k] = __cg_fmt__(v)
        __cg_trace__.append({'line': frame.f_lineno, 'vars': vars})
    return __cg_tracer__

__cg_target__ = sys.argv[1]
sys.argv = sys.argv[1:]
with open(__cg_target__, 'r', encoding='utf-8') as f:
    __cg_code__ = f.read()
sys.settrace(__cg_tracer__)
try:
    exec(compile(__cg_code__, '__cg_main__.py', 'exec'), {'__name__': '__main__'})
finally:
    sys.settrace(None)
    with open(os.environ['CODEGUARD_TRACE'], 'w', encoding='utf-8') as f:
        json.dump(__cg_trace__, f, ensure_ascii=False)
`;

/** C/C++ 调试跟踪运行时（与用户代码一起编译） */
const C_TRACE_RUNTIME = `#include <stdio.h>
#include <stdlib.h>
void __cg_trace(int line) {
    static FILE *f = 0;
    if (!f) {
        const char *p = getenv("CODEGUARD_TRACE");
        if (!p) return;
        f = fopen(p, "w");
        if (!f) return;
    }
    fprintf(f, "%d\\n", line);
    fflush(f);
}
`;

/** Java 调试跟踪运行时（追加到用户文件末尾） */
const JAVA_TRACE_HELPER = `
class __CgTrace {
    static java.io.BufferedWriter w;
    static synchronized void n(int line) {
        try {
            if (w == null) {
                String p = System.getenv("CODEGUARD_TRACE");
                if (p == null) return;
                w = java.nio.file.Files.newBufferedWriter(java.nio.file.Paths.get(p));
                Runtime.getRuntime().addShutdownHook(new Thread(() -> { try { if (w != null) w.close(); } catch (Exception e) {} }));
            }
            w.write(line + "\\n");
            w.flush();
        } catch (Exception e) {}
    }
}
`;

/**
 * 创建临时执行目录
 * @returns {{dir:string, cleanup:function}} 目录与清理函数
 */
function makeTempDir() {
  const dir = path.join(os.tmpdir(), `codeguard-run-${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch { /* 清理失败不影响主流程 */ }
    },
  };
}

/**
 * 同步探测命令是否可用（执行给定参数，退出码 0 视为可用）
 * @param {string} cmd 命令
 * @param {string[]} [args] 参数
 * @returns {boolean} 是否可用
 */
function probeCommand(cmd, args = []) {
  if (!cmd) return false;
  try {
    const probe = spawnSync(cmd, args, { timeout: 5000, encoding: 'utf8', windowsHide: true });
    return probe.status === 0;
  } catch {
    return false;
  }
}

/**
 * 解析编译型语言的报错首行
 * @param {string} stderr 编译输出
 * @param {string} fallback 兜底文案
 * @returns {{message:string, line:number|null}} 错误信息
 */
function compileErrorOf(stderr, fallback) {
  const lines = String(stderr ?? '').split('\n').map((item) => item.trim()).filter(Boolean);
  const errorLine = lines.find((item) => /error|错误/i.test(item)) || lines[0] || fallback;
  return { message: errorLine.slice(0, 500), line: parseErrorLine(stderr) };
}

/**
 * 准备一次执行（编译 / 写文件），返回可多次启动的执行器
 * ---------------------------------------------------------------------------
 * 编译型语言在此完成编译（判题时只编译一次）；解释型语言只写好文件。
 * @param {object} options 选项
 * @param {string} options.language 语言
 * @param {string} options.code 源码
 * @param {boolean} [options.trace] 是否插桩跟踪
 * @param {object} options.tools 工具链探测结果
 * @returns {{exec:function, dispose:function, compileError:object|null, tracePath:string|null}} 执行器
 */
function prepareExecution({ language, code, trace = false, tools }) {
  const temp = makeTempDir();
  const tracePath = trace ? path.join(temp.dir, 'trace.json') : null;
  const env = { ...process.env, ...(tracePath ? { CODEGUARD_TRACE: tracePath } : {}) };

  /** 同步编译并返回错误（成功返回 null） */
  const compile = (args) => {
    const result = spawnSync(args[0], args.slice(1), {
      cwd: temp.dir,
      encoding: 'utf8',
      timeout: COMPILE_TIMEOUT_MS,
      windowsHide: true,
    });
    if (result.status !== 0) {
      return compileErrorOf(`${result.stdout || ''}${result.stderr || ''}`, '编译失败');
    }
    return null;
  };

  let command = null;
  let commandArgs = [];
  let compileError = null;

  if (language === 'javascript') {
    let source = code;
    if (trace) {
      const instrumented = instrumentJs(code);
      try {
        // eslint-disable-next-line no-new
        new (require('vm').Script)(instrumented.code);
        source = `${JS_PROLOGUE}\n${instrumented.code}\n`;
      } catch {
        source = code; // 插桩结果语法不成立时回退到无跟踪执行
      }
    }
    fs.writeFileSync(path.join(temp.dir, 'main.js'), source, 'utf8');
    command = process.execPath;
    commandArgs = [path.join(temp.dir, 'main.js')];
  } else if (language === 'python') {
    const tool = tools.python;
    if (!tool) {
      compileError = { message: '未检测到 Python 运行环境。请安装 Python 3，或设置环境变量 PYTHON_BIN 指向解释器路径。', line: null };
    } else {
      fs.writeFileSync(path.join(temp.dir, '__cg_main__.py'), code, 'utf8');
      if (trace) {
        fs.writeFileSync(path.join(temp.dir, '__cg_trace__.py'), PY_TRACE_WRAPPER, 'utf8');
        command = tool.cmd;
        commandArgs = [...tool.args, path.join(temp.dir, '__cg_trace__.py'), path.join(temp.dir, '__cg_main__.py')];
      } else {
        command = tool.cmd;
        commandArgs = [...tool.args, path.join(temp.dir, '__cg_main__.py')];
      }
    }
  } else if (language === 'c' || language === 'cpp') {
    const tool = language === 'c' ? tools.c : tools.cpp;
    if (!tool) {
      compileError = {
        message: `未检测到 ${language === 'c' ? 'C' : 'C++'} 编译器（gcc/g++）。已探测 PATH 与常见安装位置。`,
        line: null,
      };
    } else {
      const isCpp = language === 'cpp';
      const srcName = isCpp ? 'main.cpp' : 'main.c';
      const exeName = 'main.exe';
      if (trace) {
        fs.writeFileSync(path.join(temp.dir, isCpp ? 'runtime.cpp' : 'runtime.c'), C_TRACE_RUNTIME, 'utf8');
        const instrumented = instrumentLines(code, language, (n) => `__cg_trace(${n});`);
        fs.writeFileSync(path.join(temp.dir, srcName), `void __cg_trace(int);\n${instrumented}\n`, 'utf8');
      } else {
        fs.writeFileSync(path.join(temp.dir, srcName), code, 'utf8');
      }
      const compileArgs = trace
        ? [tool.cmd, ...tool.args, '-O2', `-std=${isCpp ? 'c++17' : 'c17'}`, srcName, isCpp ? 'runtime.cpp' : 'runtime.c', '-o', exeName]
        : [tool.cmd, ...tool.args, '-O2', `-std=${isCpp ? 'c++17' : 'c17'}`, srcName, '-o', exeName];
      compileError = compile(compileArgs);
      if (!compileError) {
        command = path.join(temp.dir, exeName);
        commandArgs = [];
      }
    }
  } else if (language === 'java') {
    const tool = tools.java;
    if (!tool) {
      compileError = { message: '未检测到 Java 运行环境（javac/java）。已探测 PATH 与常见安装位置。', line: null };
    } else {
      const classMatch = /public\s+(?:final\s+|abstract\s+)?class\s+(\w+)/.exec(code) || /\bclass\s+(\w+)/.exec(code);
      const className = classMatch ? classMatch[1] : 'Main';
      if (trace) {
        // 插桩 + 追加跟踪辅助类；编译失败则回退到无跟踪执行
        const instrumented = instrumentLines(code, 'java', (n) => `__CgTrace.n(${n});`);
        fs.writeFileSync(path.join(temp.dir, `${className}.java`), `${instrumented}\n${JAVA_TRACE_HELPER}`, 'utf8');
        compileError = compile([...tool.javacArgs, '-encoding', 'UTF-8', `${className}.java`]);
        if (compileError) {
          fs.writeFileSync(path.join(temp.dir, `${className}.java`), code, 'utf8');
          compileError = compile([...tool.javacArgs, '-encoding', 'UTF-8', `${className}.java`]);
        }
      } else {
        fs.writeFileSync(path.join(temp.dir, `${className}.java`), code, 'utf8');
        compileError = compile([...tool.javacArgs, '-encoding', 'UTF-8', `${className}.java`]);
      }
      if (!compileError) {
        command = tool.javaCmd;
        commandArgs = [...tool.javaArgs, '-cp', temp.dir, className];
      }
    }
  }

  /**
   * 执行一次（可重复调用，如判题多用例）
   * @param {object} runOptions {stdin, timeoutMs}
   * @returns {Promise<object>} 执行结果（不含语言/耗时之外的元信息）
   */
  const exec = ({ stdin = '', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) => new Promise((resolve) => {
    if (compileError) {
      resolve({
        ok: false,
        stdout: '',
        stderr: compileError.message,
        exitCode: null,
        timedOut: false,
        error: compileError,
        trace: [],
      });
      return;
    }
    const timeout = Math.min(Math.max(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 200), MAX_TIMEOUT_MS);
    const startedAt = Date.now();
    let timedOut = false;
    const timeoutTimer = setTimeout(() => { timedOut = true; }, timeout);
    let child;
    try {
      child = spawn(command, commandArgs, { cwd: temp.dir, env, timeout, windowsHide: true });
    } catch (error) {
      clearTimeout(timeoutTimer);
      resolve({ ok: false, stdout: '', stderr: error.message, exitCode: null, timedOut: false, error: { message: error.message, line: null }, trace: [] });
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timeoutTimer);
      resolve({ ok: false, stdout, stderr: error.message, exitCode: null, timedOut, error: { message: error.message, line: null }, trace: [], durationMs: Date.now() - startedAt });
    });
    child.on('close', (exitCode) => {
      clearTimeout(timeoutTimer);
      if (timedOut) stderr += `\n执行超时（超过 ${timeout}ms），进程已被强制终止`;
      let traceData = [];
      if (tracePath) {
        try {
          const raw = fs.readFileSync(tracePath, 'utf8');
          // JS/Python 输出 {line,vars} 对象数组（JSON）；C/C++/Java 输出每行一个行号
          let parsed;
          try {
            const json = JSON.parse(raw);
            parsed = Array.isArray(json) ? json : null;
          } catch {
            parsed = null;
          }
          if (!parsed) {
            parsed = raw.split('\n').map((item) => Number(item.trim())).filter((item) => Number.isFinite(item));
          }
          traceData = parsed.map((item) => (typeof item === 'number' ? { line: item, vars: {} } : item));
        } catch { traceData = []; }
      }
      const ok = exitCode === 0 && !timedOut;
      const stderrLines = stderr.split('\n').map((item) => item.trim()).filter(Boolean);
      const errorLine = stderrLines.find((item) => /Error|error|错误|Exception/.test(item)) || stderrLines[0] || `进程退出码 ${exitCode}`;
      resolve({
        ok,
        stdout: stdout.slice(0, MAX_OUTPUT_CHARS),
        stderr: stderr.slice(0, MAX_OUTPUT_CHARS),
        exitCode,
        timedOut,
        error: ok ? null : {
          message: errorLine.slice(0, 500),
          line: parseErrorLine(stderr),
        },
        trace: traceData,
        durationMs: Date.now() - startedAt,
      });
    });

    child.stdin.write(String(stdin ?? ''));
    child.stdin.end();
  });

  return { exec, dispose: temp.cleanup, compileError, tracePath };
}

/**
 * 兼容旧接口的单次执行（测试与 CLI 复用）
 * @param {object} options {language, code, stdin, timeoutMs, trace, tools}
 * @returns {Promise<object>} 执行结果
 */
async function execCode({ language, code, stdin = '', timeoutMs = DEFAULT_TIMEOUT_MS, trace = false, tools }) {
  const resolvedTools = tools || RunService.detect();
  if (!RUNNABLE.includes(language)) {
    return {
      ok: false,
      stdout: '',
      stderr: `暂不支持运行该语言：${language}（当前支持 JavaScript / Python / C / C++ / Java）`,
      exitCode: null,
      timedOut: false,
      error: { message: `暂不支持运行该语言：${language}`, line: null },
      trace: [],
      language,
      durationMs: 0,
    };
  }
  const execution = prepareExecution({ language, code, trace, tools: resolvedTools });
  try {
    const result = await execution.exec({ stdin, timeoutMs });
    return { ...result, language };
  } finally {
    execution.dispose();
  }
}

/**
 * 代码运行服务
 */
class RunService {
  /**
   * 探测全部工具链（结果缓存；可用环境变量覆盖：PYTHON_BIN / CC / CXX / JAVAC / JAVA）
   * @returns {object} 工具链映射
   */
  static detect() {
    if (RunService._tools) return RunService._tools;

    /** 找一个可用命令：依次尝试候选（含已知安装位置），第一个探测通过的胜出 */
    const find = (candidates, probeArgs = ['--version']) => {
      for (const candidate of candidates) {
        const { cmd, args = [], known, probeArgs: customProbe } = candidate;
        const effectiveProbe = customProbe || probeArgs;
        for (const tryCmd of [known, cmd].filter(Boolean)) {
          if (probeCommand(tryCmd, [...args, ...effectiveProbe])) {
            return { cmd: tryCmd, args };
          }
        }
      }
      return null;
    };

    const tools = {
      javascript: { cmd: process.execPath, args: [] },
      python: find([
        { cmd: process.env.PYTHON_BIN || '', args: [], probeArgs: ['--version'] },
        { cmd: 'py', args: ['-3'], probeArgs: ['--version'] },
        { cmd: 'python3', args: [], probeArgs: ['--version'] },
        { cmd: 'python', args: [], probeArgs: ['--version'] },
      ]),
      c: find([
        ...(process.env.CC ? [{ cmd: process.env.CC }] : []),
        ...PORTABLE_TOOL_PATHS.c.map((item) => ({ cmd: item })),
        { cmd: 'gcc', known: 'D:\\w64devkit\\bin\\gcc.exe' },
      ]),
      cpp: find([
        ...(process.env.CXX ? [{ cmd: process.env.CXX }] : []),
        ...PORTABLE_TOOL_PATHS.cpp.map((item) => ({ cmd: item })),
        { cmd: 'g++', known: 'D:\\w64devkit\\bin\\g++.exe' },
      ]),
      java: null,
    };

    // Java 需要 javac + java 成对可用
    const portableJavaDirs = PORTABLE_TOOL_PATHS.java;
    const javacCandidates = [
      process.env.JAVAC || '',
      process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'javac.exe') : '',
      ...portableJavaDirs.map((dir) => path.join(dir, 'javac.exe')),
      'D:\\jdk-21\\bin\\javac.exe',
      'D:\\jdk\\bin\\javac.exe',
      'javac',
    ].filter(Boolean);
    const javaCandidates = [
      process.env.JAVA || '',
      process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'java.exe') : '',
      ...portableJavaDirs.map((dir) => path.join(dir, 'java.exe')),
      'D:\\jdk-21\\bin\\java.exe',
      'D:\\jdk\\bin\\java.exe',
      'java',
    ].filter(Boolean);
    for (const javacCmd of javacCandidates) {
      if (!probeCommand(javacCmd, ['-version'])) continue;
      for (const javaCmd of javaCandidates) {
        if (!probeCommand(javaCmd, ['-version'])) continue;
        tools.java = {
          cmd: javacCmd,
          args: [],
          javacArgs: [javacCmd],
          javaCmd,
          javaArgs: [],
        };
        break;
      }
      if (tools.java) break;
    }
    RunService._tools = tools;
    return tools;
  }

  /** @returns {object|null} 可用的 Python 解释器 */
  static findPython() {
    return RunService.detect().python || null;
  }

  /**
   * 对外可用性快照（供 /api/run/env 与 CLI doctor）
   * @returns {object} 各语言可用性
   */
  static availability() {
    const tools = RunService.detect();
    return {
      javascript: { available: true, detail: `Node ${process.version}` },
      python: { available: Boolean(tools.python), detail: tools.python ? `${tools.python.cmd} ${tools.python.args.join(' ')}`.trim() : '未检测到（可安装 Python 3 或设置 PYTHON_BIN）' },
      c: { available: Boolean(tools.c), detail: tools.c ? tools.c.cmd : '未检测到 gcc（可安装 MinGW，如 D:\\w64devkit）' },
      cpp: { available: Boolean(tools.cpp), detail: tools.cpp ? tools.cpp.cmd : '未检测到 g++（可安装 MinGW，如 D:\\w64devkit）' },
      java: { available: Boolean(tools.java), detail: tools.java ? tools.java.javaCmd : '未检测到 JDK（可安装 JDK 21，如 D:\\jdk-21）' },
    };
  }

  /**
   * 单次执行
   * @param {object} input {language, code, stdin, timeoutMs}
   * @returns {Promise<object>} 执行结果
   */
  run(input) {
    return execCode({ ...input, tools: RunService.detect() });
  }

  /**
   * 调试执行（逐行跟踪 + 变量快照）
   * @param {object} input {language, code, stdin, timeoutMs}
   * @returns {Promise<object>} 执行结果（含 trace）
   */
  debug(input) {
    return execCode({ ...input, trace: true, tools: RunService.detect() });
  }

  /**
   * 自动判题：编译一次，对多组测试用例逐一执行并比对输出
   * @param {object} input {language, code, testCases, timeoutMs}
   * @returns {Promise<object>} 判题结果
   */
  async judge({ language, code, testCases = [], timeoutMs }) {
    const cases = testCases.slice(0, MAX_TEST_CASES);
    const tools = RunService.detect();
    const execution = prepareExecution({ language, code, trace: false, tools });

    const results = [];
    let passed = 0;
    try {
      for (let index = 0; index < cases.length; index += 1) {
        const testCase = cases[index];
        const result = await execution.exec({ stdin: testCase.input ?? '', timeoutMs });
        const expected = normalizeOutput(testCase.expected);
        const actual = normalizeOutput(result.stdout);
        const ok = result.ok && actual === expected;
        if (ok) passed += 1;
        results.push({
          index: index + 1,
          input: testCase.input ?? '',
          expected: testCase.expected ?? '',
          actual: result.stdout,
          ok,
          stderr: result.stderr,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
        });
      }
    } finally {
      execution.dispose();
    }

    return {
      language,
      passed,
      total: cases.length,
      allPassed: cases.length > 0 && passed === cases.length,
      cases: results,
    };
  }
}

/** 供测试与复用导出的纯函数 */
const internals = {
  normalizeOutput,
  parseErrorLine,
  extractVarNames,
  instrumentJs,
  instrumentLines,
  execCode,
  prepareExecution,
};

module.exports = { RunService, RUNNABLE, DEFAULT_TIMEOUT_MS, PORTABLE_TOOL_PATHS, internals };
