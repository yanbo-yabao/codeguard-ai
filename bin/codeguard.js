#!/usr/bin/env node
'use strict';

/**
 * CodeGuard AI 命令行工具
 * ---------------------------------------------------------------------------
 * 用法（无需安装依赖，Node 内置即可运行）：
 *   node bin/codeguard.js review <文件|->    审查文件或标准输入
 *   node bin/codeguard.js serve              启动 Web 评审台
 *   node bin/codeguard.js doctor             环境自检
 *   node bin/codeguard.js rules              列出全部规则
 *   node bin/codeguard.js version            版本信息
 *
 * 示例：
 *   node bin/codeguard.js review examples/vulnerable-sample.js
 *   node bin/codeguard.js review src/ --min-severity major
 *   git diff | node bin/codeguard.js review - --no-llm
 *   node bin/codeguard.js review app.py --format markdown --out report.md
 */

const fs = require('fs');
const path = require('path');

const config = require('../src/config');
const logger = require('../src/core/logger');
const { SEVERITIES, DIMENSIONS } = require('../src/core/taxonomy');
const { analyze, analyzeFile, describeRules } = require('../src/analyzers/static-analyzer');
const { ReviewService } = require('../src/services/review-service');
const { formatDuration, escapeHtml } = require('../src/core/utils');

/* ------------------------------ 终端着色 ------------------------------ */
const COLOR = {
  reset: '\u001b[0m', bold: '\u001b[1m', dim: '\u001b[2m',
  red: '\u001b[31m', green: '\u001b[32m', yellow: '\u001b[33m',
  blue: '\u001b[34m', magenta: '\u001b[35m', cyan: '\u001b[36m', gray: '\u001b[90m',
};
const USE_COLOR = !process.env.NO_COLOR && Boolean(process.stdout.isTTY);
const paint = (text, color) => (USE_COLOR ? `${COLOR[color] || ''}${text}${COLOR.reset}` : String(text));

/** 严重级别 → 终端颜色 */
const SEVERITY_COLOR = { blocker: 'red', critical: 'red', major: 'yellow', minor: 'blue', info: 'gray' };

