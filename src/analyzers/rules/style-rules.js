'use strict';

/**
 * 可读性与可维护性规则集（STY / MNT）
 * ---------------------------------------------------------------------------
 * readability（可读性）：长行、调试输出残留、命名混乱、空白字符、注释缺失等
 * maintainability（可维护性）：函数过长、复杂度过高、嵌套过深、参数过多、注释率不足、文件过大
 *
 * 其中「文件级」指标（注释率、文件行数）由度量引擎提供，规则只负责把阈值转化为问题条目。
 */

module.exports = [
  {
    id: 'STY001',
    title: '代码行超过建议长度',
    dimension: 'readability',
    severity: 'minor',
    languages: ['*'],
    description: '单行长度超过 120 字符会迫使阅读者横向滚动，并在代码评审界面中被截断，降低可读性。',
    suggestion: '在合理位置换行：链式调用按点号断行，长参数列表按逗号断行，长条件拆分为具名布尔变量。',
    reference: 'Google JavaScript Style Guide · 建议行宽 80~120',
    scan: {
      type: 'line',
      pattern: /^.{121,}$/,
      filter: (match, lineText) => {
        // 纯 URL、长字符串常量与生成代码不计入
        if (/^\s*(?:\/\/|#|\*)/.test(lineText)) return false;
        return true;
      },
      maxPerFile: 8,
    },
    message: '本行长度 {length} 字符，超过 120 字符上限',
  },
  {
    id: 'STY002',
    title: '调试输出残留',
    dimension: 'readability',
    severity: 'minor',
    languages: ['*'],
    description: '提交 console.log / print / System.out.println 等调试语句会产生无关日志、泄漏内部变量，并拉低代码整洁度。',
    suggestion: '改用统一日志组件并按级别输出（logger.debug/info/warn/error）；提交前通过 lint 规则禁止裸 console 调用。',
    reference: 'ESLint no-console · 团队日志规范',
    scan: {
      type: 'syntaxLine',
      patterns: [
        /\bconsole\.(?:log|debug|info|dir|trace)\s*\(/,
        /(?:^|[^\w.])print\s*\(/,
        /\bSystem\.out\.println\s*\(/,
        /\bprintln!\s*\(/,
        /(?:^|[^\w.])echo\s+/,
      ],
      maxPerFile: 6,
    },
    message: '发现调试输出语句 {match}，上线前应移除或改用日志组件',
  },
  {
    id: 'STY003',
    title: '待办标记未处理',
    dimension: 'readability',
    severity: 'info',
    languages: ['*'],
    description: 'TODO / FIXME / HACK 标记代表已知未完成事项，长期滞留会演变为隐性技术债。',
    suggestion: '为每个标记补充负责人与期限（如 TODO(@zhangsan 2026-03-01): ...），并纳入迭代看板跟踪关闭。',
    reference: '团队代码规范 · 技术债管理',
    scan: {
      type: 'comment',
      pattern: /\b(TODO|FIXME|XXX|HACK)\b\s*[:：]?/i,
      maxPerFile: 10,
    },
    message: '存在未处理的 {1} 标记',
  },
  {
    id: 'STY004',
    title: '命名不符合规范',
    dimension: 'readability',
    severity: 'minor',
    languages: ['*'],
    description: '无意义的单字母命名（循环下标除外）或大小写风格混用会显著增加理解成本。',
    suggestion: '变量与函数使用小驼峰（JS/Java）或蛇形（Python），类与构造函数使用大驼峰，常量使用全大写加下划线。',
    reference: '命名约定 · Google Style Guide',
    scan: {
      type: 'syntaxLine',
      patterns: [
        /\b(?:const|let|var)\s+([a-df-hj-z])\s*=/,
        /\bfunction\s+([a-z][a-zA-Z0-9]*_[a-zA-Z0-9_]+)\s*\(/,
        /\b(?:const|let|var)\s+([a-z][a-zA-Z0-9]*_[a-zA-Z0-9_]+)\s*=/,
      ],
      filter: (match, lineText) => {
        // 常见数学/循环约定与解构赋值不告警
        if (/\b(?:for|while)\s*\(/.test(lineText)) return false;
        if (/\bi\b|\bj\b|\bk\b|\bn\b|\b_/.test(match[1] || '')) return false;
        return true;
      },
      maxPerFile: 6,
    },
    message: '标识符 {1} 命名不符合团队规范',
  },
  {
    id: 'STY005',
    title: '行尾存在多余空白',
    dimension: 'readability',
    severity: 'info',
    languages: ['*'],
    description: '行尾空白在 diff 中产生噪声，容易掩盖真实改动，也是合并冲突的常见来源。',
    suggestion: '在编辑器中开启 trimTrailingWhitespace，并通过 .editorconfig 的 trim_trailing_whitespace = true 统一约束。',
    reference: 'EditorConfig · trim_trailing_whitespace',
    scan: {
      // 使用原始行：注释行本身也可能有行尾空白，改用剥离注释后的文本会漏报
      type: 'rawLine',
      pattern: /[ \t]+$/,
      filter: (match, lineText) => !/^\s*$/.test(lineText),
      maxPerFile: 5,
    },
    message: '行尾存在多余空白字符',
  },
  {
    id: 'STY006',
    title: '缩进混用制表符与空格',
    dimension: 'readability',
    severity: 'minor',
    languages: ['*'],
    description: '同一文件内混用 Tab 与空格缩进，在不同编辑器的制表位设置下会呈现出错乱的层级结构。',
    suggestion: '统一使用 2 个或 4 个空格缩进，并通过 .editorconfig 的 indent_style / indent_size 强制约束。',
    reference: 'EditorConfig · indent_style',
    scan: {
      type: 'custom',
      run(ctx) {
        const issues = [];
        let sawTab = false;
        let sawSpaceIndent = false;
        for (let i = 0; i < ctx.codeLines.length; i += 1) {
          const line = ctx.codeLines[i];
          const leading = (line.match(/^[ \t]*/) || [''])[0];
          if (!line.trim()) continue;
          if (leading.includes('\t')) {
            sawTab = true;
            if (!issues.some((item) => item.kind === 'tab')) {
              issues.push({ line: i + 1, column: 1, message: '本行使用制表符缩进', matchText: line.trim().slice(0, 60), kind: 'tab' });
            }
          } else if (leading.length > 0) {
            sawSpaceIndent = true;
          }
        }
        if (sawTab && sawSpaceIndent) return issues;
        return [];
      },
    },
    message: '缩进风格混用',
  },
  {
    id: 'MNT001',
    title: '函数体过长',
    dimension: 'maintainability',
    severity: 'major',
    languages: ['*'],
    description: '单个函数超过 80 行通常承担了多个职责，测试难以覆盖、复用性差，且合并冲突概率显著上升。',
    suggestion: '按「输入校验 → 核心逻辑 → 结果组装」拆分私有函数，每个函数保持单一职责（SRP），控制在 40 行以内。',
    reference: 'Robert C. Martin · 代码整洁之道',
    scan: {
      type: 'custom',
      run(ctx) {
        return ctx.metrics.longFunctions.map((fn) => ({
          line: fn.startLine,
          column: 1,
          message: `函数 ${fn.name} 共 ${fn.lines} 行，超过 80 行上限`,
          matchText: `function ${fn.name}`,
        }));
      },
    },
    message: '函数体过长',
  },
  {
    id: 'MNT002',
    title: '圈复杂度过高',
    dimension: 'maintainability',
    severity: 'major',
    languages: ['*'],
    description: '圈复杂度超过 15 的函数意味着至少 16 条独立路径，测试需要覆盖的组合数急剧增长，是缺陷密度最高的代码区域。',
    suggestion: '用卫语句（提前 return）消除深层条件分支；把多分支逻辑改为查表/策略映射；把嵌套条件拆分为具名布尔函数。',
    reference: 'Thomas McCabe · 圈复杂度（V(G) = 判定节点数 + 1）',
    scan: {
      type: 'custom',
      run(ctx) {
        return ctx.metrics.complexFunctions.map((fn) => ({
          line: fn.startLine,
          column: 1,
          message: `函数 ${fn.name} 圈复杂度为 ${fn.complexity}，超过阈值 15`,
          matchText: `function ${fn.name}`,
        }));
      },
    },
    message: '圈复杂度过高',
  },
  {
    id: 'MNT003',
    title: '嵌套层级过深',
    dimension: 'maintainability',
    severity: 'major',
    languages: ['*'],
    description: '嵌套深度超过 4 层时，阅读者需要在脑中同时维护多个条件上下文，理解成本呈组合式上升。',
    suggestion: '使用卫语句把异常路径前置返回；把内层循环体抽取为独立函数；用 early continue 替代 if 包裹整段循环体。',
    reference: 'Linux 内核编码风格 · 缩进不超过 3 层',
    scan: {
      type: 'custom',
      run(ctx) {
        if (ctx.metrics.maxNesting <= 4) return [];
        const hotspot = ctx.metrics.functions
          .filter((fn) => fn.nesting > 4)
          .map((fn) => ({
            line: fn.startLine,
            column: 1,
            message: `函数 ${fn.name} 嵌套深度为 ${fn.nesting}，超过 4 层上限`,
            matchText: `function ${fn.name}`,
          }));
        return hotspot;
      },
    },
    message: '嵌套层级过深',
  },
  {
    id: 'MNT004',
    title: '注释率不足',
    dimension: 'maintainability',
    severity: 'minor',
    languages: ['*'],
    description: '有效的注释用于解释「为什么这样做」而非「做了什么」。注释率过低会使后续维护者只能靠猜测理解设计意图。',
    suggestion: '为核心函数补充用途、参数、返回值与边界说明；对关键算法与业务规则补充设计动机；建议注释率保持在 10% 以上。',
    reference: '团队代码规范 · 注释覆盖率建议值',
    scan: {
      type: 'custom',
      run(ctx) {
        const { commentRatio, nonBlankLines } = ctx.metrics;
        if (nonBlankLines < 20) return [];
        if (commentRatio >= 0.1) return [];
        return [{
          line: 1,
          column: 1,
          message: `注释率仅 ${(commentRatio * 100).toFixed(1)}%（有效行 ${nonBlankLines}），低于 10% 的建议值`,
          matchText: '文件级指标',
        }];
      },
    },
    message: '注释率不足',
  },
  {
    id: 'MNT005',
    title: '函数参数过多',
    dimension: 'maintainability',
    severity: 'minor',
    languages: ['*'],
    description: '参数超过 5 个时，调用方极易传错顺序，且新增参数会破坏所有调用点。',
    suggestion: '改为传入配置对象（options），并在函数内解构并设置默认值；参数之间存在强耦合时应考虑封装为类。',
    reference: '整洁代码 · 参数对象模式',
    scan: {
      type: 'custom',
      run(ctx) {
        return ctx.metrics.manyParamFunctions.map((fn) => ({
          line: fn.startLine,
          column: 1,
          message: `函数 ${fn.name} 有 ${fn.params} 个参数，超过 5 个上限`,
          matchText: `function ${fn.name}`,
        }));
      },
    },
    message: '函数参数过多',
  },
  {
    id: 'MNT006',
    title: '单文件规模过大',
    dimension: 'maintainability',
    severity: 'minor',
    languages: ['*'],
    description: '单个源码文件超过 800 行通常意味着模块边界不清，加载成本、评审成本与冲突概率都会上升。',
    suggestion: '按职责拆分为多个模块（如 handlers / services / utils），并通过索引文件统一导出对外接口。',
    reference: 'Google Style Guide · 文件规模建议',
    scan: {
      type: 'custom',
      run(ctx) {
        if (ctx.metrics.totalLines <= 800) return [];
        return [{
          line: 1,
          column: 1,
          message: `文件共 ${ctx.metrics.totalLines} 行，超过 800 行的建议上限`,
          matchText: '文件级指标',
        }];
      },
    },
    message: '单文件规模过大',
  },
  {
    id: 'MNT007',
    title: '使用全局可变状态',
    dimension: 'maintainability',
    severity: 'minor',
    languages: ['*'],
    description: '在模块顶层声明可变的全局状态，会让任意位置都可能修改它，导致缺陷难以复现、单元测试相互污染。',
    suggestion: '把状态封装进类或工厂函数，通过依赖注入传递；必须共享时使用不可变数据结构与显式的读写接口。',
    reference: 'CWE-1108 过度使用全局变量',
    scan: {
      type: 'syntaxLine',
      patterns: [
        /^(?:var|let)\s+[A-Za-z_$][\w$]*\s*=\s*(?:\[\]|\{\}|\[\s*\w|\{\s*\w)/,
        /^global\.[A-Za-z_$][\w$]*\s*=/,
      ],
      maxPerFile: 4,
    },
    message: '顶层可变全局状态 {match}，建议封装为模块内部状态',
  },
  {
    id: 'MNT008',
    title: '连续多个空行',
    dimension: 'readability',
    severity: 'info',
    languages: ['*'],
    description: '连续超过 2 个空行会割裂代码块的视觉连续性，通常是剪切粘贴留下的痕迹。',
    suggestion: '统一保留 1 个空行分隔逻辑块，函数之间保留 1~2 个空行，并纳入格式化工具的约束范围。',
    reference: 'Prettier / Black 默认格式化规则',
    scan: {
      type: 'custom',
      run(ctx) {
        const issues = [];
        let run = 0;
        // 使用原始行：注释块在剥离注释后同样表现为空行，若基于 codeLines 判断会把连续注释误报为空行堆积
        const lines = ctx.originalLines;
        for (let i = 0; i < lines.length; i += 1) {
          if (!lines[i].trim()) {
            run += 1;
          } else {
            if (run >= 3) {
              issues.push({
                line: i - run + 1,
                column: 1,
                message: `存在 ${run} 个连续空行`,
                matchText: '连续空行',
              });
            }
            run = 0;
          }
        }
        return issues;
      },
    },
    message: '连续多个空行',
  },
];
