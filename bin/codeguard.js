#!/usr/bin/env node
'use strict';

/**
 * CodeGuard AI 命令行入口
 * ---------------------------------------------------------------------------
 *   node bin/codeguard.js complete <文件|-> --prompt "..."   解题与代码补全
 *   node bin/codeguard.js fix <文件|-> [--prompt "..."]      错误检查与修复
 *   node bin/codeguard.js quiz --prompt "..."                变式出题（学习检验）
 *   node bin/codeguard.js run <文件> [--stdin 数据]          真实运行代码
 *   node bin/codeguard.js mcp                               以 MCP 服务器模式运行
 *   node bin/codeguard.js serve                             启动 Web 工作台
 *   node bin/codeguard.js doctor                            环境自检
 *   node bin/codeguard.js rules                             列出全部规则
 *   node bin/codeguard.js version                           版本信息
 *
 * 示例：
 *   node bin/codeguard.js complete sort.js --prompt "补充参数校验"
 *   node bin/codeguard.js complete - --prompt "实现快速排序" --language javascript
 *   node bin/codeguard.js fix broken.js --prompt "该函数应返回数组长度"
 *   node bin/codeguard.js quiz --prompt "两数之和" --language python
 *   node bin/codeguard.js run main.py --stdin "3 4"
 */

const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const { CompletionService } = require('../src/services/completion-service');
const { RunService } = require('../src/runners/runner-service');
const { describeRules, LANGUAGES } = require('../src/analyzers');

/* ==================== 基础工具 ==================== */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (text, color) => {
  const codes = { red: 31, green: 32, yellow: 33, blue: 34, gray: 90, cyan: 36 };
  return useColor ? `\u001b[${codes[color] || 0}m${text}\u001b[0m` : String(text);
};
const line = (text = '') => process.stdout.write(`${text}\n`);

const SEVERITY_LABELS = {
  blocker: '阻断', critical: '严重', major: '主要', minor: '次要', info: '建议',
};

/**
 * 解析命令行参数
 * @param {string[]} argv 原始参数
 * @returns {object} 解析结果
 */
function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args.flags[key] = true;
      } else {
        args.flags[key] = next;
        i += 1;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

/**
 * 读取目标代码（文件路径或标准输入 `-`）
 * @param {string} target 目标
 * @returns {string} 代码内容
 */
function readTarget(target) {
  if (!target || target === '-') {
    return fs.readFileSync(0, 'utf8');
  }
  const filePath = path.resolve(target);
  if (!fs.existsSync(filePath)) {
    line(paint(`找不到文件：${filePath}`, 'red'));
    process.exit(1);
  }
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) {
    line(paint('请指定具体文件（不再支持目录批量审查）', 'red'));
    process.exit(1);
  }
  return fs.readFileSync(filePath, 'utf8');
}

function printHelp() {
  line(`
CodeGuard AI · AI 编程学习助手  v${config.pkg.version}

用法：
  node bin/codeguard.js <命令> [参数]

命令：
  complete <文件|-> --prompt "问题或需求"   解题讲解 + 完整代码（可 --image 图片）
  fix <文件|-> [--prompt "期望行为"]        错误检查与修复（逐条修改方法 + 修复后代码）
  quiz --prompt "刚学的题目"                变式出题（生成测试用例与参考答案）
  run <文件> [--stdin "输入"] [--debug]     真实运行代码（--debug 逐行跟踪）
  mcp                                       以 MCP 服务器模式运行（供外部 AI 调用）
  serve [--port 8848]                       启动 Web 工作台
  doctor                                    环境自检
  rules [--dimension security] [--verbose]  列出规则
  version                                   版本信息

常用参数：
  --prompt "..."      问题 / 需求 / 期望行为描述
  --language <语言>   指定语言（javascript / python / java …）
  --file-name <名字>  文件名（用于自动识别语言）
  --image <图片路径>  图片提问（complete 专用，支持 png / jpeg / gif / webp）
  --no-llm            不调用大模型（仅静态检查 / 离线模板库）
  --stdin "..."       标准输入（run 专用）

示例：
  node bin/codeguard.js complete sort.js --prompt "补充参数校验"
  node bin/codeguard.js fix broken.js --prompt "该函数应返回数组长度"
  node bin/codeguard.js quiz --prompt "两数之和" --language python
  node bin/codeguard.js run main.py --stdin "3 4"
`);
}

/* ==================== 结果渲染 ==================== */