/* ------------------------------ 参数解析 ------------------------------ */
/**
 * 极简命令行参数解析器
 * @param {string[]} argv 参数数组
 * @returns {{positional:string[], flags:Record<string,string|boolean>}} 解析结果
 */
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else if (token.startsWith('-') && token.length > 1) {
      flags[token.slice(1)] = true;
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

/** 打印帮助 */
function printHelp() {
  process.stdout.write(`${paint('CodeGuard AI', 'cyan')} v${config.pkg.version} —— 面向开发者的 AI 代码审查 Agent

${paint('用法', 'bold')}
  node bin/codeguard.js <命令> [参数]

${paint('命令', 'bold')}
  review <文件|目录|->   审查代码（"-" 表示从标准输入读取）
  serve                  启动 Web 评审台
  doctor                 环境与依赖自检
  rules                  列出全部审查规则
  version                显示版本信息

${paint('review 选项', 'bold')}
  --format <json|markdown|html|sarif>   输出格式（默认终端彩色报告）
  --out <文件>                          结果写入文件
  --no-llm                              仅运行静态规则引擎（离线、零成本）
  --min-severity <级别>                 最低报告级别：${Object.keys(SEVERITIES).join(' | ')}
  --language <语言>                     强制指定语言（默认按扩展名/内容识别）
  --ignore <规则ID,规则ID>              忽略指定规则
  --roles <角色,角色>                   指定大模型审查角色：security,bug,performance,readability
  --no-fixes                            不生成修复建议

${paint('示例', 'bold')}
  node bin/codeguard.js review examples/vulnerable-sample.js
  node bin/codeguard.js review src/ --min-severity major --no-llm
  git diff | node bin/codeguard.js review - --no-llm
  node bin/codeguard.js review app.py --format markdown --out review-report.md
`);
}

/* ------------------------------ 报告渲染 ------------------------------ */
/**
 * 渲染终端彩色报告
 * @param {object} record 评审记录
 * @returns {string} 文本
 */
function renderTerminalReport(record) {
  const lines = [];
  const { score, metrics, stats, source } = record;
  const line = (text = '') => lines.push(text);

  const gradeColor = score.overall >= 82 ? 'green' : score.overall >= 70 ? 'yellow' : 'red';

  line();
  line(paint('═'.repeat(78), 'gray'));
  line(` ${paint('CodeGuard AI 代码审查报告', 'bold')}   语言 ${source.language}   代码指纹 ${record.source.codeHash.slice(0, 12)}`);
  line(paint('═'.repeat(78), 'gray'));
  line();
  line(
    ` 综合得分 ${paint(String(score.overall), gradeColor)} / 100   ` +
    `${paint(`等级 ${score.grade} · ${score.gradeLabel}`, gradeColor)}   ` +
    `${paint(`(${score.advice})`, 'gray')}`,
  );
  line();
  line(` ${paint('维度得分', 'bold')}`);
  for (const dimension of Object.values(score.dimensions)) {
    const filled = Math.round(dimension.score / 5);
    const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
    line(`   ${dimension.label.padEnd(6, '　')} ${bar} ${String(dimension.score).padStart(5)}   问题 ${dimension.issueCount} 项`);
  }
  line();
  line(` ${paint('严重级别分布', 'bold')}`);
  for (const [key, definition] of Object.entries(SEVERITIES)) {
    const count = stats.severityCounts[key] || 0;
    if (count === 0) continue;
    line(`   ${paint(definition.label.padEnd(4, '　'), SEVERITY_COLOR[key])} ${String(count).padStart(3)} 项   单项扣分 ${definition.weight}`);
  }
  line();
  line(` ${paint('代码度量', 'bold')}`);
  line(
    `   总行数 ${metrics.totalLines}   有效代码 ${metrics.codeLines}   注释率 ${(metrics.commentRatio * 100).toFixed(1)}%   ` +
    `函数 ${metrics.functionCount}   最大复杂度 ${metrics.maxComplexity}   最大嵌套 ${metrics.maxNesting}   可维护性 ${metrics.maintainabilityIndex}`,
  );
  line();
  line(
    ` ${paint('审查引擎', 'bold')}  规则命中 ${stats.staticIssueCount} 条（${stats.appliedRuleCount}/${stats.ruleCount} 条规则生效）` +
    `${stats.llmIssueCount ? `   大模型命中 ${stats.llmIssueCount} 条（${stats.confirmedCount} 条互相印证）` : ''}   耗时 ${formatDuration(stats.durationMs)}`,
  );
  if (record.llm?.model) line(` ${paint('模型', 'bold')}      ${record.llm.model}`);

  line();
  line(paint('─'.repeat(78), 'gray'));
  line(` ${paint(`问题清单（共 ${stats.issueCount} 项）`, 'bold')}`);
  line(paint('─'.repeat(78), 'gray'));

  if (record.issues.length === 0) {
    line(` ${paint('✔ 未发现问题，代码质量良好。', 'green')}`);
  } else {
    for (const issue of record.issues) {
      const tag = paint(`[${issue.severityLabel}]`, SEVERITY_COLOR[issue.severity]);
      const src = issue.source === 'llm' ? paint('〔大模型〕', 'magenta') : paint('〔规则〕', 'cyan');
      line();
      line(` ${tag} ${src} ${paint(`L${issue.line}`, 'bold')}  ${paint(issue.ruleId, 'gray')}  ${issue.title}`);
      line(`      ${paint(issue.message, 'gray')}`);
      if (issue.snippet) line(`      ${paint(`│ ${issue.snippet.slice(0, 100)}`, 'gray')}`);
      if (issue.suggestion) line(`      ${paint('建议：', 'green')}${issue.suggestion.slice(0, 150)}`);
    }
  }

  if (record.fixes?.length) {
    line();
    line(paint('─'.repeat(78), 'gray'));
    line(` ${paint(`修复建议（共 ${record.fixes.length} 条）`, 'bold')}`);
    line(paint('─'.repeat(78), 'gray'));
    record.fixes.forEach((fix, index) => {
      line();
      line(` ${index + 1}. ${paint(`L${fix.line}`, 'bold')} ${fix.title} ${paint(`(${fix.ruleId})`, 'gray')}`);
      line(`    ${paint(fix.rationale || '', 'gray')}`);
      if (fix.diff) {
        for (const diffLine of fix.diff.split('\n')) {
          const color = diffLine.startsWith('+') ? 'green' : diffLine.startsWith('-') ? 'red' : 'gray';
          line(`    ${paint(diffLine, color)}`);
        }
      }
    });
  }

  if (record.warnings?.length) {
    line();
    line(paint('审查提示', 'yellow'));
    for (const warning of record.warnings) line(`  ${paint('•', 'yellow')} ${warning}`);
  }

  line();
  line(paint('═'.repeat(78), 'gray'));
  line(` ${paint(`记录 ID ${record.id}（可用 node bin/codeguard.js review 复查同一代码指纹）`, 'gray')}`);
  line();

  return lines.join('\n');
}

/* ------------------------------ 子命令 ------------------------------ */
/**
 * review 命令
 * @param {string[]} positional 位置参数
 * @param {object} flags 开关
 * @returns {Promise<number>} 退出码
 */
async function commandReview(positional, flags) {
  const target = positional[0];
  if (!target) {
    process.stderr.write('错误：请指定待审查的文件、目录或 "-"（标准输入）\n');
    printHelp();
    return 2;
  }

  const service = new ReviewService();
  const roles = flags.roles ? String(flags.roles).split(',').map((item) => item.trim()) : undefined;
  const ignoreRules = flags.ignore ? String(flags.ignore).split(',').map((item) => item.trim()) : [];
  const options = {
    useLlm: !flags['no-llm'],
    includeFixes: !flags['no-fixes'],
    minSeverity: flags['min-severity'] ? String(flags['min-severity']) : null,
    language: flags.language ? String(flags.language) : null,
    ignoreRules,
    roles,
  };

  /** 收集待审查文件列表 */
  const collectFiles = (inputPath) => {
    const absolute = path.resolve(inputPath);
    if (!fs.existsSync(absolute)) throw new Error(`路径不存在：${absolute}`);
    const stat = fs.statSync(absolute);
    if (stat.isFile()) return [absolute];

    const SUPPORTED = new Set([
      '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.java', '.go',
      '.c', '.h', '.cpp', '.cc', '.hpp', '.cs', '.php', '.rb', '.sh', '.sql',
    ]);
    const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'data']);
    const found = [];

    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) walk(full);
        } else if (SUPPORTED.has(path.extname(entry.name).toLowerCase())) {
          found.push(full);
        }
      }
    };
    walk(absolute);
    return found;
  };

  const records = [];

  if (target === '-') {
    // 从标准输入读取（便于与 git diff 等命令串联）
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const code = Buffer.concat(chunks).toString('utf8');
    if (!code.trim()) {
      process.stderr.write('错误：标准输入为空\n');
      return 2;
    }
    records.push(await service.review({ ...options, code, fileName: flags.filename || 'stdin.diff', title: '标准输入' }));
  } else {
    const files = collectFiles(target);
    if (files.length === 0) {
      process.stderr.write('错误：目录下未找到可审查的源码文件\n');
      return 2;
    }
    if (files.length > 1) process.stdout.write(paint(`正在审查 ${files.length} 个文件…\n`, 'gray'));

    for (const file of files) {
      const code = fs.readFileSync(file, 'utf8');
      // 跳过明显过大的文件，避免单文件拖垮整体流程
      if (code.length > 400_000) {
        process.stdout.write(paint(`跳过 ${path.basename(file)}（超过 400 KB）\n`, 'yellow'));
        continue;
      }
      const record = await service.review({
        ...options,
        code,
        fileName: path.basename(file),
        title: path.relative(process.cwd(), file),
      });
      records.push(record);
      if (files.length > 1) {
        process.stdout.write(
          `  ${record.score.overall >= 82 ? paint('✔', 'green') : paint('✖', 'red')} ` +
          `${path.relative(process.cwd(), file).padEnd(50)} ${String(record.score.overall).padStart(5)} 分   ${record.stats.issueCount} 个问题\n`,
        );
      }
    }
  }

  if (records.length === 0) return 2;

  /* 输出 */
  const format = flags.format ? String(flags.format).toLowerCase() : null;
  if (format) {
    const outputs = records.map((record) => service.exportReport(record.id, format).content);
    const content = outputs.length === 1 ? outputs[0] : outputs.join('\n\n---\n\n');
    if (flags.out) {
      fs.writeFileSync(path.resolve(String(flags.out)), content, 'utf8');
      process.stdout.write(`${paint('✔', 'green')} 报告已写入 ${path.resolve(String(flags.out))}（${content.length} 字符）\n`);
    } else {
      process.stdout.write(`${content}\n`);
    }
  } else {
    for (const record of records) process.stdout.write(renderTerminalReport(record));
    if (records.length > 1) {
      const average = records.reduce((sum, item) => sum + item.score.overall, 0) / records.length;
      const totalIssues = records.reduce((sum, item) => sum + item.stats.issueCount, 0);
      process.stdout.write(
        `${paint('汇总', 'bold')}：${records.length} 个文件，平均得分 ${average.toFixed(1)}，问题合计 ${totalIssues} 项\n\n`,
      );
    }
  }

  // 退出码约定：存在阻断/严重问题返回 1，便于在 CI 中作为质量门禁
  const hasBlocking = records.some((record) =>
    record.issues.some((issue) => ['blocker', 'critical'].includes(issue.severity)),
  );
  return hasBlocking ? 1 : 0;
}

