'use strict';

/**
 * 缺陷类规则集（BUG）
 * ---------------------------------------------------------------------------
 * 聚焦「能通过语法检查、但在特定输入下必然出错」的逻辑缺陷：
 * 松散比较、静默吞异常、未处理的 Promise、浮点相等、除零、可变默认参数、
 * for-in 遍历数组、递归缺少终止条件、数组越界风险等。
 */

module.exports = [
  {
    id: 'BUG001',
    title: '使用松散相等比较',
    dimension: 'bug',
    severity: 'major',
    languages: ['javascript', 'typescript', 'php'],
    description:
      '== 会触发隐式类型转换，导致 "0" == false、"1" == true、[] == false 等反直觉结果，是前端线上缺陷的高频来源。',
    suggestion: '统一使用 === / !== 做严格比较；确需宽松比较时显式写出转换逻辑（如 Number(x) === 0）。',
    reference: 'ESLint eqeqeq · JavaScript 相等性隐式转换规则',
    scan: {
      type: 'syntaxLine',
      pattern: /[^=!<>+\-*/%]==[^=]|[^!<>]!=([^=]|$)/,
      filter: (match, lineText) => {
        // 排除类型判断惯用写法与空值联合判断
        if (/\b(?:typeof|instanceof)\b/.test(lineText)) return false;
        if (/==\s*null|!=\s*null/.test(lineText)) return false;
        return true;
      },
    },
    message: '使用松散相等 {match}，建议改为 === / !==',
  },
  {
    id: 'BUG002',
    title: '异常被静默吞掉',
    dimension: 'bug',
    severity: 'major',
    languages: ['*'],
    description:
      'catch 块为空或仅打印后继续执行，会让故障在无告警的情况下被掩盖，问题定位成本成倍上升。',
    suggestion:
      '在 catch 中至少执行三件事之一：向上抛出、记录带上下文的错误日志、返回明确的可观察降级结果。禁止出现空的 catch 块。',
    reference: 'CWE-391 未检查的错误条件',
    scan: {
      type: 'custom',
      run(ctx) {
        const issues = [];
        const text = ctx.syntaxOnly;
        // 空 catch 块：catch (e) { } / except: pass / except Exception: pass
        const emptyCatch = /catch\s*(?:\([^)]*\))?\s*\{\s*\}/g;
        const pythonPass = /except[^\n:]*:\s*(?:\n\s*pass\b|pass\b)/g;
        const swallow = /catch\s*\([^)]*\)\s*\{\s*(?:console\.(?:log|warn|info)\([^;]*\);?)\s*\}/g;

        for (const pattern of [emptyCatch, pythonPass, swallow]) {
          const re = new RegExp(pattern.source, 'g');
          let match;
          while ((match = re.exec(text)) !== null) {
            const line = ctx.lineOfOffset(match.index);
            issues.push({
              line,
              column: 1,
              message: '异常处理块为空或仅打印日志，故障将被静默吞掉',
              matchText: match[0].slice(0, 60),
            });
          }
        }
        return issues;
      },
    },
    message: '异常被静默吞掉',
  },
  {
    id: 'BUG003',
    title: 'Promise 未处理拒绝',
    dimension: 'bug',
    severity: 'major',
    languages: ['javascript', 'typescript'],
    description:
      '只写 .then 而不提供 .catch，或调用 async 函数不加 await / catch，会导致拒绝态无人接管，进程可能直接崩溃且无有效堆栈。',
    suggestion:
      '统一使用 try/catch 包裹 await；若使用 .then 链则必须补 .catch；顶层调用用 .catch(err => logger.error(err)) 收口。',
    reference: 'Node.js 官方文档 · Unhandled Rejection',
    scan: {
      type: 'custom',
      run(ctx) {
        const issues = [];
        const text = ctx.syntaxOnly;
        // .then(...) 之后同行或紧邻行没有 .catch
        const thenPattern = /\.then\s*\([^)]*\)/g;
        let match;
        while ((match = thenPattern.exec(text)) !== null) {
          const after = text.slice(match.index + match[0].length, match.index + match[0].length + 120);
          if (/^\s*\)?\s*;?\s*(?:\n\s*)?\.catch/.test(after)) continue;
          if (/\.catch\s*\(/.test(after)) continue;
          issues.push({
            line: ctx.lineOfOffset(match.index),
            column: 1,
            message: '.then 链缺少 .catch，拒绝态将无人处理',
            matchText: match[0].slice(0, 60),
          });
        }
        return issues;
      },
    },
    message: 'Promise 未处理拒绝',
  },
  {
    id: 'BUG004',
    title: '浮点数直接相等比较',
    dimension: 'bug',
    severity: 'major',
    languages: ['*'],
    description: 'IEEE 754 浮点运算存在舍入误差，0.1 + 0.2 === 0.3 为 false，直接比较会产生难以复现的判定失败。',
    suggestion: '改用误差容限比较：Math.abs(a - b) < 1e-9；金额等高精度场景改用整数分单位或 decimal 库。',
    reference: 'IEEE 754 · 浮点数舍入误差',
    scan: {
      type: 'syntaxLine',
      pattern: /\b\d+\.\d+\s*(?:===?|!==?)\s*[\w.]|[a-zA-Z_$][\w$.]*\s*(?:===?|!==?)\s*\b\d+\.\d+/,
      filter: (match, lineText) => {
        // 与 0 / 0.0 比较是常见且安全的写法，不告警；负向先行断言确保 0.3 这类小数不会被误判为字面量 0
        if (/(?:===?|!==?)\s*0(?:\.0+)?(?![.\d])/.test(lineText)) return false;
        if (/\b0(?:\.0+)?(?![.\d])\s*(?:===?|!==?)/.test(lineText)) return false;
        return true;
      },
    },
    message: '浮点数直接使用精确相等比较，应改为误差容限判断（如 Math.abs(a - b) < 1e-9）',
  },
  {
    id: 'BUG005',
    title: '除法运算缺少零值保护',
    dimension: 'bug',
    severity: 'major',
    languages: ['*'],
    description:
      '以未校验的变量作除数，当其为 0 时会产生 Infinity / NaN（JS）或抛出 ZeroDivisionError（Python），导致结果静默污染或直接崩溃。',
    suggestion: '在除法前显式判断除数：if (denominator === 0) return 0; 或使用安全除法工具函数统一兜底。',
    reference: 'CWE-369 除零错误',
    scan: {
      type: 'custom',
      run(ctx) {
        const issues = [];
        const text = ctx.syntaxOnly;
        /** 视为已校验的上下文行数（守卫语句通常紧邻除法之前） */
        const GUARD_WINDOW = 6;

        // 形如 a / b，其中 b 是标识符或属性访问（排除常量与括号表达式）
        const division = /(^|[^\/*])(?:\/)\s*([a-zA-Z_$][\w$.]*)/g;
        let match;

        while ((match = division.exec(text)) !== null) {
          const line = ctx.lineOfOffset(match.index);
          const lineText = ctx.originalLine(line);
          const divisor = match[2];
          const bareDivisor = divisor.split('.').pop();

          if (/^\s*(?:\/\/|\*|#)/.test(lineText)) continue;
          if (/\/\/|\/\*/.test(match[0])) continue;

          // 校验「已对该除数做过零值保护」需基于明确的零值判据。
          // 只需形如 if (x) 就放行会漏报（例如同一函数里存在 `if (a == b)` 这样的无关分支），
          // 因此这里要求出现与 0 的比较、取反判断或 Math.max 兜底。
          const escaped = bareDivisor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const word = `(?<![\\w$])${escaped}(?![\\w$])`;
          const guardPattern = new RegExp(
            [
              `${word}\\s*(?:===|==|!==|!=|<=|>=|<|>)\\s*0`,
              `0\\s*(?:===|==|!==|!=|<=|>=|<|>)\\s*${word}`,
              `!\\s*${word}`,
              `Math\\.max\\s*\\([^)]*${word}`,
            ].join('|'),
          );

          const from = Math.max(1, line - GUARD_WINDOW);
          const context = ctx.codeLines.slice(from - 1, line).join('\n');
          if (guardPattern.test(context)) continue;

          issues.push({
            line,
            column: match.index - (match[1] ? match[1].length : 0) + 1,
            message: `除数 ${divisor} 未做零值校验，可能产生 Infinity / NaN`,
            matchText: match[0].trim(),
          });
        }
        return issues;
      },
    },
    message: '除法运算缺少零值保护',
  },
  {
    id: 'BUG006',
    title: '可变对象作为默认参数',
    dimension: 'bug',
    severity: 'major',
    languages: ['python'],
    description:
      'Python 的默认参数只在函数定义时求值一次，使用 [] / {} / set() 作为默认值会在多次调用间共享同一对象，造成数据串场。',
    suggestion: '默认值写 None，在函数体内判断后创建新对象：def f(items=None):\n    items = [] if items is None else items',
    reference: 'Python 官方 FAQ · 默认参数值只求值一次',
    scan: {
      type: 'line',
      pattern: /def\s+\w+\s*\([^)]*=\s*(?:\[\s*\]|\{\s*\}|set\s*\(\s*\)|dict\s*\(\s*\)|list\s*\(\s*\))/,
    },
    message: '默认参数使用可变对象 {match}，会在调用间共享状态',
  },
  {
    id: 'BUG007',
    title: '使用 for-in 遍历数组',
    dimension: 'bug',
    severity: 'major',
    languages: ['javascript', 'typescript'],
    description:
      'for...in 遍历的是可枚举属性名（字符串），顺序不保证，且会把原型链上的属性一并枚举，用于数组会得到字符串下标。',
    suggestion: '数组遍历使用 for...of、Array.prototype.forEach 或带索引的经典 for 循环；对象遍历才使用 for...in 并配合 hasOwnProperty。',
    reference: 'MDN · for...in 语句',
    scan: {
      type: 'syntaxLine',
      pattern: /for\s*\(\s*(?:const|let|var)\s+(\w+)\s+in\s+(\w+)/,
      filter: (match, lineText, ctxRef) => {
        // 仅当被遍历对象在同文件内被明确声明为对象字面量时，才认为是合法用法；
        // 其余情况（数组、函数返回值、外部变量）都提示改用 for...of，因为数组误用 for...in 是高发缺陷
        const target = match[2];
        if (!ctxRef || !ctxRef.syntaxOnly) return true;
        const declaredAsObject = new RegExp(`(?:const|let|var)\\s+${target}\\s*=\\s*\\{`);
        return !declaredAsObject.test(ctxRef.syntaxOnly);
      },
    },
    message: '使用 for...in 遍历数组 {match}，应改为 for...of',
  },
  {
    id: 'BUG008',
    title: '递归函数缺少终止条件',
    dimension: 'bug',
    severity: 'major',
    languages: ['*'],
    description: '函数体内直接递归调用自身，但函数中没有发现任何条件返回语句，极易造成栈溢出崩溃。',
    suggestion: '确保每个递归分支都有可达的终止条件（base case），并考虑为深层递归改用显式栈的迭代实现。',
    reference: 'CWE-674 无控制的递归',
    scan: {
      type: 'custom',
      run(ctx) {
        const issues = [];
        const guarded = /\bif\b|\breturn\b|\bwhile\b|\bfor\b|\bswitch\b|\bcase\b|\bexcept\b/;
        for (const fn of ctx.metrics.functions) {
          if (!fn.name || fn.name === '（匿名）') continue;
          const bodyLines = ctx.codeLines.slice(fn.startLine - 1, fn.endLine);
          const body = bodyLines.join('\n');
          const selfCall = new RegExp(`\\b${fn.name}\\s*\\(`);
          if (!selfCall.test(body)) continue;
          // 出现递归调用但整个函数体没有任何分支/返回结构
          if (guarded.test(body)) continue;
          issues.push({
            line: fn.startLine,
            column: 1,
            message: `函数 ${fn.name} 递归调用自身但未发现终止条件`,
            matchText: `function ${fn.name}`,
          });
        }
        return issues;
      },
    },
    message: '递归函数缺少终止条件',
  },
  {
    id: 'BUG009',
    title: '索引访问未做边界校验',
    dimension: 'bug',
    severity: 'minor',
    languages: ['*'],
    description: '以变量作为数组下标直接取值，未校验长度或存在性，越界时将得到 undefined 并向下游传播。',
    suggestion: '访问前校验索引范围，或改用安全的可选链/默认值：const item = list[i] ?? fallback;',
    reference: 'CWE-125 越界读取',
    scan: {
      type: 'line',
      patterns: [
        /\b\w+\s*\[\s*(?:i|j|k|idx|index|pos|position)\s*\]\s*\./,
        /\b\w+\s*\[\s*0\s*\]\s*\./,
      ],
      filter: (match, lineText) => !/(?:length|len\s*\(|hasOwnProperty|\?\?|if\s*\()/.test(lineText),
      maxPerFile: 5,
    },
    message: '直接以变量下标访问成员 {match}，建议先做边界校验',
  },
  {
    id: 'BUG010',
    title: '未捕获的异步回调异常',
    dimension: 'bug',
    severity: 'minor',
    languages: ['javascript', 'typescript'],
    description:
      '在 setTimeout / setInterval / 事件回调中执行异步逻辑却未包裹 try/catch，抛出的异常会变成全局未捕获异常，难以定位到具体调用点。',
    suggestion: '在回调入口处统一包裹 try/catch，或改用可追踪的日志上下文记录异常来源。',
    reference: 'Node.js 官方文档 · 未捕获异常处理',
    scan: {
      type: 'syntaxLine',
      patterns: [
        /setTimeout\s*\(\s*(?:async\s*)?\([^)]*\)\s*=>/,
        /setInterval\s*\(\s*(?:async\s*)?\([^)]*\)\s*=>/,
      ],
      filter: (match, lineText) => !/(?:try|catch)\b/.test(lineText),
      maxPerFile: 3,
    },
    message: '定时器回调中缺少异常捕获 {match}',
  },
];