function printIssues(issues, title) {
  line('');
  line(paint(title, 'cyan'));
  if (!issues.length) {
    line('  （未发现问题）');
    return;
  }
  for (const issue of issues) {
    const label = SEVERITY_LABELS[issue.severity] || issue.severity;
    line(`  ${paint(`[${label}]`, issue.severity === 'blocker' || issue.severity === 'critical' ? 'red' : 'yellow')} 第 ${issue.line} 行  ${issue.title}${issue.confirmedBy ? paint('（双引擎印证）', 'green') : ''}`);
    if (issue.message) line(`      ${issue.message}`);
    if (issue.suggestion) line(`      ${paint('✔ 如何修改：', 'green')}${issue.suggestion}`);
  }
}

function printCode(code, title) {
  if (!code) return;
  line('');
  line(paint(title, 'cyan'));
  code.split('\n').forEach((text, index) => {
    line(`  ${paint(String(index + 1).padStart(4), 'gray')} | ${text}`);
  });
}

function printResultMeta(result) {
  line('');
  line(paint('执行信息', 'cyan'));
  line(`  语言：${result.language}    模式：${result.mode}`);
  line(`  来源：${result.completionSource}    耗时：${result.stats?.durationMs ?? 0} 毫秒`);
  if (result.summary?.text) {
    line('');
    line(paint('结论', 'cyan'));
    line(`  ${result.summary.text}`);
  }
  if (result.answer) {
    line('');
    line(paint('解题讲解', 'cyan'));
    result.answer.split('\n').forEach((text) => line(`  ${text}`));
  }
  for (const warning of result.warnings || []) {
    line(paint(`  ⚠ ${warning}`, 'yellow'));
  }
}

/* ==================== 命令实现 ==================== */

async function commandComplete(args) {
  const code = readTarget(args._[0]);
  const prompt = String(args.flags.prompt || '');
  if (!prompt && !args.flags.image) {
    line(paint('缺少 --prompt（问题或需求描述）', 'red'));
    process.exit(1);
  }
  let image;
  if (args.flags.image && args.flags.image !== true) {
    const imagePath = path.resolve(String(args.flags.image));
    const buffer = fs.readFileSync(imagePath);
    const ext = path.extname(imagePath).toLowerCase();
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[ext] || 'image/png';
    image = `data:${mime};base64,${buffer.toString('base64')}`;
    line(paint(`已附加图片：${imagePath}`, 'gray'));
  }

  const service = new CompletionService();
  const result = await service.complete({
    feature: 'complete',
    prompt,
    code,
    image,
    language: args.flags.language || undefined,
    fileName: args.flags['file-name'] || undefined,
    useLlm: args.flags['no-llm'] ? false : undefined,
  });

  printResultMeta(result);
  printIssues(result.issues || [], '补全结果自检');
  printCode(result.completedCode, '完整代码');
}

async function commandFix(args) {
  const code = readTarget(args._[0]);
  if (!code.trim()) {
    line(paint('没有读到任何代码', 'red'));
    process.exit(1);
  }
  const service = new CompletionService();
  const result = await service.complete({
    feature: 'fix',
    code,
    prompt: args.flags.prompt ? String(args.flags.prompt) : '',
    language: args.flags.language || undefined,
    fileName: args.flags['file-name'] || undefined,
    useLlm: args.flags['no-llm'] ? false : undefined,
  });

  printResultMeta(result);
  printIssues(result.issues || [], '问题与修改建议');
  printCode(result.fixedCode, '修复后的完整代码');
}

async function commandQuiz(args) {
  const prompt = String(args.flags.prompt || args._.join(' ') || '');
  if (!prompt) {
    line(paint('缺少 --prompt（刚学过的题目或知识点）', 'red'));
    process.exit(1);
  }
  const service = new CompletionService();
  const result = await service.complete({
    feature: 'quiz',
    prompt,
    language: args.flags.language || undefined,
    useLlm: args.flags['no-llm'] ? false : undefined,
  });

  if (!result.quiz) {
    line(paint(`未生成变式题：${result.warnings[0] || '需要配置大模型'}`, 'yellow'));
    return;
  }
  const { quiz } = result;
  line('');
  line(paint(`变式题：${quiz.title}`, 'cyan'));
  line('');
  quiz.description.split('\n').forEach((text) => line(`  ${text}`));
  line('');
  line(paint('测试用例', 'cyan'));
  quiz.testCases.forEach((item, index) => {
    line(`  #${index + 1}  输入：${JSON.stringify(item.input)}  期望输出：${JSON.stringify(item.expected)}`);
  });
  printCode(quiz.starterCode, '起始代码骨架');
  for (const warning of result.warnings || []) line(paint(`  ⚠ ${warning}`, 'yellow'));
  line('');
  line(paint('提示：把代码写进文件后，用 run 命令真实执行：node bin/codeguard.js run your.js --stdin "输入"', 'gray'));
}