/** serve 命令 */
async function commandServe(flags) {
  const { start } = require('../src/server');
  const port = flags.port ? Number(flags.port) : undefined;
  const { server } = await start({ port });
  const stop = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return new Promise(() => {});
}

/** doctor 命令 */
function commandDoctor() {
  const check = config.selfCheck();
  process.stdout.write(`\n${paint('CodeGuard AI 环境自检', 'bold')}  v${config.pkg.version}\n\n`);

  for (const item of check.checks) {
    const mark = item.ok ? paint('✔', 'green') : item.level === 'warn' ? paint('!', 'yellow') : paint('✖', 'red');
    process.stdout.write(`  ${mark} ${item.name.padEnd(18, ' ')} ${paint(item.detail, 'gray')}\n`);
  }

  const snapshot = config.describe();
  process.stdout.write(`\n${paint('运行配置', 'bold')}\n`);
  process.stdout.write(`  大模型供应商   ${snapshot.llm.providerLabel}（${snapshot.llm.provider}）\n`);
  process.stdout.write(`  模型           ${snapshot.llm.model || '未配置'}\n`);
  process.stdout.write(`  接口地址       ${snapshot.llm.baseUrl || '未配置'}\n`);
  process.stdout.write(`  密钥           ${snapshot.llm.apiKeyMasked || '未配置'}\n`);
  process.stdout.write(`  仅规则引擎模式 ${snapshot.review.enableLlm ? '否' : '是'}\n`);
  process.stdout.write(`  数据目录       ${snapshot.storage.dataDir}\n`);
  process.stdout.write(`  Node 运行时    ${snapshot.runtime.node} / ${snapshot.runtime.platform}-${snapshot.runtime.arch}\n`);

  process.stdout.write(`\n${paint('支持的语言', 'bold')}\n`);
  const { LANGUAGES } = require('../src/analyzers/languages');
  process.stdout.write(
    `  ${Object.values(LANGUAGES).map((profile) => `${profile.label}(${profile.extensions.join(' ')})`).join('  ')}\n`,
  );

  process.stdout.write(
    `\n${check.ok ? paint('结论：环境就绪，可以启动服务。', 'green') : paint('结论：存在异常项，请先修复后再启动服务。', 'red')}\n`,
  );
  if (!config.llm.available) {
    process.stdout.write(
      `${paint('提示：未配置大模型密钥时，系统仅运行规则引擎（41 条规则，完全离线可用）。', 'yellow')}\n` +
      `${paint('      如需启用语义评审，请复制 .env.example 为 .env 并填写对应供应商的 API Key。', 'gray')}\n`,
    );
  }
  process.stdout.write('\n');
  return check.ok ? 0 : 1;
}

