'use strict';

/**
 * 性能类规则集（PERF）
 * ---------------------------------------------------------------------------
 * 关注「功能正确但资源开销显著放大」的写法，重点是事件循环阻塞、
 * 循环内重复劳动、以及可并行的串行等待。
 */

module.exports = [
  {
    id: 'PERF001',
    title: '循环内使用 await 串行等待',
    dimension: 'performance',
    severity: 'major',
    languages: ['javascript', 'typescript'],
    description:
      '在 for / while 循环体内逐条 await，会把本可并行的异步任务串行化，总耗时随条目数线性放大，是接口超时的常见根因。',
    suggestion:
      '无依赖关系时改用 Promise.all(items.map(async (item) => ...)) 并行执行；需要限制并发度时使用 p-limit（或自研信号量）控制在 5~10 之间。',
    reference: 'Node.js 性能最佳实践 · 避免循环内 await',
    scan: {
      type: 'custom',
      run(ctx) {
        const issues = [];
        const lines = ctx.codeLines;
        let loopIndent = null;
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i];
          const indent = (line.match(/^[ \t]*/) || [''])[0].length;

          if (/\b(?:for|while)\s*[\( ]/.test(line)) {
            loopIndent = indent;
            continue;
          }
          // 缩进回落说明已跳出循环体
          if (loopIndent !== null && line.trim() && indent <= loopIndent) {
            loopIndent = null;
          }
          if (loopIndent !== null && /\bawait\b/.test(line)) {
            issues.push({
              line: i + 1,
              column: indent + 1,
              message: '循环体内使用 await，逐条等待会退化为串行执行',
              matchText: line.trim().slice(0, 80),
            });
          }
        }
        return issues.slice(0, 5);
      },
    },
    message: '循环内串行 await',
  },
  {
    id: 'PERF002',
    title: '循环内执行同步阻塞 IO',
    dimension: 'performance',
    severity: 'major',
    languages: ['javascript', 'typescript'],
    description:
      '在循环或请求处理路径中调用 *Sync 版本的 IO（readFileSync / execSync 等），会阻塞事件循环，使同一进程内的所有并发请求排队等待。',
    suggestion: '改用异步版本（fs.promises.readFile / util.promisify 后的函数）；确需同步的场景应放到 worker_threads 或独立进程中执行。',
    reference: 'Node.js 官方文档 · 不要阻塞事件循环',
    scan: {
      type: 'syntaxLine',
      pattern: /\b(?:fs\.)?(?:readFileSync|writeFileSync|appendFileSync|existsSync|readdirSync|statSync|execSync|spawnSync)\s*\(/,
      maxPerFile: 6,
    },
    message: '调用同步阻塞 IO {match}，会阻塞事件循环',
  },
  {
    id: 'PERF003',
    title: '循环内进行线性查找',
    dimension: 'performance',
    severity: 'minor',
    languages: ['javascript', 'typescript', 'python'],
    description:
      '在循环体内对数组使用 includes / indexOf / in 做查找，整体复杂度退化为 O(n²)；数据量增长后耗时呈平方级上升。',
    suggestion: '把被查找集合预先构造为 Set 或 Map（O(1) 查找）；Python 中使用 set() 或 dict 做成员判断。',
    reference: '算法复杂度 · 线性查找与哈希查找的差异',
    scan: {
      type: 'custom',
      run(ctx) {
        const issues = [];
        const lines = ctx.codeLines;
        let loopIndent = null;
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i];
          const indent = (line.match(/^[ \t]*/) || [''])[0].length;
          if (/\b(?:for|while)\s*[\( ]/.test(line)) {
            loopIndent = indent;
            continue;
          }
          if (loopIndent !== null && line.trim() && indent <= loopIndent) loopIndent = null;
          if (loopIndent === null) continue;

          const linear = /\.(?:includes|indexOf|lastIndexOf|find)\s*\(|(?:\bin\s+)(?!\{)\w+\s*\)/.exec(line);
          if (linear) {
            issues.push({
              line: i + 1,
              column: indent + 1,
              message: `循环内使用 ${linear[0].trim()} 做线性查找，建议改用 Set / Map`,
              matchText: line.trim().slice(0, 80),
            });
          }
        }
        return issues.slice(0, 5);
      },
    },
    message: '循环内线性查找',
  },
  {
    id: 'PERF004',
    title: '循环内重复构造正则或对象',
    dimension: 'performance',
    severity: 'minor',
    languages: ['javascript', 'typescript'],
    description: '在循环体内 new RegExp / new Date / new Intl.* 会反复触发解析与编译，属于可无成本消除的开销。',
    suggestion: '把不必随迭代变化的构造过程提升到循环之外，或在模块顶层定义为常量。',
    reference: 'V8 优化指南 · 循环不变式外提',
    scan: {
      type: 'custom',
      run(ctx) {
        const issues = [];
        const lines = ctx.codeLines;
        let loopIndent = null;
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i];
          const indent = (line.match(/^[ \t]*/) || [''])[0].length;
          if (/\b(?:for|while)\s*[\( ]/.test(line)) {
            loopIndent = indent;
            continue;
          }
          if (loopIndent !== null && line.trim() && indent <= loopIndent) loopIndent = null;
          if (loopIndent === null) continue;

          const match = /\bnew\s+(?:RegExp|Date|Intl\.[A-Za-z]+)\s*\(/.exec(line);
          if (match) {
            issues.push({
              line: i + 1,
              column: indent + 1,
              message: `循环内重复构造 ${match[0].replace(/\($/, '')}，建议外提为常量`,
              matchText: line.trim().slice(0, 80),
            });
          }
        }
        return issues.slice(0, 5);
      },
    },
    message: '循环内重复构造对象',
  },
  {
    id: 'PERF005',
    title: '利用 JSON 序列化做深拷贝',
    dimension: 'performance',
    severity: 'minor',
    languages: ['javascript', 'typescript'],
    description:
      'JSON.parse(JSON.stringify(x)) 会丢失 undefined、函数、Symbol、Date 类型与原型链，且对大对象有显著的内存与 CPU 开销。',
    suggestion: '使用 structuredClone(x)（Node 17+ 内置）或按需手写拷贝函数，既保类型又更高效。',
    reference: 'MDN · structuredClone',
    scan: {
      type: 'syntaxLine',
      pattern: /JSON\.parse\s*\(\s*JSON\.stringify\s*\(/,
    },
    message: '使用 {match} 做深拷贝，存在类型丢失与性能开销',
  },
  {
    id: 'PERF006',
    title: '未限制深度的递归遍历',
    dimension: 'performance',
    severity: 'minor',
    languages: ['*'],
    description: '递归遍历树或目录结构时未设置最大深度限制，遇到异常数据（如符号链接环）会导致无限递归与内存耗尽。',
    suggestion: '为递归函数增加 depth 参数与上限保护（如 depth > 100 时终止并告警），或改用显式栈的迭代实现。',
    reference: 'CWE-674 无控制的递归',
    scan: {
      type: 'line',
      pattern: /\b(?:walk|traverse|scan|readdir|glob|visit)\s*\([^)]*\brecursive\s*[:=]\s*true/i,
      maxPerFile: 3,
    },
    message: '递归遍历未设置深度上限 {match}',
  },
];