async function commandRun(args) {
  const code = readTarget(args._[0]);
  const service = new RunService();
  const input = {
    language: args.flags.language ? String(args.flags.language) : undefined,
    code,
    stdin: args.flags.stdin ? String(args.flags.stdin) : '',
    timeoutMs: args.flags.timeout ? Number(args.flags.timeout) : undefined,
  };
  if (!input.language) {
    // 按文件扩展名推断
    const ext = path.extname(String(args._[0] || '')).toLowerCase();
    const extMap = { '.py': 'python', '.c': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.java': 'java' };
    input.language = extMap[ext] || 'javascript';
  }

  const result = args.flags.debug ? await service.debug(input) : await service.run(input);

  line('');
  line(paint(`运行结果：${result.ok ? '成功' : '失败'}（耗时 ${result.durationMs} 毫秒，退出码 ${result.exitCode}）`, result.ok ? 'green' : 'red'));
  if (result.stdout) {
    line('');
    line(paint('标准输出', 'cyan'));
    result.stdout.split('\n').forEach((text) => line(`  ${text}`));
  }
  if (result.error) {
    line('');
    line(paint('错误信息', 'red'));
    line(`  ${result.error.message}${result.error.line ? `（第 ${result.error.line} 行）` : ''}`);
  }
  if (args.flags.debug && result.trace && result.trace.length) {
    line('');
    line(paint(`调试轨迹（${result.trace.length} 步）`, 'cyan'));
    for (const step of result.trace.slice(0, 100)) {
      const vars = Object.entries(step.vars || {}).map(([k, v]) => `${k}=${v}`).join('  ');
      line(`  第 ${String(step.line).padStart(3)} 行  ${vars}`);
    }
    if (result.trace.length > 100) line(`  … 其余 ${result.trace.length - 100} 步已省略`);
  }
}

function commandRules(args) {
  const data = describeRules();
  const dimension = args.flags.dimension;
  const rules = dimension ? data.rules.filter((rule) => rule.dimension === dimension) : data.rules;
  line(`共 ${rules.length} 条规则`);
  for (const rule of rules) {
    line(`  ${paint(rule.id.padEnd(10), 'cyan')} ${rule.title}（${rule.dimension}）`);
    if (args.flags.verbose && rule.description) line(`      ${rule.description}`);
    if (args.flags.verbose && rule.suggestion) line(`      ${paint('✔ ', 'green')}${rule.suggestion}`);
  }
  line('');
  line('语言清单：' + Object.values(LANGUAGES).map((item) => item.key).join(' / '));
}

function commandDoctor() {
  line(paint('CodeGuard AI 环境自检', 'cyan'));
  const selfCheck = config.selfCheck();
  for (const check of selfCheck.checks) {
    line(`  ${check.ok ? paint('✓', 'green') : paint('✗', 'red')} ${check.name}${check.detail ? `：${check.detail}` : ''}`);
  }
  const labels = { javascript: 'JavaScript 运行', python: 'Python 运行', c: 'C 编译器', cpp: 'C++ 编译器', java: 'Java 运行' };
  for (const [key, item] of Object.entries(RunService.availability())) {
    line(`  ${item.available ? paint('✓', 'green') : paint('✗', 'red')} ${labels[key]}${item.available ? `：${item.detail}` : `：${item.detail}`}`);
  }
  line(`  ${paint('✓', 'green')} Node ${process.version}`);
  line('');
  line(selfCheck.ok ? paint('自检通过', 'green') : paint('部分能力不可用（不影响其他功能）', 'yellow'));
}

function commandServe(args) {
  const { start } = require('../src/server');
  const options = {};
  if (args.flags.port) options.port = Number(args.flags.port);
  start(options).catch((error) => {
    line(paint(`启动失败：${error.message}`, 'red'));
    process.exit(1);
  });
}

function commandMcp() {
  const { runStdio } = require('../src/mcp/server');
  runStdio();
}

/* ==================== 入口 ==================== */

async function main() {
  const [command = 'help', ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  switch (command) {
    case 'complete': await commandComplete(args); break;
    case 'fix': await commandFix(args); break;
    case 'quiz': await commandQuiz(args); break;
    case 'run': await commandRun(args); break;
    case 'rules': commandRules(args); break;
    case 'doctor': commandDoctor(); break;
    case 'serve': commandServe(args); break;
    case 'mcp': commandMcp(); break;
    case 'version':
    case '-v':
    case '--version':
      line(`${config.pkg.name} v${config.pkg.version}`);
      break;
    case 'help':
    case '-h':
    case '--help':
      printHelp();
      break;
    default:
      line(paint(`未知命令：${command}`, 'red'));
      printHelp();
      process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    line(paint(`执行失败：${error.message}`, 'red'));
    if (process.env.DEBUG) line(error.stack);
    process.exit(1);
  });
}

module.exports = { parseArgs, readTarget };