/** rules 命令 */
function commandRules(flags) {
  const meta = describeRules();
  const onlyId = flags.id ? String(flags.id) : null;

  process.stdout.write(`\n${paint('CodeGuard AI 审查规则清单', 'bold')}  共 ${meta.total} 条\n\n`);

  if (flags.dimension) {
    const target = String(flags.dimension);
    process.stdout.write(`（仅显示维度：${target}）\n\n`);
  }

  const grouped = {};
  for (const rule of meta.rules) {
    if (flags.dimension && rule.dimension !== String(flags.dimension)) continue;
    if (onlyId && rule.id !== onlyId) continue;
    grouped[rule.dimension] = grouped[rule.dimension] || [];
    grouped[rule.dimension].push(rule);
  }

  for (const [dimension, rules] of Object.entries(grouped)) {
    const definition = DIMENSIONS[dimension];
    process.stdout.write(`${paint(`▼ ${definition.label}（${dimension}）`, 'cyan')}  ${paint(definition.description, 'gray')}\n`);
    for (const rule of rules) {
      const color = SEVERITY_COLOR[rule.severity];
      process.stdout.write(`  ${paint(rule.id.padEnd(8), 'bold')} ${paint(`[${rule.severity}]`.padEnd(10), color)} ${rule.title}\n`);
      if (flags.verbose || onlyId) {
        process.stdout.write(`      ${paint('说明：', 'gray')}${rule.description}\n`);
        process.stdout.write(`      ${paint('建议：', 'green')}${rule.suggestion}\n`);
        if (rule.reference) process.stdout.write(`      ${paint('依据：', 'gray')}${rule.reference}\n`);
      }
    }
    process.stdout.write('\n');
  }
  process.stdout.write(`${paint('提示：添加 --verbose 显示每条规则的完整说明与修复建议。', 'gray')}\n\n`);
  return 0;
}

/** version 命令 */
function commandVersion() {
  const snapshot = config.describe();
  process.stdout.write(
    `\nCodeGuard AI v${snapshot.app.version}\n` +
    `${config.pkg.description}\n\n` +
    `Node 运行时   ${snapshot.runtime.node}\n` +
    `运行环境      ${snapshot.env}\n` +
    `大模型        ${snapshot.llm.available ? `${snapshot.llm.providerLabel} / ${snapshot.llm.model}` : '未配置（仅规则引擎）'}\n` +
    `规则数量      ${describeRules().total}\n\n`,
  );
  return 0;
}

/* ------------------------------ 主入口 ------------------------------ */
async function main() {
  const argv = process.argv.slice(2);
  const { positional, flags } = parseArgs(argv);
  const command = positional.shift() || (flags.help || flags.h ? 'help' : 'help');

  if (flags.help && command === 'help') { printHelp(); return 0; }
  if (flags.version && command === 'help') return commandVersion();

  switch (command) {
    case 'review': return commandReview(positional, flags);
    case 'serve': return commandServe(flags);
    case 'doctor': return commandDoctor();
    case 'rules': return commandRules(flags);
    case 'version':
    case '-v': return commandVersion();
    case 'help':
    default:
      printHelp();
      return command === 'help' ? 0 : 2;
  }
}

main()
  .then((code) => { process.exitCode = typeof code === 'number' ? code : 0; })
  .catch((error) => {
    process.stderr.write(`\n${paint('执行失败：', 'red')}${error.message}\n`);
    if (process.env.DEBUG) process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
  });
